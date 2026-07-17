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
import {
  locateDaemon,
  removeUnreachableRuntimeDescriptor,
  runtimeDescriptorExists,
} from "./daemon-locator";
import { createHarnessLaunch } from "./harness";
import { waitForDaemonReady, waitForDaemonStop } from "./lifecycle";
import { createLocalOwnerAccess, parseTraceFilters } from "./local-owner-access";
import {
  formatCanonicalTrace,
  formatTraceList,
  type TraceExportFormat,
  writeTraceExport,
} from "./owner-access";
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
import {
  createServiceClient,
  formatInstructions,
  formatProviderUrls,
  formatServiceStatus,
} from "./service-commands";

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
  if (await Bun.file(resolve(directory, ".runtime.json")).exists()) {
    throw new Error(`Traicer may still be running; run \`traicer stop --directory ${JSON.stringify(directory)}\` before reset`);
  }
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
    "cache",
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
  console.log(`Start capture in the background with: traicer start --detach --directory ${JSON.stringify(directory)}`);
  console.log("Initialization does not start a proxy or background service on its own.");
};

const encryptSecrets = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  await upgradeManagedSecretSchema(directory);
  process.exitCode = await run(varlockCommand("encrypt", "--file", resolve(directory, ".env.local")), directory);
};

const startResolved = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const bootstrap = createBootstrap(await readTraicerConfig(directory));
  if (hasFlag("--detach")) {
    const existing = await locateDaemon(directory, bootstrap.controlToken).catch(() => undefined);
    if (existing) {
      console.log(`Traicer is already running${existing.pid ? ` as pid ${existing.pid}` : ""}`);
      return;
    }
  }
  const daemonPath = resolve(import.meta.dir, "daemon.mjs");
  const child = Bun.spawn([process.execPath, daemonPath], {
    cwd: directory,
    env: daemonEnvironment(process.env),
    stderr: hasFlag("--detach") ? "ignore" : "inherit",
    stdin: "pipe",
    stdout: hasFlag("--detach") ? "pipe" : "inherit",
  });
  child.stdin.write(JSON.stringify(bootstrap));
  child.stdin.end();
  if (hasFlag("--detach")) {
    if (!(child.stdout instanceof ReadableStream)) {
      child.kill();
      throw new Error("Traicer could not observe daemon readiness");
    }
    try {
      const ready = await waitForDaemonReady(child.stdout);
      child.unref();
      console.log(`Traicer started in the background as pid ${ready.pid}`);
      console.log(`Run \`traicer status --directory ${JSON.stringify(directory)}\` for safe runtime details.`);
      return;
    } catch (error) {
      child.kill();
      await child.exited.catch(() => undefined);
      throw error;
    }
  }
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
    ...(hasFlag("--detach") ? ["--detach"] : []),
  ], import.meta.dir);
  process.exitCode = code;
};

const stopResolved = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const controlToken = requiredSecret("TRAICER_CONTROL_TOKEN");
  const daemon = await locateDaemon(directory, controlToken).catch(() => undefined);
  if (!daemon) {
    const removed = await removeUnreachableRuntimeDescriptor(directory, controlToken);
    console.log(removed ? "Traicer is not running; removed its stale runtime descriptor" : "Traicer is not running");
    return;
  }
  const response = await fetch(`${daemon.controlBaseUrl}/v1/control/shutdown`, {
    headers: { authorization: `Bearer ${controlToken}` },
    method: "POST",
  });
  if (response.status !== 202) throw new Error("Traicer refused the authenticated shutdown request");
  await waitForDaemonStop(async () => {
    const health = await fetch(`${daemon.controlBaseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${controlToken}` },
    }).catch(() => undefined);
    return !health?.ok && !await runtimeDescriptorExists(directory);
  });
  console.log("Traicer stopped");
};

const help = () => console.log(`Traicer ${packageJson.version}\n\nUsage:\n  traicer init [--storage cloudflare-r2|aws-s3|existing-s3] [options]\n  traicer reset [--directory <path>] [--yes] [--state-store]\n  traicer secrets [--directory <path>]\n  traicer start [--directory <path>] [--detach]\n  traicer stop [--directory <path>]\n  traicer traces list [--limit <count>] [--offset <count>] [--json]\n  traicer traces show <trace-id|object-key> [--json]\n  traicer traces export <trace-id|object-key> --output <path> [--force]\n  traicer traces cache status|clear [--json]\n  traicer explore\n  traicer status [--json]\n  traicer urls [--reveal] [--json]\n  traicer instructions [--reveal] [--json]\n\nInit options:\n  --account-id <id>       Cloudflare account ID for R2\n  --bucket <name>         Bucket name (required for existing S3)\n  --deploy                Confirm and run the Alchemy deployment\n  --directory <path>      Config directory (default: ~/.config/traicer)\n  --endpoint <url>        Existing S3-compatible endpoint\n  --marketplace-url <url> Traice Market API base URL\n  --region <region>       AWS/signing region (default: us-east-1)\n  --yes                   Accept safe defaults; never implies --deploy\n\nReset options:\n  --state-store           Also remove Alchemy's account-level Cloudflare state store\n  --yes                   Confirm destruction without prompting\n\nTraicer generates Anthropic and OpenAI route configuration over one seller-owned storage bucket.\n`);

const withResolvedSecrets = async (
  internalCommand: "__explore" | "__project" | "__run" | "__service" | "__stop" | "__traces",
  forwardedArgs = args.slice(1)
) => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  await upgradeManagedSecretSchema(directory);
  process.exitCode = await run([
    ...varlockCommand("run"), "--path", directory, "--inject", "vars", "--",
    process.execPath, import.meta.path, internalCommand, ...forwardedArgs,
  ], process.cwd());
};

const exploreResolved = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Traices Explorer requires an interactive terminal");
  }
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const client = await createLocalOwnerAccess(directory);
  try {
    const { launchExplorer } = await import("./explorer");
    await launchExplorer(client, async (traceId, trace) =>
      writeTraceExport(resolve(process.cwd(), `${traceId}.json`), trace)
    );
  } finally {
    client.close();
  }
};

const serviceResolved = async () => {
  const action = args[1];
  if (action !== "status" && action !== "urls" && action !== "instructions") {
    throw new Error("Unknown service discovery command");
  }
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const controlToken = requiredSecret("TRAICER_CONTROL_TOKEN");
  let daemon;
  try {
    daemon = await locateDaemon(directory, controlToken);
  } catch (error) {
    if (action === "status") {
      const stopped = {
        running: false,
        state: error instanceof Error ? error.message : "Traicer is not running",
      };
      console.log(hasFlag("--json") ? JSON.stringify(stopped, null, 2) : `Daemon: stopped\n${stopped.state}`);
      return;
    }
    throw new Error("Traicer is not running; start it with `traicer start --detach`, then retry this command");
  }
  const service = createServiceClient({ connection: daemon, controlToken });
  if (action === "status") {
    const status = await service.status();
    console.log(hasFlag("--json") ? JSON.stringify(status, null, 2) : formatServiceStatus(status));
    return;
  }
  if (!hasFlag("--reveal")) {
    if (action === "instructions") {
      console.log(hasFlag("--json")
        ? JSON.stringify({ commands: [
            "traicer project link",
            "traicer run -- claude",
            "traicer run -- codex",
            "traicer run -- opencode",
          ] }, null, 2)
        : formatInstructions());
      return;
    }
    const safe = {
      gateway: daemon.gatewayBaseUrl,
      message: "Provider URLs require a short-lived project route. Re-run with --reveal to print bearer capabilities.",
      proxy: daemon.proxyBaseUrl ?? null,
    };
    console.log(hasFlag("--json")
      ? JSON.stringify(safe, null, 2)
      : [`Gateway: ${safe.gateway}`, ...(safe.proxy ? [`Explicit TLS proxy: ${safe.proxy}`] : []), safe.message].join("\n"));
    return;
  }
  const project = await createProjectScopeResolver({
    directory,
    mappingKey: requiredSecret("TRAICER_PROJECT_MAPPING_KEY"),
  }).resolve(process.cwd());
  if (project.kind !== "linked") {
    throw new Error(`This repository isn't linked (${project.kind}); run \`traicer project link\` first`);
  }
  const urls = await service.urls(project.projectScopeId);
  if (action === "instructions") {
    console.log(hasFlag("--json") ? JSON.stringify({ instructions: formatInstructions(urls), urls }, null, 2) : formatInstructions(urls));
  } else {
    console.log(hasFlag("--json") ? JSON.stringify(urls, null, 2) : formatProviderUrls(urls));
  }
};

const tracesResolved = async () => {
  const directory = resolve(flag("--directory") ?? defaultDirectory);
  const client = await createLocalOwnerAccess(directory);
  try {
  const action = args[1] ?? "list";
  if (action === "list") {
    const filters = parseTraceFilters({
      ...(flag("--client") ? { client: flag("--client") } : {}),
      ...(flag("--limit") ? { limit: flag("--limit") } : {}),
      ...(flag("--offset") ? { offset: flag("--offset") } : {}),
      ...(flag("--provider") ? { provider: flag("--provider") } : {}),
      ...(flag("--since") ? { since: flag("--since") } : {}),
      ...(flag("--state") ? { state: flag("--state") } : {}),
    });
    const traces = await client.list(filters);
    console.log(hasFlag("--json")
      ? JSON.stringify({ schema: "traicer.trace-inventory/1", traces }, null, 2)
      : formatTraceList(traces));
    return;
  }
  if (action === "cache") {
    const cacheAction = args[2] ?? "status";
    if (cacheAction === "status") {
      const status = await client.cacheStats();
      console.log(hasFlag("--json")
        ? JSON.stringify(status, null, 2)
        : `Plaintext cache: ${status.entries} entries, ${status.bytes} compressed bytes, ${status.maxAgeDays}-day maximum age`);
      return;
    }
    if (cacheAction === "clear") {
      const cleared = await client.clearCache();
      console.log(`Removed ${cleared.removed} plaintext cache ${cleared.removed === 1 ? "entry" : "entries"}`);
      return;
    }
    throw new Error(`Unknown traces cache command: ${cacheAction}`);
  }
  const selectors = args.slice(2, args.findIndex((value, index) => index >= 2 && value.startsWith("--")) < 0
    ? args.length
    : args.findIndex((value, index) => index >= 2 && value.startsWith("--")));
  const selector = selectors[0];
  if (!selector) {
    throw new Error(`Pass a trace ID or configured object key to \`traicer traces ${action}\``);
  }
  if (action === "show" && selectors.length !== 1) throw new Error("traces show accepts exactly one selector");
  if (action !== "show" && action !== "export") throw new Error(`Unknown traces command: ${action}`);
  if (selectors.length > 100) throw new Error("A single export is limited to 100 traces");
  if (action === "show") {
    if (!process.stdout.isTTY && !hasFlag("--stdout")) {
      throw new Error("Refusing to write plaintext to a non-interactive output; pass --stdout deliberately");
    }
    if (process.stdout.isTTY) {
      console.error("This reveals decrypted prompts, responses, and source fragments in terminal scrollback.");
      if ((await ask("Type reveal to continue")) !== "reveal") {
        console.log("Reveal cancelled");
        return;
      }
    }
  }
  const output = action === "export" ? flag("--output") : undefined;
  if (action === "export" && !output) {
    throw new Error("Pass --output <path> for an explicit plaintext export destination");
  }
  const format = (flag("--format") ?? "json") as TraceExportFormat;
  if (action === "export" && !(["json", "jsonl", "markdown"] as const).includes(format)) {
    throw new Error("--format must be json, jsonl, or markdown");
  }
  if (action === "export") console.error("Warning: the export contains sensitive decrypted plaintext.");
  const readOne = async (selected: string) => client.read(selected, (event) => {
    if (!process.stderr.isTTY) return;
    const progress = event.totalBytes && event.completedBytes !== undefined
      ? ` ${Math.min(100, Math.round(event.completedBytes / event.totalBytes * 100))}%`
      : "";
    process.stderr.write(`\r${event.phase}${progress}`.padEnd(32));
  }).catch(() => {
    throw new Error("The selected trace could not be read safely");
  });
  const result = await readOne(selector);
  if (process.stderr.isTTY) process.stderr.write("\r".padEnd(32) + "\r");
  if (action === "show") {
    console.log(hasFlag("--json") ? JSON.stringify(result.trace, null, 2) : formatCanonicalTrace(result.trace));
    return;
  }
  if (action === "export") {
    const maximumPlaintextBytes = 64 * 1024 * 1024;
    const results = [result];
    let plaintextBytes = Buffer.byteLength(JSON.stringify(result.trace));
    if (plaintextBytes > maximumPlaintextBytes) {
      throw new Error("A single plaintext export is limited to 64 MiB");
    }
    for (const selected of selectors.slice(1)) {
      const next = await readOne(selected);
      plaintextBytes += Buffer.byteLength(JSON.stringify(next.trace));
      if (plaintextBytes > maximumPlaintextBytes) {
        throw new Error("A single plaintext export is limited to 64 MiB");
      }
      results.push(next);
    }
    const destination = await writeTraceExport(output!, results.map((entry) => entry.trace), {
      force: hasFlag("--force"),
      format,
    });
    console.log(`${process.platform === "win32" ? "Plaintext trace exported" : "Plaintext trace exported with owner-only permissions"} to ${destination}`);
    return;
  }
  } finally {
    client.close();
  }
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
  else if (command === "status" || command === "urls" || command === "instructions") {
    await withResolvedSecrets("__service", args);
  }
  else if (command === "traces") await withResolvedSecrets("__traces");
  else if (command === "explore") await withResolvedSecrets("__explore");
  else if (command === "secrets") await encryptSecrets();
  else if (command === "start") await start();
  else if (command === "stop") await withResolvedSecrets("__stop");
  else if (command === "__start") await startResolved();
  else if (command === "__stop") await stopResolved();
  else if (command === "__project") await projectResolved();
  else if (command === "__run") await runResolved();
  else if (command === "__service") await serviceResolved();
  else if (command === "__traces") await tracesResolved();
  else if (command === "__explore") await exploreResolved();
  else if (command === "__opentui-smoke") {
    const explorer = await import("./explorer");
    await explorer.smokeExplorerRenderer();
    console.log("OpenTUI explorer renderer initialized");
  }
  else if (command === "--version" || command === "-v") console.log(packageJson.version);
  else if (!command || command === "--help" || command === "-h") {
    help();
    console.log("Owner trace access:\n  traicer traces list [--provider <name>] [--client <name>] [--state <state>] [--since <time>] [--limit <count>] [--offset <count>] [--json]\n  traicer traces show <trace-id|object-key|ciphertext-hash> [--json] [--stdout]\n  traicer traces export <selector...> --output <path> [--format json|jsonl|markdown] [--force]\n\nProject capture:\n  traicer project link|status|unlink [--scope-id <uuid>]\n  traicer run [--directory <path>] -- claude|codex|opencode [args]");
  }
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Traicer failed");
  process.exitCode = 1;
}
