import { Schema } from "effect";

import { Bootstrap } from "@traice/api-contract";
import { makeCaptureControl } from "@traice/effect-runtime";
import { openOperationalState } from "@traice/state-sqlite";

import { createControlApp } from "./app";
import { createCaptureRouteRegistry } from "./capture-routes";
import { createCaptureRuntime } from "./runtime";
import { startForwardProxy } from "./forward-proxy";
import { removeRuntimeDescriptor, writeRuntimeDescriptor } from "./runtime-descriptor";

const readBootstrap = async () => {
  const text = (await Bun.stdin.text()).trim();
  return Schema.decodeUnknownSync(Bootstrap)(JSON.parse(text));
};

const bootstrap = await readBootstrap();
const state = openOperationalState("traicer-state.db");
const control = makeCaptureControl("healthy");
const instanceId = crypto.randomUUID();
const captureRoutes = createCaptureRouteRegistry();
const runtime = bootstrap.capture
  ? createCaptureRuntime(bootstrap.capture, bootstrap.vaultKey, state, {
      resolveRoute: captureRoutes.resolve,
    })
  : undefined;
const controlApp = createControlApp({
  control,
  controlToken: bootstrap.controlToken,
  databaseReady: state.integrityCheck,
  eventsAfter: state.eventsAfter,
  gatewayReady: () => runtime !== undefined,
  issueCaptureRoute: captureRoutes.issue,
  instanceId,
  revokeCaptureRoute: captureRoutes.revoke,
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
  protocolVersion: bootstrap.protocolVersion,
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
const legacyCapture = bootstrap.capture && "proxyTls" in bootstrap.capture ? bootstrap.capture : undefined;
const forwardProxy = runtime && legacyCapture?.proxyTls
  ? await startForwardProxy({
      allowedPaths: legacyCapture.policy.allowedPaths,
      certificatePem: legacyCapture.proxyTls.certificatePem,
      gatewayFetch: runtime.gateway.fetch,
      onPinningFailure: () => state.recordEvent("proxy.pinning_detected", { captureSkipped: true }),
      privateKeyPem: legacyCapture.proxyTls.privateKeyPem,
      targetHosts: legacyCapture.proxyTls.targetHosts,
      token: legacyCapture.adapterCapability,
    })
  : undefined;

if (gatewayServer) {
  await writeRuntimeDescriptor(process.cwd(), {
    controlPort: controlServer.port!,
    gatewayPort: gatewayServer.port!,
    instanceId,
    pid: process.pid,
    protocolVersion: bootstrap.protocolVersion,
    schema: "traicer.runtime/1",
  });
}

console.log(
  JSON.stringify({
    controlPort: controlServer.port,
    gatewayPort: gatewayServer?.port ?? null,
    proxyPort: forwardProxy?.port ?? null,
    pid: process.pid,
    protocolVersion: bootstrap.protocolVersion,
    type: "ready",
  })
);

const shutdown = async () => {
  if (cleanupTimer) clearInterval(cleanupTimer);
  controlServer.stop(true);
  gatewayServer?.stop(true);
  await forwardProxy?.close();
  await runtime?.scheduler.drain();
  await removeRuntimeDescriptor(process.cwd(), instanceId).catch(() => undefined);
  state.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
