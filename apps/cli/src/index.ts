#!/usr/bin/env bun
import { readdir, rm } from "node:fs/promises";
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
  requiredSecret,
  type StorageProvider,
  type TraicerConfig,
} from "./config";
import { locateDaemon } from "./daemon-locator";
import { createHarnessLaunch } from "./harness";
import { createProjectScopeResolver, parseProjectScopeId } from "./project-scope";
import {
  createScaffold,
  encryptWithVarlock,
  readExistingScaffold,
  type InitOptions,
  upgradeManagedInfrastructure,
  upgradeManagedSecretSchema,
  varlockCommand,
} from "./scaffold";

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

const deployInfrastructure = async (
  infrastructureDirectory: string,
  config: TraicerConfig
): Promise<void> => {
  if (await run(["pnpm", "install"], infrastructureDirectory) !== 0) process.exit(1);
  const alchemyEnvironment = config.storage.provider === "cloudflare-r2"
    ? {
        CLOUDFLARE_ACCOUNT_ID: parseCloudflareAccountId(
          new URL(config.storage.endpoint).hostname.split(".")[0] ?? ""
        ),
      }
    : undefined;

  const retryDelays = config.storage.provider === "cloudflare-r2" ? [2_000, 5_000] : [];
  for (let attempt = 0; ; attempt += 1) {
    if (await run(["pnpm", "alchemy", "deploy", "--yes"], infrastructureDirectory, alchemyEnvironment) === 0) {
      return;
    }
    const retryDelay = retryDelays[attempt];
    if (retryDelay === undefined) process.exit(1);
    console.log(
      `Alchemy deployment failed; Cloudflare initialization can be eventually consistent. Retrying in ${retryDelay / 1_000} seconds (${attempt + 2}/${retryDelays.length + 1})...`
    );
    await Bun.sleep(retryDelay);
  }
};

const cloudflareEnvironment = (config: TraicerConfig): Readonly<Record<string, string>> | undefined =>
  config.storage.provider === "cloudflare-r2"
    ? {
        CLOUDFLARE_ACCOUNT_ID: parseCloudflareAccountId(
          new URL(config.storage.endpoint).hostname.split(".")[0] ?? ""
        ),
      }
    : undefined;

const reset = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const existing = await readExistingScaffold(directory);
  if (!existing) {
    console.log(`Nothing to reset in ${directory}`);
    return;
  }
  if (!hasFlag("--yes")) {
    const confirmed = await choose(
      "Destroy the managed Traicer storage stack and remove its local configuration",
      ["yes", "no"] as const,
      "no"
    );
    if (confirmed !== "yes") {
      console.log("Reset cancelled");
      return;
    }
  }
  if (hasFlag("--state-store") && existing.config.storage.provider !== "cloudflare-r2") {
    throw new Error("--state-store is only supported for Cloudflare R2 storage");
  }

  if (existing.infrastructureDirectory) {
    await upgradeManagedInfrastructure(existing.infrastructureDirectory);
    if (await run(["pnpm", "install"], existing.infrastructureDirectory) !== 0) {
      throw new Error("Could not install the managed infrastructure dependencies");
    }
    const environment = cloudflareEnvironment(existing.config);
    if (await run(["pnpm", "alchemy", "destroy", "--yes"], existing.infrastructureDirectory, environment) !== 0) {
      throw new Error("Could not destroy the managed Traicer storage stack; local configuration was preserved");
    }
    if (
      hasFlag("--state-store")
      && await run(["pnpm", "alchemy", "cloudflare", "teardown"], existing.infrastructureDirectory, environment) !== 0
    ) {
      throw new Error("Could not tear down the Alchemy Cloudflare State Store; local configuration was preserved");
    }
  }

  const managedPaths = [
    "traicer.config.json",
    ".env.schema",
    ".env.local",
    ".runtime.json",
    "project-links.json",
    ".alchemy",
    "infra",
  ];
  const entries = await readdir(directory);
  for (const entry of entries) {
    if (entry.startsWith("traicer-state.db")) managedPaths.push(entry);
  }
  await Promise.all(managedPaths.map((path) => rm(resolve(directory, path), { force: true, recursive: true })));
  console.log(`Traicer reset complete in ${directory}`);
};

const initialize = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const existing = await readExistingScaffold(directory);
  if (existing) {
    await upgradeManagedSecretSchema(directory);
    console.log(`Traicer is already initialized in ${directory}`);
    if (!existing.infrastructureDirectory) {
      console.log("This configuration does not have a managed storage deployment.");
      return;
    }
    const deploy = hasFlag("--deploy") || (
      !hasFlag("--yes")
      && await choose("Resume storage deployment", ["yes", "no"] as const, "no") === "yes"
    );
    if (!deploy) {
      console.log(`Resume with: traicer init --directory ${JSON.stringify(directory)} --deploy`);
      return;
    }
    console.log(`Resuming storage deployment in ${existing.infrastructureDirectory}`);
    await upgradeManagedInfrastructure(existing.infrastructureDirectory);
    await deployInfrastructure(existing.infrastructureDirectory, existing.config);
    return;
  }

  const storage = (flag("--storage") ?? await choose(
    "Storage provider",
    ["cloudflare-r2", "aws-s3", "existing-s3"] as const,
    "cloudflare-r2"
  )) as StorageProvider;
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
      await deployInfrastructure(result.infrastructureDirectory, result.config);
    }
  }
  console.log(`Add the S3 credentials and, if available, the marketplace credential to .env.local, then run: traicer secrets --directory ${JSON.stringify(directory)}`);
  console.log(`Start capture with: traicer start --directory ${JSON.stringify(directory)}`);
};

const encryptSecrets = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  await upgradeManagedSecretSchema(directory);
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
  await upgradeManagedSecretSchema(directory);
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
  ], import.meta.dir);
  process.exitCode = code;
};

const help = () => console.log(`Traicer ${packageJson.version}\n\nUsage:\n  traicer init [--storage cloudflare-r2|aws-s3|existing-s3] [options]\n  traicer reset [--directory <path>] [--yes] [--state-store]\n  traicer secrets [--directory <path>]\n  traicer start [--directory <path>]\n\nInit options:\n  --account-id <id>       Cloudflare account ID for R2\n  --bucket <name>         Bucket name (required for existing S3)\n  --deploy                Confirm and run the Alchemy deployment\n  --directory <path>      Config directory (default: ~/.config/traicer)\n  --endpoint <url>        Existing S3-compatible endpoint\n  --marketplace-url <url> Traice Market API base URL\n  --region <region>       AWS/signing region (default: us-east-1)\n  --yes                   Accept safe defaults; never implies --deploy\n\nReset options:\n  --state-store           Also remove Alchemy's account-level Cloudflare state store\n  --yes                   Confirm destruction without prompting\n\nTraicer generates Anthropic and OpenAI route configuration over one seller-owned storage bucket.\n`);

const withResolvedSecrets = async (internalCommand: "__project" | "__run") => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  await upgradeManagedSecretSchema(directory);
  process.exitCode = await run([
    ...varlockCommand("run"), "--path", directory, "--inject", "vars", "--",
    process.execPath, import.meta.path, internalCommand, ...args.slice(1),
  ], process.cwd());
};

const projectResolved = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const resolver = createProjectScopeResolver({ directory, mappingKey: requiredSecret("TRAICER_PROJECT_MAPPING_KEY") });
  const action = args[1] ?? "status";
  if (action === "link") {
    const projectScopeId = parseProjectScopeId(flag("--scope-id") ?? crypto.randomUUID());
    await resolver.link(process.cwd(), projectScopeId);
    console.log(`Linked this repository to project scope ${projectScopeId}`);
    return;
  }
  if (action === "unlink") {
    console.log(await resolver.unlink(process.cwd()) ? "Unlinked this repository" : "This repository wasn't linked");
    return;
  }
  if (action === "status") {
    const result = await resolver.resolve(process.cwd());
    console.log(result.kind === "linked" ? `Linked to project scope ${result.projectScopeId}` : `Project status: ${result.kind}`);
    return;
  }
  throw new Error(`Unknown project command: ${action}`);
};

const runResolved = async () => {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error("Pass a harness command after `traicer run --`");
  const commandArgs = args.slice(separator + 1);
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const project = await createProjectScopeResolver({ directory, mappingKey: requiredSecret("TRAICER_PROJECT_MAPPING_KEY") }).resolve(process.cwd());
  if (project.kind !== "linked") throw new Error(`This repository isn't linked (${project.kind}); run \`traicer project link\` first`);
  const controlToken = requiredSecret("TRAICER_CONTROL_TOKEN");
  const daemon = await locateDaemon(directory, controlToken);
  const provisional = createHarnessLaunch(commandArgs, { anthropic: "", openai: "" });
  const routeId = crypto.randomUUID();
  try {
    const routeResponse = await fetch(`${daemon.controlBaseUrl}/v1/capture-routes`, {
      body: JSON.stringify({
        captureRunId: crypto.randomUUID(), client: provisional.client,
        projectScopeId: project.projectScopeId, providers: provisional.providers,
        routeId, ttlSeconds: 43_200,
      }),
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      method: "POST",
    });
    if (!routeResponse.ok) throw new Error("Traicer couldn't create a scoped capture route");
    const issued = await routeResponse.json() as { readonly data?: { readonly routeId?: unknown; readonly routeToken?: unknown } };
    if (issued.data?.routeId !== routeId || typeof issued.data.routeToken !== "string") throw new Error("Traicer returned an invalid scoped capture route");
    const launch = createHarnessLaunch(commandArgs, {
      anthropic: `${daemon.gatewayBaseUrl}/anthropic/${issued.data.routeToken}`,
      openai: `${daemon.gatewayBaseUrl}/openai/${issued.data.routeToken}/v1`,
    });
    const child = Bun.spawn([...launch.args], { cwd: process.cwd(), env: launch.environment, stderr: "inherit", stdin: "inherit", stdout: "inherit" });
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTermination = () => child.kill("SIGTERM");
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTermination);
    try {
      process.exitCode = await child.exited;
    } finally {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTermination);
    }
  } finally {
    const revoked = await fetch(`${daemon.controlBaseUrl}/v1/capture-routes/${routeId}`, {
      headers: { authorization: `Bearer ${controlToken}` }, method: "DELETE",
    }).catch(() => undefined);
    if (!revoked?.ok) {
      console.error("Traicer couldn't revoke the capture route; stop the daemon to invalidate it immediately");
    }
  }
};

try {
  if (command === "init") await initialize();
  else if (command === "reset") await reset();
  else if (command === "project") await withResolvedSecrets("__project");
  else if (command === "run") await withResolvedSecrets("__run");
  else if (command === "secrets") await encryptSecrets();
  else if (command === "start") await start();
  else if (command === "__start") await startResolved();
  else if (command === "__project") await projectResolved();
  else if (command === "__run") await runResolved();
  else if (command === "--version" || command === "-v") console.log(packageJson.version);
  else if (!command || command === "--help" || command === "-h") {
    help();
    console.log("Project capture:\n  traicer project link|status|unlink [--scope-id <uuid>]\n  traicer run [--directory <path>] -- claude|codex|opencode [args]");
  }
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Traicer failed");
  process.exitCode = 1;
}
