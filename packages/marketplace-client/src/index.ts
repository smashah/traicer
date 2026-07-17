import type { MarketplaceManifestSink } from "@traice/capture-core";
import type { SignedSafeManifest } from "@traice/domain";

export type MarketplaceFetch = (request: Request) => Promise<Response>;

const forbiddenKeys = new Set([
  "accessKeyId",
  "authorization",
  "bucket",
  "credential",
  "endpoint",
  "objectKey",
  "password",
  "presignedUrl",
  "privateKey",
  "secret",
  "secretAccessKey",
  "sessionToken",
  "traceBody",
  "url",
  "vaultKey",
]);

const inspect = (value: unknown, path: string): void => {
  if (typeof value === "string") {
    const isEnvelopeCiphertext = path.endsWith(".envelopeCiphertext");
    if (value.length > (isEnvelopeCiphertext ? 900_000 : 512)) {
      throw new Error(`Manifest string exceeds the privacy budget at ${path}`);
    }
    if (/https?:\/\/[^\s]+\?[^\s]+/i.test(value)) {
      throw new Error(`Manifest contains a query-bearing URL at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      inspect(item, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) {
        throw new Error(`Manifest contains prohibited field ${path}.${key}`);
      }
      inspect(item, `${path}.${key}`);
    }
  }
};

export const assertSafeManifestPayload = (payload: unknown): void => {
  const encoded = JSON.stringify(payload);
  if (new TextEncoder().encode(encoded).byteLength > 1_048_576) {
    throw new Error("Manifest batch exceeds the 1 MiB limit");
  }
  inspect(payload, "manifestBatch");
};

export interface MarketplaceClientConfig {
  readonly apiBaseUrl: string;
  readonly credential?: string;
  readonly fetch?: MarketplaceFetch;
}

const authorizationHeaders = (credential: string | undefined): Record<string, string> =>
  credential ? { authorization: `Bearer ${credential}` } : {};

export interface RegisterDeviceInput {
  readonly adapters: readonly string[];
  readonly clientVersion: string;
  readonly name: string;
  readonly operatingSystemClass: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly replacesDeviceId?: string;
}

export interface CapturePolicyInput {
  readonly deviceId: string;
  readonly eligibilityRules: Readonly<Record<string, unknown>>;
  readonly endpointAllowlist: readonly string[];
  readonly redactionProfile: string;
  readonly repositoryRules: Readonly<Record<string, unknown>>;
  readonly signature: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly status: "active";
}

export interface StorageHealthInput {
  readonly broadRegion?: string;
  readonly bucketAlias: string;
  readonly checkedAt: string;
  readonly checks: Readonly<Record<"capabilityCreate" | "capabilityExpire" | "delete" | "head" | "readIntegrity" | "write", boolean>>;
  readonly deviceId: string;
  readonly encryptionMode: string;
  readonly safeErrorCode?: string;
  readonly signature: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly status: "failed" | "passed";
  readonly storageKind: string;
  readonly versioningEnabled?: boolean;
}

export interface DryRunInput {
  readonly adapter: string;
  readonly capturePolicyId: string;
  readonly deviceId: string;
  readonly fixtureVersion: string;
  readonly quarantineReason?: string;
  readonly results: Readonly<Record<string, boolean | number | string>>;
  readonly runAt: string;
  readonly signature: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly status: "passed" | "quarantined";
}

export interface TombstoneInput {
  readonly clientManifestId: string;
  readonly deviceId: string;
  readonly reason: string;
  readonly signature: string;
  readonly tombstonedAt: string;
}

export interface InventorySnapshotInput {
  readonly aggregateDimensions: Readonly<Record<string, unknown>>;
  readonly counts: Readonly<Record<"deleted" | "eligible" | "listed" | "private" | "quarantined" | "uploadFailed", number>>;
  readonly deviceId: string;
  readonly generatedAt: string;
  readonly segments: readonly {
    readonly coarseningLevel: number;
    readonly effectiveFrom: string;
    readonly effectiveUntil?: string;
    readonly eligibleManifestCount: number;
    readonly filterDimensions: Readonly<Record<string, string | readonly string[]>>;
    readonly label: string;
    readonly tokenCountBand: string;
    readonly traceCountBand: string;
    readonly visibility: "private" | "public" | "qualified_buyers";
  }[];
  readonly signature: string;
  readonly sourceEndAt: string;
  readonly sourceStartAt: string;
}

export interface DatasetCommitInput {
  readonly datasetRoot: string;
  readonly deviceId: string;
  readonly orderedManifestCommitments: readonly string[];
  readonly requestId: string;
  readonly safeTotals: Readonly<Record<string, number | string>>;
  readonly signature: string;
  readonly signatureAlgorithm: "Ed25519";
}

export interface DeliveryEnvelopeInput {
  readonly buyerKeyFingerprint: string;
  readonly datasetManifestId: string;
  readonly deviceId: string;
  readonly envelopeAlgorithm: string;
  readonly envelopeCiphertext: string;
  readonly expiresAt: string;
  readonly sellerSignature: string;
}

export interface AgreementProposalInput {
  readonly datasetManifestId: string;
  readonly deviceId: string;
  readonly licenceVersion: string;
  readonly purpose: string;
  readonly quoteId: string;
  readonly requestId: string;
  readonly sellerAcceptanceSignature: string;
  readonly terms: Readonly<Record<string, unknown>>;
}

interface MarketplaceResponse<T> {
  readonly data: T;
  readonly success: true;
}

export interface MarketplaceWorkItem {
  readonly agreement: null | Readonly<Record<string, unknown>>;
  readonly buyerKey: null | {
    readonly algorithm: string;
    readonly fingerprint: string;
    readonly publicKey: string;
    readonly signingAlgorithm: string;
    readonly signingPublicKey: string;
  };
  readonly dataset: null | {
    readonly datasetRoot: string;
    readonly id: string;
    readonly orderedManifestCommitments: readonly string[];
    readonly status: string;
  };
  readonly quote: null | {
    readonly id: string;
    readonly licenceVersion: string;
    readonly status: string;
  };
  readonly request: {
    readonly id: string;
    readonly requestedTraceCount: number;
    readonly status: string;
  } & Readonly<Record<string, unknown>>;
}

const marketplaceBase = (value: string): URL => {
  const base = new URL(value);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("Marketplace API must use HTTPS outside loopback development");
  }
  return base;
};

export const createMarketplaceClient = (config: MarketplaceClientConfig) => {
  const send = config.fetch ?? globalThis.fetch;
  const base = marketplaceBase(config.apiBaseUrl);
  const post = async <T>(path: string, input: unknown, idempotencyKey?: string): Promise<T> => {
    const encoded = JSON.stringify(input);
    if (new TextEncoder().encode(encoded).byteLength > 1_048_576) {
      throw new Error("Marketplace request exceeds the 1 MiB limit");
    }
    inspect(input, "marketplaceRequest");
    const response = await send(new Request(new URL(`/api${path}`, base), {
      body: encoded,
      headers: {
        ...authorizationHeaders(config.credential),
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      method: "POST",
    }));
    if (!response.ok) throw new Error(`Marketplace request failed with ${response.status}`);
    return (await response.json()) as T;
  };
  const get = async <T>(path: string): Promise<T> => {
    const response = await send(new Request(new URL(`/api${path}`, base), {
      headers: authorizationHeaders(config.credential),
      method: "GET",
    }));
    if (!response.ok) throw new Error(`Marketplace request failed with ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    commitCapturePolicy: (input: CapturePolicyInput) => post<MarketplaceResponse<{ id: string; policyVersion: number; status: string }>>("/v1/traicer/capture-policy", input),
    commitDataset: (input: DatasetCommitInput) => post<MarketplaceResponse<{ datasetRoot: string; id: string }>>("/v1/traicer/datasets", input),
    commitDryRun: (input: DryRunInput) => post<MarketplaceResponse<{ id: string; status: string }>>("/v1/traicer/capture-dry-runs", input),
    commitInventorySnapshot: (input: InventorySnapshotInput) => post<MarketplaceResponse<{ id: string; segmentCount: number }>>("/v1/traicer/inventory/snapshots", input),
    commitStorageHealth: (input: StorageHealthInput) => post<MarketplaceResponse<{ id: string; status: string }>>("/v1/traicer/storage-health", input),
    currentCapturePolicy: () => get<MarketplaceResponse<{
      endpointAllowlist: readonly string[];
      id: string;
      policyVersion: number;
      redactionProfile: string;
      status: string;
    }>>("/v1/traicer/capture-policy"),
    proposeAgreement: (input: AgreementProposalInput) => post<MarketplaceResponse<{ agreementVersion: number; id: string; status: string }>>("/v1/traicer/agreements", input),
    workQueue: () => get<MarketplaceResponse<readonly MarketplaceWorkItem[]>>("/v1/traicer/work"),
    registerDevice: (input: RegisterDeviceInput) => post<MarketplaceResponse<{ id: string; status: string }>>("/v1/traicer/devices", input),
    submitDeliveryEnvelope: (input: DeliveryEnvelopeInput) => post<MarketplaceResponse<{ id: string; status: string }>>("/v1/traicer/delivery-envelopes", input),
    submitManifestBatch: (input: { readonly idempotencyKey: string; readonly manifests: readonly SignedSafeManifest[] }) => post<MarketplaceResponse<Record<string, unknown>>>("/v1/traicer/manifests/batch", input, input.idempotencyKey),
    tombstoneManifest: (input: TombstoneInput) => post<MarketplaceResponse<{ id: string; status: string; version?: number }>>("/v1/traicer/manifests/tombstone", input),
  };
};

export const createMarketplaceManifestClient = (config: {
  readonly apiBaseUrl: string;
  readonly credential?: string;
  readonly fetch?: MarketplaceFetch;
}): MarketplaceManifestSink => {
  const send = config.fetch ?? globalThis.fetch;
  const base = marketplaceBase(config.apiBaseUrl);

  return {
    submit: async (input) => {
      assertSafeManifestPayload(input);
      const request = new Request(new URL("/api/v1/traicer/manifests/batch", base), {
        body: JSON.stringify(input),
        headers: {
          ...authorizationHeaders(config.credential),
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
        },
        method: "POST",
      });
      const response = await send(request);
      if (!response.ok) {
        throw new Error(`Marketplace manifest submission failed with ${response.status}`);
      }
    },
  };
};
