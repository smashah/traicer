import { Schema } from "effect";

import { BootstrapV1 } from "@traice/api-contract";
import { makeCaptureControl } from "@traice/effect-runtime";
import { openOperationalState } from "@traice/state-sqlite";

import { createControlApp } from "./app";
import { createCaptureRuntime } from "./runtime";
import { startForwardProxy } from "./forward-proxy";

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
  eventsAfter: state.eventsAfter,
  gatewayReady: () => runtime !== undefined,
  ...(runtime
    ? {
        abortMultipart: runtime.abortMultipart,
        commitDataset: runtime.commitDataset,
        deleteTrace: runtime.deleteTrace,
        onPause: runtime.pauseCapture,
        onResume: runtime.resumeCapture,
        proposeAgreement: runtime.proposeAgreement,
        prepareDelivery: runtime.prepareDelivery,
        workQueue: runtime.workQueue,
      }
    : {}),
  queueCounts: state.counts,
  traces: state.traces,
});

if (runtime) {
  await runtime.reconcile().catch(() => undefined);
  await runtime.cleanupExpiredDeliveries();
  await runtime.initialize();
}

const cleanupTimer = runtime
  ? setInterval(() => void runtime.cleanupExpiredDeliveries(), 60_000)
  : undefined;

const controlServer = Bun.serve({
  fetch: controlApp.fetch,
  hostname: "127.0.0.1",
  port: 0,
});
const gatewayServer = runtime
  ? Bun.serve({ fetch: runtime.gateway.fetch, hostname: "127.0.0.1", port: 0 })
  : undefined;
const forwardProxy = runtime && bootstrap.capture?.proxyTls
  ? await startForwardProxy({
      allowedPaths: bootstrap.capture.policy.allowedPaths,
      certificatePem: bootstrap.capture.proxyTls.certificatePem,
      gatewayFetch: runtime.gateway.fetch,
      onPinningFailure: () => state.recordEvent("proxy.pinning_detected", { captureSkipped: true }),
      privateKeyPem: bootstrap.capture.proxyTls.privateKeyPem,
      targetHosts: bootstrap.capture.proxyTls.targetHosts,
      token: bootstrap.capture.adapterCapability,
    })
  : undefined;

console.log(
  JSON.stringify({
    controlPort: controlServer.port,
    gatewayPort: gatewayServer?.port ?? null,
    proxyPort: forwardProxy?.port ?? null,
    pid: process.pid,
    protocolVersion: 1,
    type: "ready",
  })
);

const shutdown = async () => {
  if (cleanupTimer) clearInterval(cleanupTimer);
  controlServer.stop(true);
  gatewayServer?.stop(true);
  await forwardProxy?.close();
  await runtime?.scheduler.drain();
  state.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
