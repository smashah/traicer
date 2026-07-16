import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { parseCloudflareAccountId } from "../src/cloudflare";
import { createBootstrap, daemonEnvironment, readTraicerConfig } from "../src/config";
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
    const accountId = parseCloudflareAccountId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await createScaffold({
      accountId,
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
    expect(config).toContain(`https://${accountId}.r2.cloudflarestorage.com`);
    expect(JSON.parse(config).capture.adapters).toEqual([
      { allowedPaths: ["/v1/messages"], provider: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
      { allowedPaths: ["/v1/chat/completions", "/v1/responses"], provider: "openai", upstreamOrigin: "https://api.openai.com" },
    ]);
    expect(env).toContain("varlock(\"encrypted:");
    expect(env).toContain("TRAICER_PROJECT_MAPPING_KEY=");
    expect(env).not.toContain("TRAICER_ADAPTER_CAPABILITY");
    expect(env).not.toContain(keyPair.privateKey);
    expect(schema).toContain("TRAICER_MARKETPLACE_CREDENTIAL=");
    expect(schema).not.toContain("+TRAICER_");
    expect(stack).toContain(`process.env.CLOUDFLARE_ACCOUNT_ID ??= "${accountId}"`);
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

  test("keeps the fixed capability when loading a version-one config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-cli-"));
    await Bun.write(join(directory, "traicer.config.json"), JSON.stringify({
      capture: {
        allowedPaths: ["/v1/responses"],
        client: "codex",
        provider: "openai",
        upstreamOrigin: "https://api.openai.com",
      },
      device: { id: "device", signerKeyId: "signer", signingPublicKey: "public" },
      marketplace: { apiBaseUrl: "https://api.traice.market" },
      schema: "traicer.config/1",
      storage: {
        addressingStyle: "path", bucket: "bucket", bucketAlias: "alias",
        endpoint: "https://storage.example.com", prefix: "traices/",
        provider: "existing-s3", signingRegion: "auto",
      },
    }));
    const names = [
      "TRAICER_ADAPTER_CAPABILITY", "TRAICER_CONTROL_TOKEN", "TRAICER_MARKETPLACE_CREDENTIAL",
      "TRAICER_SIGNING_PRIVATE_KEY", "TRAICER_STORAGE_ACCESS_KEY_ID",
      "TRAICER_STORAGE_SECRET_ACCESS_KEY", "TRAICER_VAULT_KEY",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = name === "TRAICER_VAULT_KEY"
        ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        : `${name.toLowerCase()}-fixture-value-000000000000`;
      const bootstrap = createBootstrap(await readTraicerConfig(directory));
      expect(bootstrap.capture).toMatchObject({
        legacyAdapterCapability: process.env.TRAICER_ADAPTER_CAPABILITY,
        legacyClient: "codex",
      });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
