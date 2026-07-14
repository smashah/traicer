import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { daemonEnvironment } from "../src/config";
import { createScaffold } from "../src/scaffold";

const keyPair = {
  keyId: "signer-key-id",
  privateKey: "private-key-material",
  publicKey: "public-key-material",
};

describe("Traicer init scaffold", () => {
  test("does not pass resolved secrets to the daemon environment", () => {
    expect(daemonEnvironment({
      __VARLOCK_ENV: "encrypted-blob",
      HOME: "/seller",
      TRAICER_SIGNING_PRIVATE_KEY: "private-key",
    })).toEqual({ HOME: "/seller" });
  });

  test("creates an R2 stack and writes only encrypted device secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-cli-"));
    await createScaffold({
      accountId: "public-account-id",
      bucket: "seller-traices",
      directory,
      marketplaceApiBaseUrl: "https://api.traice.market",
      provider: "anthropic",
      region: "auto",
      storage: "cloudflare-r2",
    }, {
      encryptSecret: async (value) => `varlock(\"encrypted:${value.length}\")`,
      generateSigningKeyPair: async () => keyPair,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      randomUuid: () => "12345678-1234-1234-1234-123456789abc",
    });

    const [config, env, schema, stack, workspace] = await Promise.all([
      readFile(join(directory, "traicer.config.json"), "utf8"),
      readFile(join(directory, ".env.local"), "utf8"),
      readFile(join(directory, ".env.schema"), "utf8"),
      readFile(join(directory, "infra/alchemy.run.ts"), "utf8"),
      readFile(join(directory, "infra/pnpm-workspace.yaml"), "utf8"),
    ]);
    expect(config).toContain("https://public-account-id.r2.cloudflarestorage.com");
    expect(env).toContain("varlock(\"encrypted:");
    expect(env).not.toContain(keyPair.privateKey);
    expect(schema).toContain("TRAICER_MARKETPLACE_CREDENTIAL=");
    expect(schema).not.toContain("+TRAICER_");
    expect(stack).toContain('Cloudflare.R2.Bucket("SellerTraces"');
    expect(stack).toContain('name: "seller-traices"');
    expect(workspace).toContain("onlyBuiltDependencies:");
    expect(workspace).toContain("  - workerd");
  });

  test("refuses to overwrite an existing secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-cli-"));
    await Bun.write(join(directory, ".env.local"), "existing=true\n");
    await expect(createScaffold({
      bucket: "existing",
      directory,
      endpoint: "https://storage.example.com",
      marketplaceApiBaseUrl: "https://api.traice.market",
      provider: "openai",
      region: "auto",
      storage: "existing-s3",
    }, {
      encryptSecret: async () => "varlock(\"encrypted\")",
      generateSigningKeyPair: async () => keyPair,
    })).rejects.toThrow("Refusing to overwrite");
  });
});
