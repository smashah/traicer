import { Schema } from "effect";

import { BootstrapV1 } from "@traice/api-contract";
import { makeCaptureControl } from "@traice/effect-runtime";
import { openOperationalState } from "@traice/state-sqlite";

import { createControlApp } from "./app";
import { createCaptureRuntime } from "./runtime";

const readBootstrap = async () => {
  const text = (await Bun.stdin.text()).trim();
  return Schema.decodeUnknownSync(BootstrapV1)(JSON.parse(text));
};

const bootstrap = await readBootstrap();
const state = openOperationalState("traicer-state.db");
const control = makeCaptureControl("healthy");
const runtime = bootstrap.capture
  ? createCaptureRuntime(bootstrap.capture, bootstrap.vaultKey, state)
  : undefined;
const controlApp = createControlApp({
  control,
  controlToken: bootstrap.controlToken,
  databaseReady: state.integrityCheck,
  gatewayReady: () => runtime !== undefined,
  ...(runtime
    ? { onPause: runtime.pauseCapture, onResume: runtime.resumeCapture }
    : {}),
  queueCounts: state.counts,
});

if (runtime) {
  await runtime.reconcile().catch(() => undefined);
}

const controlServer = Bun.serve({
  fetch: controlApp.fetch,
  hostname: "127.0.0.1",
  port: 0,
});
const gatewayServer = runtime
  ? Bun.serve({ fetch: runtime.gateway.fetch, hostname: "127.0.0.1", port: 0 })
  : undefined;

console.log(
  JSON.stringify({
    controlPort: controlServer.port,
    gatewayPort: gatewayServer?.port ?? null,
    pid: process.pid,
    protocolVersion: 1,
    type: "ready",
  })
);

const shutdown = async () => {
  controlServer.stop(true);
  gatewayServer?.stop(true);
  await runtime?.scheduler.drain();
  state.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
