import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });

const cli = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  external: ["@opentui/core", "@opentui/react", "@opentui/react/*", "react", "react/*"],
  minify: true,
  naming: "cli.mjs",
  outdir: dist,
  target: "bun",
});
if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed");

const daemon = await Bun.build({
  entrypoints: [resolve(root, "../daemon/src/index.ts")],
  minify: true,
  naming: "daemon.mjs",
  outdir: dist,
  target: "bun",
});
if (!daemon.success) throw new AggregateError(daemon.logs, "Daemon build failed");

const cliOutput = cli.outputs[0];
if (!cliOutput) throw new Error("CLI build produced no output");
const cliPath = resolve(dist, "cli.mjs");
await chmod(cliPath, 0o755);
