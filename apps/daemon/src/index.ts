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

const cacheMaxBytes = (() => {
  const value = process.env.TRAICER_PLAINTEXT_CACHE_MAX_BYTES;
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Plaintext cache size limit is invalid");
  }
  return parsed;
})();
const state = openOperationalState("traicer-state.db");
const control = makeCaptureControl("healthy");
const instanceId = crypto.randomUUID();
const captureRoutes = createCaptureRouteRegistry();
const runtime = bootstrap.capture
  ? createCaptureRuntime(bootstrap.capture, bootstrap.vaultKey, state, {
      ...(process.env.TRAICER_PLAINTEXT_CACHE_DIRECTORY
        ? { cacheDirectory: process.env.TRAICER_PLAINTEXT_CACHE_DIRECTORY }
        : {}),
      ...(cacheMaxBytes === undefined ? {} : { cacheMaxBytes }),
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
  marketplaceStatus: () => runtime?.marketplaceStatus() ?? "disconnected",
  onShutdown: () => setTimeout(() => void shutdown(), 0),
  revokeCaptureRoute: captureRoutes.revoke,
  ...(runtime
    ? {
        abortMultipart: runtime.abortMultipart,
        clearTraceCache: runtime.clearTraceCache,
        commitDataset: runtime.commitDataset,
        deleteTrace: runtime.deleteTrace,
        onPause: runtime.pauseCapture,
        onResume: runtime.resumeCapture,
        proposeAgreement: runtime.proposeAgreement,
        prepareDelivery: runtime.prepareDelivery,
        readTrace: runtime.readTrace,
        traceCacheStats: runtime.traceCacheStats,
        workQueue: runtime.workQueue,
      }
    : {}),
  queueCounts: state.counts,
  storageReady: () => runtime?.storageReady() ?? false,
  protocolVersion: bootstrap.protocolVersion,
  traces: state.traces,
});

if (runtime) {
  await runtime.initialize();
  await runtime.reconcile().catch(() => undefined);
  await runtime.cleanupExpiredDeliveries();
}

const cleanupTimer = runtime
  ? setInterval(() => {
      void runtime.cleanupExpiredDeliveries();
      void runtime.purgeTraceCache().catch(() => {
        state.recordEvent("plaintext_cache.purge_failed", { safeErrorCode: "local_delete_failed" });
      });
    }, 60_000)
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
    ...(forwardProxy?.port ? { proxyPort: forwardProxy.port } : {}),
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
