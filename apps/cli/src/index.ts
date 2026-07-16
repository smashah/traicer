#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import packageJson from "../package.json" with { type: "json" };

import {
  discoverWranglerIdentity,
  parseCloudflareAccountId,
  type CloudflareAccountId,
} from "./cloudflare";
import {
  createBootstrap,
  daemonEnvironment,
  readTraicerConfig,
  type Provider,
  type StorageProvider,
} from "./config";
import { createScaffold, encryptWithVarlock, type InitOptions, varlockCommand } from "./scaffold";

const args = process.argv.slice(2);
const command = args[0];

const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);
const defaultDirectory = resolve(homedir(), ".config", "traicer");

const run = async (
  commandArgs: string[],
  cwd?: string,
  environment?: Readonly<Record<string, string>>
): Promise<number> => {
  const child = Bun.spawn(commandArgs, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  return child.exited;
};

const choose = async <T extends string>(question: string, values: readonly T[], fallback: T): Promise<T> => {
  if (hasFlag("--yes")) return fallback;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await input.question(`${question} (${values.join("/")}) [${fallback}]: `)).trim();
  input.close();
  if (!answer) return fallback;
  if (!values.includes(answer as T)) throw new Error(`Expected one of: ${values.join(", ")}`);
  return answer as T;
};

const ask = async (question: string, fallback?: string): Promise<string> => {
  if (hasFlag("--yes")) return fallback ?? "";
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = fallback === undefined ? ": " : ` [${fallback}]: `;
  const answer = (await input.question(`${question}${suffix}`)).trim();
  input.close();
  return answer || fallback || "";
};

const chooseCloudflareAccount = async (): Promise<CloudflareAccountId> => {
  const discovery = await discoverWranglerIdentity();
  if (discovery.status === "authenticated") {
    const { accounts, email } = discovery.identity;
    if (email) console.log(`Wrangler is authenticated as ${email}`);
    if (accounts.length === 1) {
      const account = accounts[0]!;
      console.log(`Using Cloudflare account ${account.name} (${account.id})`);
      return account.id;
    }
    if (accounts.length > 1) {
      if (hasFlag("--yes")) {
        throw new Error("Wrangler found multiple Cloudflare accounts; pass --account-id to choose one with --yes");
      }
      console.log("Choose the Cloudflare account for Traicer storage:");
      accounts.forEach((account, index) => {
        console.log(`  ${index + 1}. ${account.name} (${account.id})`);
      });
      const answer = await ask("Cloudflare account number");
      const selectedIndex = Number(answer) - 1;
      const account = Number.isInteger(selectedIndex) ? accounts[selectedIndex] : undefined;
      if (!account) throw new Error(`Expected an account number from 1 to ${accounts.length}`);
      return account.id;
    }
    console.log("Wrangler returned no accessible Cloudflare accounts; enter the account ID manually.");
  } else if (discovery.status === "unavailable") {
    console.log("Wrangler was not found; enter the Cloudflare account ID manually.");
  } else if (discovery.status === "unauthenticated") {
    console.log("Wrangler is not authenticated; run 'wrangler login' to enable account selection, or enter the account ID manually.");
  } else {
    console.log("Wrangler account discovery failed; enter the Cloudflare account ID manually.");
  }

  return parseCloudflareAccountId(await ask("Cloudflare account ID"));
};

const initialize = async () => {
  const storage = (flag("--storage") ?? await choose(
    "Storage provider",
    ["cloudflare-r2", "aws-s3", "existing-s3"] as const,
    "cloudflare-r2"
  )) as StorageProvider;
  const suppliedProvider = flag("--provider");
  if (!suppliedProvider && !hasFlag("--yes")) {
    console.log("Traicer configures one capture adapter per configuration because each AI provider uses different request paths and upstream routing. Your coding client keeps its existing provider credentials.");
  }
  const provider = (suppliedProvider ?? await choose(
    "AI capture adapter",
    ["anthropic", "openai"] as const,
    "anthropic"
  )) as Provider;
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const suppliedAccountId = flag("--account-id");
  const accountId = (suppliedAccountId === undefined ? undefined : parseCloudflareAccountId(suppliedAccountId)) ?? (
    storage === "cloudflare-r2" ? await chooseCloudflareAccount() : undefined
  );
  const bucket = flag("--bucket") ?? (
    storage === "existing-s3" ? await ask("Existing bucket name") : undefined
  );
  const endpoint = flag("--endpoint") ?? (
    storage === "existing-s3" ? await ask("S3-compatible endpoint URL") : undefined
  );
  const region = flag("--region") ?? (
    storage === "cloudflare-r2" ? "auto" : await ask("S3 signing region", "us-east-1")
  );
  const marketplaceApiBaseUrl = flag("--marketplace-url") ?? await ask(
    "Traice Market API base URL",
    "https://api.traice.market"
  );
  const options: InitOptions = {
    ...(accountId === undefined ? {} : { accountId }),
    ...(bucket === undefined ? {} : { bucket }),
    directory,
    ...(endpoint === undefined ? {} : { endpoint }),
    marketplaceApiBaseUrl,
    provider,
    region,
    storage,
  };
  if (storage === "cloudflare-r2" && !options.accountId) {
    throw new Error("Pass the public Cloudflare account ID with --account-id");
  }
  const result = await createScaffold(options, { encryptSecret: encryptWithVarlock });
  console.log(`Traicer configuration created in ${directory}`);
  console.log(`Device ${result.config.device.id} uses signing key ${result.config.device.signerKeyId}`);
  if (result.infrastructureDirectory) {
    console.log(`Alchemy v2 storage stack created in ${result.infrastructureDirectory}`);
    const deploy = hasFlag("--deploy") || (!hasFlag("--yes") && await choose("Deploy storage now", ["yes", "no"] as const, "no") === "yes");
    if (deploy) {
      if (await run(["pnpm", "install"], result.infrastructureDirectory) !== 0) process.exit(1);
      const alchemyEnvironment = storage === "cloudflare-r2" && options.accountId
        ? { CLOUDFLARE_ACCOUNT_ID: options.accountId }
        : undefined;
      if (await run(["pnpm", "alchemy", "deploy"], result.infrastructureDirectory, alchemyEnvironment) !== 0) process.exit(1);
    }
  }
  console.log(`Add the marketplace and S3 credentials to .env.local, then run: traicer secrets --directory ${JSON.stringify(directory)}`);
  console.log(`Start capture with: traicer start --directory ${JSON.stringify(directory)}`);
};

const encryptSecrets = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  process.exitCode = await run(varlockCommand("encrypt", "--file", resolve(directory, ".env.local")), directory);
};

const startResolved = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const bootstrap = createBootstrap(await readTraicerConfig(directory));
  const daemonPath = resolve(import.meta.dir, "daemon.mjs");
  const child = Bun.spawn([process.execPath, daemonPath], {
    cwd: directory,
    env: daemonEnvironment(process.env),
    stderr: "inherit",
    stdin: "pipe",
    stdout: "inherit",
  });
  child.stdin.write(JSON.stringify(bootstrap));
  child.stdin.end();
  process.exitCode = await child.exited;
};

const start = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const code = await run([
    ...varlockCommand("run"),
    "--path",
    directory,
    "--inject",
    "vars",
    "--",
    process.execPath,
    import.meta.path,
    "__start",
    "--directory",
    directory,
  ], directory);
  process.exitCode = code;
};

const help = () => console.log(`Traicer ${packageJson.version}\n\nUsage:\n  traicer init [--storage cloudflare-r2|aws-s3|existing-s3] [options]\n  traicer secrets [--directory <path>]\n  traicer start [--directory <path>]\n\nInit options:\n  --account-id <id>       Cloudflare account ID for R2\n  --bucket <name>         Bucket name (required for existing S3)\n  --deploy                Confirm and run the Alchemy deployment\n  --directory <path>      Config directory (default: ~/.config/traicer)\n  --endpoint <url>        Existing S3-compatible endpoint\n  --marketplace-url <url> Traice Market API base URL\n  --provider <name>       Capture adapter and upstream routing: anthropic or openai\n  --region <region>       AWS/signing region (default: us-east-1)\n  --yes                   Accept safe defaults; never implies --deploy\n\nTraicer configures one AI capture adapter per configuration. Your coding client keeps its existing provider credentials.\n`);

try {
  if (command === "init") await initialize();
  else if (command === "secrets") await encryptSecrets();
  else if (command === "start") await start();
  else if (command === "__start") await startResolved();
  else if (command === "--version" || command === "-v") console.log(packageJson.version);
  else if (!command || command === "--help" || command === "-h") help();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Traicer failed");
  process.exitCode = 1;
}
