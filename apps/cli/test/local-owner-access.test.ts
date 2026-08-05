import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";

import { bytesToBase64Url, sha256Hex } from "@traice/crypto";
import { openOperationalState } from "@traice/state-sqlite";
import { createPlaintextTraceCache } from "@traice/trace-reader";

import { createLocalOwnerAccess, parseTraceFilters } from "../src/local-owner-access";

const paths: string[] = [];

afterEach(async () => {
  delete process.env.TRAICER_STORAGE_ACCESS_KEY_ID;
  delete process.env.TRAICER_STORAGE_SECRET_ACCESS_KEY;
  delete process.env.TRAICER_VAULT_KEY;
  await Promise.all(paths.splice(0).map((path) => Bun.$`rm -rf ${path}`.quiet()));
});

describe("offline local owner access", () => {
  test("validates bounded inventory filters", () => {
    expect(parseTraceFilters({ limit: "25", offset: "10", provider: "openai", state: "committed" })).toEqual({
      limit: 25,
      offset: 10,
      provider: "openai",
      state: "committed",
    });
    expect(() => parseTraceFilters({ limit: "0" })).toThrow("1 to 100");
    expect(() => parseTraceFilters({ offset: "1.5" })).toThrow("non-negative safe integer");
    expect(() => parseTraceFilters({ provider: "private-provider" })).toThrow("anthropic or openai");
    expect(() => parseTraceFilters({ since: "tomorrow-ish" })).toThrow("ISO-8601");
  });

  test("lists metadata and manages the cache without a daemon or storage secrets", async () => {
    const directory = `/tmp/traicer-offline-owner-${crypto.randomUUID()}`;
    paths.push(directory);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await Bun.write(`${directory}/traicer.config.json`, JSON.stringify({
      capture: { adapters: [] },
      device: { id: crypto.randomUUID(), signerKeyId: "signer", signingPublicKey: "public" },
      marketplace: { apiBaseUrl: "https://api.traice.market" },
      schema: "traicer.config/2",
      storage: {
        addressingStyle: "path",
        bucket: "seller-traces",
        bucketAlias: "seller",
        endpoint: "https://example.invalid",
        prefix: "traces/",
        provider: "existing-s3",
        signingRegion: "auto",
      },
    }));

    const owner = await createLocalOwnerAccess(directory);
    try {
      expect(await owner.list()).toEqual([]);
      expect(await owner.cacheStats()).toEqual({ bytes: 0, entries: 0, maxAgeDays: 7 });
      expect(await owner.clearCache()).toEqual({ removed: 0 });
    } finally {
      owner.close();
    }
  });

  test("reads a cached trace without requiring storage credentials", async () => {
    const directory = `/tmp/traicer-offline-cached-read-${crypto.randomUUID()}`;
    paths.push(directory);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await Bun.write(`${directory}/traicer.config.json`, JSON.stringify({
      capture: { adapters: [] },
      device: { id: crypto.randomUUID(), signerKeyId: "signer", signingPublicKey: "public" },
      marketplace: { apiBaseUrl: "https://api.traice.market" },
      schema: "traicer.config/2",
      storage: {
        addressingStyle: "path",
        bucket: "seller-traces",
        bucketAlias: "seller",
        endpoint: "https://example.invalid",
        prefix: "traces/",
        provider: "existing-s3",
        signingRegion: "auto",
      },
    }));

    const traceId = crypto.randomUUID();
    const trace = {
      schema: "traice.otel-genai.trace/1",
      schemaUrl: "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev",
      semconvCommit: "b694ec35855d8eccfacd5b09e4b72a808b363038",
      span: {
        attributes: {
          "gen_ai.input.messages": [{ parts: [{ content: "safe input", type: "text" }], role: "user" }],
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": [{ finish_reason: "stop", parts: [{ content: "safe output", type: "text" }], role: "assistant" }],
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-test",
          "gen_ai.response.model": "gpt-test",
          "gen_ai.usage.input_tokens": 2,
          "gen_ai.usage.output_tokens": 3,
        },
        kind: "CLIENT",
        name: "chat gpt-test",
      },
      traice: {
        adapter: "openai-responses/1",
        capturedAt: "2026-07-17T08:00:00.000Z",
        client: "codex",
        pipelineVersion: "otel-genai/1",
        provenance: "provider_exchange",
        providerRequest: { input: "safe input" },
        providerResponse: { body: { output: "safe output" }, statusCode: 200 },
        redaction: { detectorVersion: "builtin/1", profile: "strict-default", replacements: {} },
        traceId,
      },
    } as const;
    const canonicalBytes = new TextEncoder().encode(JSON.stringify(trace));
    const canonicalHash = await sha256Hex(canonicalBytes);
    const ciphertextHash = "c".repeat(64);
    const state = openOperationalState(`${directory}/traicer-state.db`);
    state.recordObserved(traceId, trace.traice.capturedAt, {
      client: trace.traice.client,
      provider: trace.span.attributes["gen_ai.provider.name"],
    });
    state.recordEncrypted(traceId, canonicalHash, ciphertextHash);
    state.close();
    await createPlaintextTraceCache({ directory: `${directory}/cache/decrypted` })
      .put(ciphertextHash, canonicalBytes);
    process.env.TRAICER_VAULT_KEY = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));

    const owner = await createLocalOwnerAccess(directory);
    try {
      expect(process.env.TRAICER_STORAGE_ACCESS_KEY_ID).toBeUndefined();
      expect(process.env.TRAICER_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
      expect(await owner.read(traceId)).toEqual({ source: "cache", trace });
    } finally {
      owner.close();
    }
  });
});
