import type { CaptureBootstrapV1 } from "@traice/api-contract";
import { createCaptureEngine } from "@traice/capture-core";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptTraceEnvelope,
  encryptForX25519Recipient,
  encryptTraceEnvelope,
  sha256Hex,
  signBytes,
} from "@traice/crypto";
import type { CapturePolicyV1 } from "@traice/domain";
import {
  createMarketplaceClient,
  createMarketplaceManifestClient,
  type MarketplaceFetch,
} from "@traice/marketplace-client";
import { canonicalBytes, canonicalJson, redactExchange } from "@traice/privacy-pipeline";
import type { openOperationalState } from "@traice/state-sqlite";
import { createS3CompatibleObjectStore } from "@traice/storage-s3";

import {
  createGatewayScheduler,
  createAnthropicGateway,
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
  const marketplace = createMarketplaceClient({
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
    storageCredentials,
    state.multipartJournal
  );
  const policy: CapturePolicyV1 = {
    allowedMethods: ["POST"],
    allowedPaths: bootstrap.policy.allowedPaths,
    capturePolicyId: bootstrap.policy.capturePolicyId,
    pipelineVersion: bootstrap.policy.pipelineVersion,
    policyVersion: bootstrap.policy.policyVersion,
    redactionProfile: bootstrap.policy.redactionProfile,
    schema: "traice.capture-policy/1",
    successfulResponsesOnly: true,
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
  let captureEnabled = false;
  const gatewayFactory = new URL(bootstrap.upstreamOrigin).hostname.includes("anthropic")
    ? createAnthropicGateway
    : createOpenAiGateway;
  const gateway = gatewayFactory({
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

  const publishInventory = async () => {
    const manifests = state.committedManifests();
    const captured = manifests.map(({ manifest }) => new Date(manifest.capturedAt).getTime());
    const now = new Date().toISOString();
    const sourceStartAt = captured.length > 0
      ? new Date(Math.min(...captured)).toISOString()
      : now;
    const sourceEndAt = captured.length > 0
      ? new Date(Math.max(...captured)).toISOString()
      : now;
    const eligible = manifests.length;
    const totalTokens = manifests.reduce(
      (total, { manifest }) => total + manifest.inputTokens + manifest.outputTokens,
      0
    );
    const traceCountBand = eligible < 10 ? "under-10" : eligible < 100 ? "10-99" : eligible < 1_000 ? "100-999" : "1000+";
    const tokenCountBand = totalTokens < 10_000 ? "under-10k" : totalTokens < 1_000_000 ? "10k-999k" : "1m+";
    const snapshotPayload = {
      aggregateDimensions: {
        providers: [...new Set(manifests.map(({ manifest }) => manifest.provider))],
        verificationTier: "self_attested",
      },
      counts: {
        deleted: 0,
        eligible,
        listed: eligible >= 10 ? eligible : 0,
        private: eligible < 10 ? eligible : 0,
        quarantined: 0,
        uploadFailed: 0,
      },
      deviceId: bootstrap.deviceId,
      generatedAt: now,
      segments: eligible === 0 ? [] : [{
        coarseningLevel: 1,
        effectiveFrom: sourceStartAt,
        eligibleManifestCount: eligible,
        filterDimensions: {
          adapter: [...new Set(manifests.map(({ manifest }) => manifest.adapter))],
          domain: ["software-development"],
          model: [...new Set(manifests.map(({ manifest }) => manifest.model))],
          provider: [...new Set(manifests.map(({ manifest }) => manifest.provider))],
          task: ["coding-agent"],
          verificationTier: ["self_attested"],
        },
        label: "Seller-approved coding-agent traces",
        tokenCountBand,
        traceCountBand,
        visibility: eligible >= 10 ? "qualified_buyers" as const : "private" as const,
      }],
      sourceEndAt,
      sourceStartAt,
    };
    return marketplace.commitInventorySnapshot({
      ...snapshotPayload,
      signature: await signBytes(bootstrap.signingPrivateKey, canonicalBytes(snapshotPayload)),
    });
  };

  const commitDataset = async (requestId: string) => {
    const work = (await marketplace.workQueue()).data.find((item) => item.request.id === requestId);
    if (!work) throw new Error("Marketplace request is not available to this seller");
    if (work.dataset) return work.dataset;
    const manifests = state.committedManifests(work.request.requestedTraceCount);
    if (manifests.length === 0) throw new Error("No committed local manifests are eligible");
    const orderedManifestCommitments = manifests
      .map(({ manifest }) => manifest.canonicalHash)
      .sort();
    const datasetRoot = await sha256Hex(canonicalJson(orderedManifestCommitments));
    const totals = manifests.reduce(
      (total, { manifest }) => ({
        encryptedBytes: total.encryptedBytes + manifest.encryptedBytes,
        inputTokens: total.inputTokens + manifest.inputTokens,
        outputTokens: total.outputTokens + manifest.outputTokens,
        traceCount: total.traceCount + 1,
      }),
      { encryptedBytes: 0, inputTokens: 0, outputTokens: 0, traceCount: 0 }
    );
    const payload = {
      datasetRoot,
      deviceId: bootstrap.deviceId,
      orderedManifestCommitments,
      requestId,
      safeTotals: totals,
      signatureAlgorithm: "Ed25519" as const,
    };
    return (await marketplace.commitDataset({
      ...payload,
      signature: await signBytes(bootstrap.signingPrivateKey, canonicalBytes(payload)),
    })).data;
  };

  const proposeAgreement = async (requestId: string) => {
    const work = (await marketplace.workQueue()).data.find((item) => item.request.id === requestId);
    if (!work?.dataset || !work.quote) throw new Error("A committed dataset and active quote are required");
    const purpose = work.request.intendedUse;
    const terms = work.request.rightsTerms;
    if (typeof purpose !== "string" || !terms || typeof terms !== "object" || Array.isArray(terms)) {
      throw new Error("Marketplace agreement terms are invalid");
    }
    const signed = {
      datasetManifestId: work.dataset.id,
      licenceVersion: work.quote.licenceVersion,
      purpose,
      quoteId: work.quote.id,
      requestId,
      sellerDeviceId: bootstrap.deviceId,
      terms: terms as Readonly<Record<string, unknown>>,
    };
    return (await marketplace.proposeAgreement({
      datasetManifestId: signed.datasetManifestId,
      deviceId: bootstrap.deviceId,
      licenceVersion: signed.licenceVersion,
      purpose: signed.purpose,
      quoteId: signed.quoteId,
      requestId,
      sellerAcceptanceSignature: await signBytes(
        bootstrap.signingPrivateKey,
        canonicalBytes(signed)
      ),
      terms: signed.terms,
    })).data;
  };

  const prepareDelivery = async (requestId: string) => {
    const work = (await marketplace.workQueue()).data.find((item) => item.request.id === requestId);
    if (!work?.dataset || !work.agreement || !work.buyerKey) {
      throw new Error("An accepted agreement, dataset, and active buyer key are required");
    }
    if (work.buyerKey.algorithm !== "X25519") throw new Error("The active buyer key is not X25519");
    const allManifests = state.committedManifests();
    const byCanonicalHash = new Map(allManifests.map((signed) => [signed.manifest.canonicalHash, signed]));
    const selected = work.dataset.orderedManifestCommitments.map((commitment) => byCanonicalHash.get(commitment));
    if (selected.some((manifest) => !manifest)) throw new Error("The committed dataset is no longer available locally");
    const deliveryWrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const localWrappingKey = base64UrlToBytes(vaultKey);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const objects: { canonicalHash: string; ciphertextHash: string; url: string }[] = [];
    try {
      for (const signed of selected) {
        if (!signed) continue;
        const original = await objectStore.getEnvelope(signed.manifest.ciphertextHash);
        const canonical = await decryptTraceEnvelope({ envelope: original, wrappingKey: localWrappingKey });
        const deliveryObject = await encryptTraceEnvelope({
          canonicalBytes: canonical,
          traceId: signed.manifest.clientManifestId,
          wrappingKey: deliveryWrappingKey,
        });
        await objectStore.putEnvelope({ bytes: deliveryObject.bytes, ciphertextHash: deliveryObject.ciphertextHash });
        state.recordDeliveryObject(deliveryObject.ciphertextHash, expiresAt);
        objects.push({
          canonicalHash: deliveryObject.canonicalHash,
          ciphertextHash: deliveryObject.ciphertextHash,
          url: await objectStore.presignGet(deliveryObject.ciphertextHash, 900),
        });
      }
      const capability = {
        datasetRoot: work.dataset.datasetRoot,
        expiresAt,
        objects,
        schema: "traice.delivery-capability/1",
        wrappingKey: bytesToBase64Url(deliveryWrappingKey),
      };
      const payload = {
        buyerKeyFingerprint: work.buyerKey.fingerprint,
        datasetManifestId: work.dataset.id,
        deviceId: bootstrap.deviceId,
        envelopeAlgorithm: "X25519-HKDF-SHA256-AES-256-GCM/v1",
        envelopeCiphertext: await encryptForX25519Recipient(
          work.buyerKey.publicKey,
          canonicalBytes(capability)
        ),
        expiresAt,
      };
      return (await marketplace.submitDeliveryEnvelope({
        ...payload,
        sellerSignature: await signBytes(bootstrap.signingPrivateKey, canonicalBytes(payload)),
      })).data;
    } finally {
      deliveryWrappingKey.fill(0);
      localWrappingKey.fill(0);
    }
  };

  const cleanupExpiredDeliveries = async (): Promise<number> => {
    let deleted = 0;
    for (const object of state.expiredDeliveryObjects()) {
      try {
        await objectStore.deleteEnvelope(object.ciphertextHash);
        state.markDeliveryObjectDeleted(object.ciphertextHash);
        deleted += 1;
      } catch {
        state.recordEvent("delivery.cleanup_failed", { safeErrorCode: "storage_unavailable" });
      }
    }
    return deleted;
  };

  const deleteTrace = async (traceId: string, reason: string) => {
    const trace = state.traceObject(traceId);
    if (!trace) throw new Error("Committed local trace not found");
    await objectStore.deleteEnvelope(trace.ciphertextHash);
    const signedPayload = {
      clientManifestId: trace.clientManifestId,
      deviceId: bootstrap.deviceId,
      reason,
      tombstonedAt: new Date().toISOString(),
    };
    const response = await marketplace.tombstoneManifest({
      ...signedPayload,
      signature: await signBytes(bootstrap.signingPrivateKey, canonicalBytes(signedPayload)),
    });
    state.tombstoneTrace(traceId, trace.clientManifestId, "seller_requested");
    return response.data;
  };

  return {
    abortMultipart: objectStore.abortMultipart,
    gateway,
    deleteTrace,
    initialize: async () => {
      const checkedAt = new Date().toISOString();
      let storageProbe: Awaited<ReturnType<typeof objectStore.probe>>;
      try {
        storageProbe = await objectStore.probe();
      } catch {
        storageProbe = {
          checks: {
            capabilityCreate: false,
            capabilityExpire: false,
            delete: false,
            head: false,
            readIntegrity: false,
            write: false,
          },
          versioningEnabled: undefined,
        };
      }
      const storagePassed = Object.values(storageProbe.checks).every(Boolean);
      const storagePayload = {
        bucketAlias: bootstrap.bucketAlias,
        checkedAt,
        checks: storageProbe.checks,
        deviceId: bootstrap.deviceId,
        encryptionMode: "AES-256-GCM per trace with a wrapped data key",
        ...(!storagePassed ? { safeErrorCode: "STORAGE_CONFORMANCE_FAILED" } : {}),
        signatureAlgorithm: "Ed25519" as const,
        status: storagePassed ? "passed" as const : "failed" as const,
        storageKind: "s3_compatible",
        ...(storageProbe.versioningEnabled === undefined
          ? {}
          : { versioningEnabled: storageProbe.versioningEnabled }),
      };
      await marketplace.commitStorageHealth({
        ...storagePayload,
        signature: await signBytes(bootstrap.signingPrivateKey, canonicalBytes(storagePayload)),
      });
      if (!storagePassed) throw new Error("Seller storage conformance failed");

      const provider = new URL(bootstrap.upstreamOrigin).hostname.includes("anthropic")
        ? "anthropic" as const
        : "openai" as const;
      const fixtureSecret = "trc_fixture_secret_that_must_not_survive";
      const fixture = redactExchange({
        adapter: provider === "anthropic" ? "anthropic-messages/1" : "openai-responses/1",
        capturedAt: checkedAt,
        client: bootstrap.client,
        method: "POST",
        model: "traicer-dry-run",
        path: policy.allowedPaths[0] ?? "/",
        provider,
        requestBody: { authorization: fixtureSecret, prompt: "safe fixture" },
        requestHeaders: { authorization: `Bearer ${fixtureSecret}` },
        responseBody: { output: "safe fixture response" },
        responseStatus: 200,
        traceId: crypto.randomUUID(),
        usage: { inputTokens: 2, outputTokens: 3 },
      }, policy);
      const canonical = canonicalJson(fixture.trace);
      const dryResults = {
        canonicalisation: canonical.length > 0,
        parser: true,
        policyAllowlist: policy.allowedPaths.length > 0,
        redaction: !canonical.includes(fixtureSecret),
        storageConformance: storagePassed,
      };
      const dryPassed = Object.values(dryResults).every(Boolean);
      const dryPayload = {
        adapter: provider === "anthropic" ? "anthropic-messages/1" : "openai-responses/1",
        capturePolicyId: bootstrap.policy.capturePolicyId,
        deviceId: bootstrap.deviceId,
        fixtureVersion: "builtin-safety/1",
        ...(!dryPassed ? { quarantineReason: "A built-in safety fixture failed" } : {}),
        results: dryResults,
        runAt: checkedAt,
        signatureAlgorithm: "Ed25519" as const,
        status: dryPassed ? "passed" as const : "quarantined" as const,
      };
      await marketplace.commitDryRun({
        ...dryPayload,
        signature: await signBytes(bootstrap.signingPrivateKey, canonicalBytes(dryPayload)),
      });
      if (!dryPassed) throw new Error("Capture safety dry run failed");
      await publishInventory();
      captureEnabled = true;
    },
    commitDataset,
    cleanupExpiredDeliveries,
    pauseCapture: () => {
      captureEnabled = false;
    },
    prepareDelivery,
    proposeAgreement,
    reconcile: () => state.reconcile(remoteSink),
    resumeCapture: () => {
      captureEnabled = true;
    },
    workQueue: async () => (await marketplace.workQueue()).data,
    scheduler,
  };
};
