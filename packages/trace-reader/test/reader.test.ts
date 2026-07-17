import { afterEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";

import { encryptTraceEnvelope } from "@traice/crypto";

import { createPlaintextTraceCache, createTraceReader, TraceReadError } from "../src";

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Bun.$`rm -rf ${root}`.quiet()));
});

const canonical = (traceId: string, marker = "safe output") => ({
  adapter: "openai-responses/1",
  capturedAt: "2026-07-17T08:00:00.000Z",
  client: "codex",
  model: "gpt-test",
  provider: "openai",
  redaction: { detectorVersion: "builtin/1", profile: "strict-default", replacements: {} },
  request: { input: "safe input" },
  response: { body: { output: marker }, status: 200 },
  schema: "traice.trace/1",
  traceId,
  usage: { inputTokens: 2, outputTokens: 3 },
} as const);

describe("owner trace reader", () => {
  test("downloads one selected envelope, verifies and decrypts it, then reuses the compressed cache", async () => {
    const root = `/tmp/traicer-reader-${crypto.randomUUID()}`;
    roots.push(root);
    const traceId = crypto.randomUUID();
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const canonicalBytes = encoder.encode(JSON.stringify(canonical(traceId)));
    const envelope = await encryptTraceEnvelope({ canonicalBytes, traceId, wrappingKey });
    let downloads = 0;
    const progress: string[] = [];
    const cache = createPlaintextTraceCache({ directory: root });
    const reader = createTraceReader({
      cache,
      getEnvelope: async (_hash, report) => {
        downloads += 1;
        report?.({ completedBytes: envelope.bytes.byteLength, totalBytes: envelope.bytes.byteLength });
        return envelope.bytes;
      },
      resolveTrace: async (selector) => selector === traceId ? {
        canonicalHash: envelope.canonicalHash,
        ciphertextHash: envelope.ciphertextHash,
        traceId,
      } : undefined,
      wrappingKey,
    });

    const first = await reader.read(traceId, { onProgress: (event) => progress.push(event.phase) });
    expect(first.source).toBe("storage");
    expect(first.trace).toEqual(canonical(traceId));
    expect(downloads).toBe(1);
    expect(progress).toEqual(["lookup", "download", "verify", "decrypt", "validate", "cache"]);

    const second = await reader.read(traceId);
    expect(second.source).toBe("cache");
    expect(second.trace).toEqual(canonical(traceId));
    expect(downloads).toBe(1);

    const files = await readdir(root);
    expect(files).toHaveLength(1);
    const cached = new Uint8Array(await Bun.file(`${root}/${files[0]}`).arrayBuffer());
    expect(new TextDecoder().decode(cached)).not.toContain("safe input");
    expect((await stat(`${root}/${files[0]}`)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  test("propagates cache deletion failures and never reports an entry as removed", async () => {
    const root = `/tmp/traicer-cache-delete-${crypto.randomUUID()}`;
    roots.push(root);
    let now = Date.now();
    const hash = "f".repeat(64);
    await createPlaintextTraceCache({ directory: root, now: () => now })
      .put(hash, encoder.encode(JSON.stringify(canonical(crypto.randomUUID()))));
    now += 7 * 24 * 60 * 60 * 1_000 + 1;
    const failing = createPlaintextTraceCache({
      directory: root,
      now: () => now,
      removeFile: async () => {
        const error = new Error("fixture unlink denied") as Error & { code: string };
        error.code = "EACCES";
        throw error;
      },
    });
    await expect(failing.purge()).rejects.toThrow("fixture unlink denied");
    expect((await readdir(root)).length).toBe(1);
  });

  test("purges plaintext after seven days and enforces the compressed size ceiling", async () => {
    const root = `/tmp/traicer-cache-${crypto.randomUUID()}`;
    roots.push(root);
    let now = new Date("2026-07-17T08:00:00.000Z").getTime();
    const cache = createPlaintextTraceCache({ directory: root, maxBytes: 400, now: () => now });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    await cache.put(firstHash, encoder.encode(JSON.stringify(canonical(crypto.randomUUID(), crypto.randomUUID().repeat(16)))));
    await cache.put(secondHash, encoder.encode(JSON.stringify(canonical(crypto.randomUUID(), crypto.randomUUID().repeat(16)))));
    expect((await cache.stats()).bytes).toBeLessThanOrEqual(400);
    expect((await cache.stats()).entries).toBe(1);

    now += 7 * 24 * 60 * 60 * 1_000 + 1;
    expect(await cache.purge()).toMatchObject({ expired: 1 });
    expect(await cache.stats()).toEqual({ bytes: 0, entries: 0 });
  });

  test("fails closed for tampered ciphertext without leaving plaintext cached", async () => {
    const root = `/tmp/traicer-tamper-${crypto.randomUUID()}`;
    roots.push(root);
    const traceId = crypto.randomUUID();
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await encryptTraceEnvelope({
      canonicalBytes: encoder.encode(JSON.stringify(canonical(traceId, "plaintext-canary"))),
      traceId,
      wrappingKey,
    });
    const tampered = envelope.bytes.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    const cache = createPlaintextTraceCache({ directory: root });
    const reader = createTraceReader({
      cache,
      getEnvelope: async () => tampered,
      resolveTrace: async () => ({
        canonicalHash: envelope.canonicalHash,
        ciphertextHash: envelope.ciphertextHash,
        traceId,
      }),
      wrappingKey,
    });

    await expect(reader.read(traceId)).rejects.toMatchObject({ code: "integrity_failed" });
    expect(await cache.stats()).toEqual({ bytes: 0, entries: 0 });
  });

  test("accepts a configured object key only when it resolves to a known trace", async () => {
    const hash = "c".repeat(64);
    const key = `traices/objects/v1/cc/${hash}.trce`;
    const seen: string[] = [];
    const reader = createTraceReader({
      getEnvelope: async () => { throw new Error("unused"); },
      resolveTrace: async (selector) => {
        seen.push(selector);
        return undefined;
      },
      wrappingKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    await expect(reader.read(key)).rejects.toMatchObject({ code: "not_found" });
    expect(seen).toEqual([key]);
  });

  test("fails with bounded safe codes for wrong keys, unsupported schemas, and oversized objects", async () => {
    const traceId = crypto.randomUUID();
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const valid = await encryptTraceEnvelope({
      canonicalBytes: encoder.encode(JSON.stringify(canonical(traceId))),
      traceId,
      wrappingKey,
    });
    const locator = {
      canonicalHash: valid.canonicalHash,
      ciphertextHash: valid.ciphertextHash,
      traceId,
    };
    const wrongKeyReader = createTraceReader({
      getEnvelope: async () => valid.bytes,
      resolveTrace: async () => locator,
      wrappingKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    await expect(wrongKeyReader.read(traceId)).rejects.toMatchObject({ code: "decrypt_failed" });

    const unsupportedBytes = encoder.encode(JSON.stringify({ ...canonical(traceId), schema: "traice.trace/99" }));
    const unsupported = await encryptTraceEnvelope({ canonicalBytes: unsupportedBytes, traceId, wrappingKey });
    const unsupportedReader = createTraceReader({
      getEnvelope: async () => unsupported.bytes,
      resolveTrace: async () => ({
        canonicalHash: unsupported.canonicalHash,
        ciphertextHash: unsupported.ciphertextHash,
        traceId,
      }),
      wrappingKey,
    });
    await expect(unsupportedReader.read(traceId)).rejects.toMatchObject({ code: "schema_invalid" });

    const oversizedReader = createTraceReader({
      getEnvelope: async () => valid.bytes,
      maxEnvelopeBytes: valid.bytes.byteLength - 1,
      resolveTrace: async () => locator,
      wrappingKey,
    });
    await expect(oversizedReader.read(traceId)).rejects.toMatchObject({ code: "oversized" });
    expect(new TraceReadError("not_found").message).not.toContain(traceId);
  });

  test("does not log plaintext or key canaries on a failed read", async () => {
    const canary = "plaintext-and-secret-canary";
    const messages: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...values) => messages.push(values.join(" "));
    console.log = (...values) => messages.push(values.join(" "));
    try {
      const reader = createTraceReader({
        getEnvelope: async () => encoder.encode(canary),
        resolveTrace: async () => ({
          canonicalHash: "a".repeat(64),
          ciphertextHash: "b".repeat(64),
          traceId: crypto.randomUUID(),
        }),
        wrappingKey: encoder.encode(canary.padEnd(32, "x")).slice(0, 32),
      });
      await expect(reader.read(crypto.randomUUID())).rejects.toBeInstanceOf(TraceReadError);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(messages.join("\n")).not.toContain(canary);
  });

  test("maps corrupted local hash metadata to a bounded safe error", async () => {
    const traceId = crypto.randomUUID();
    const reader = createTraceReader({
      getEnvelope: async () => { throw new Error("must not download"); },
      resolveTrace: async () => ({ canonicalHash: "private locator canary", ciphertextHash: "bad", traceId }),
      wrappingKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    await expect(reader.read(traceId)).rejects.toMatchObject({ code: "local_state_unavailable" });
  });
});
