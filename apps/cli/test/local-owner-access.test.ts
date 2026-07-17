import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";

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
});
