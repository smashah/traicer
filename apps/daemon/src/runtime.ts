import type { CaptureBootstrapV1 } from "@traice/api-contract";
import { createCaptureEngine } from "@traice/capture-core";
import { base64UrlToBytes } from "@traice/crypto";
import type { CapturePolicyV1 } from "@traice/domain";
import {
  createMarketplaceManifestClient,
  type MarketplaceFetch,
} from "@traice/marketplace-client";
import type { openOperationalState } from "@traice/state-sqlite";
import { createS3CompatibleObjectStore } from "@traice/storage-s3";

import {
  createGatewayScheduler,
  createOpenAiGateway,
  type GatewayFetch,
} from "./gateway";

type OperationalState = ReturnType<typeof openOperationalState>;

export interface RuntimeOverrides {
  readonly marketplaceFetch?: MarketplaceFetch;
  readonly upstreamFetch?: GatewayFetch;
}

export const createCaptureRuntime = (
  bootstrap: CaptureBootstrapV1,
  vaultKey: string,
  state: OperationalState,
  overrides: RuntimeOverrides = {}
) => {
  const remoteSink = createMarketplaceManifestClient({
    apiBaseUrl: bootstrap.marketplace.apiBaseUrl,
    credential: bootstrap.marketplace.credential,
    ...(overrides.marketplaceFetch ? { fetch: overrides.marketplaceFetch } : {}),
  });
  const durableSink = state.createDurableManifestSink(remoteSink);
  const storageCredentials = {
    accessKeyId: bootstrap.storage.accessKeyId,
    secretAccessKey: bootstrap.storage.secretAccessKey,
    ...(bootstrap.storage.sessionToken
      ? { sessionToken: bootstrap.storage.sessionToken }
      : {}),
  };
  const objectStore = createS3CompatibleObjectStore(
    {
      addressingStyle: bootstrap.storage.addressingStyle,
      bucket: bootstrap.storage.bucket,
      endpoint: bootstrap.storage.endpoint,
      prefix: bootstrap.storage.prefix,
      signingRegion: bootstrap.storage.signingRegion,
      storageCapabilityProfileId: bootstrap.storage.storageCapabilityProfileId,
    },
    storageCredentials
  );
  const policy: CapturePolicyV1 = {
    allowedMethods: ["POST"],
    allowedPaths: bootstrap.policy.allowedPaths,
    capturePolicyId: bootstrap.policy.capturePolicyId,
    pipelineVersion: bootstrap.policy.pipelineVersion,
    policyVersion: bootstrap.policy.policyVersion,
    redactionProfile: bootstrap.policy.redactionProfile,
    schema: "traice.capture-policy/1",
  };
  const engine = createCaptureEngine(
    {
      bucketAlias: bootstrap.bucketAlias,
      deviceId: bootstrap.deviceId,
      policy,
      signerKeyId: bootstrap.signerKeyId,
      signingPrivateKey: bootstrap.signingPrivateKey,
      wrappingKey: base64UrlToBytes(vaultKey),
    },
    objectStore,
    durableSink,
    {
      committed: ({ traceId }) => state.recordCommitted(traceId),
      encrypted: ({ canonicalHash, ciphertextHash, traceId }) =>
        state.recordEncrypted(traceId, canonicalHash, ciphertextHash),
      failed: ({ code, stage, traceId }) => state.recordFailure(traceId, stage, code),
      manifestPending: ({ clientManifestId, traceId }) =>
        state.recordManifestPending(traceId, clientManifestId),
      observed: ({ capturedAt, traceId }) => state.recordObserved(traceId, capturedAt),
    }
  );
  const scheduler = createGatewayScheduler();
  let captureEnabled = true;
  const gateway = createOpenAiGateway({
    adapterCapability: bootstrap.adapterCapability,
    capture: async (exchange) => {
      await engine.capture(exchange);
    },
    captureEnabled: () => captureEnabled,
    client: bootstrap.client,
    ...(overrides.upstreamFetch ? { fetchUpstream: overrides.upstreamFetch } : {}),
    scheduler,
    upstreamOrigin: bootstrap.upstreamOrigin,
  });

  return {
    gateway,
    pauseCapture: () => {
      captureEnabled = false;
    },
    reconcile: () => state.reconcile(remoteSink),
    resumeCapture: () => {
      captureEnabled = true;
    },
    scheduler,
  };
};
