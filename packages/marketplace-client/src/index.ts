import type { MarketplaceManifestSink } from "@traice/capture-core";

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
    if (value.length > 512) {
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

export const createMarketplaceManifestClient = (config: {
  readonly apiBaseUrl: string;
  readonly credential: string;
  readonly fetch?: MarketplaceFetch;
}): MarketplaceManifestSink => {
  const send = config.fetch ?? globalThis.fetch;
  const base = new URL(config.apiBaseUrl);
  if (
    base.protocol !== "https:" &&
    base.hostname !== "127.0.0.1" &&
    base.hostname !== "localhost"
  ) {
    throw new Error("Marketplace API must use HTTPS outside loopback development");
  }

  return {
    submit: async (input) => {
      assertSafeManifestPayload(input);
      const request = new Request(new URL("/api/v1/traicer/manifests/batch", base), {
        body: JSON.stringify(input),
        headers: {
          authorization: `Bearer ${config.credential}`,
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
