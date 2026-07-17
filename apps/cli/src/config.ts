import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { BootstrapV2 } from "@traice/api-contract";

export type Provider = "anthropic" | "openai";
export type StorageProvider = "aws-s3" | "cloudflare-r2" | "existing-s3";

export interface TraicerConfig {
  readonly capture: {
    readonly adapters: readonly {
      readonly allowedPaths: readonly string[];
      readonly provider: Provider;
      readonly upstreamOrigin: string;
    }[];
    readonly legacyClient?: string;
  };
  readonly device: {
    readonly id: string;
    readonly signerKeyId: string;
    readonly signingPublicKey: string;
  };
  readonly marketplace: {
    readonly apiBaseUrl: string;
  };
  readonly schema: "traicer.config/2";
  readonly storage: {
    readonly addressingStyle: "path" | "virtual_hosted";
    readonly bucket: string;
    readonly bucketAlias: string;
    readonly endpoint: string;
    readonly prefix: string;
    readonly provider: StorageProvider;
    readonly signingRegion: string;
  };
}

export const requiredSecret = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required Varlock value: ${name}`);
  return value;
};

export const daemonEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "__VARLOCK_ENV" && !entry[0].startsWith("TRAICER_")
    )
  );

export const readTraicerConfig = async (directory: string): Promise<TraicerConfig> => {
  const raw = JSON.parse(await readFile(resolve(directory, "traicer.config.json"), "utf8")) as TraicerConfig | {
    readonly capture: { readonly allowedPaths: readonly string[]; readonly client?: string; readonly provider: Provider; readonly upstreamOrigin: string };
    readonly device: TraicerConfig["device"];
    readonly marketplace: TraicerConfig["marketplace"];
    readonly schema: "traicer.config/1";
    readonly storage: TraicerConfig["storage"];
  };
  if (raw.schema === "traicer.config/2") return raw;
  if (raw.schema === "traicer.config/1") return {
    capture: {
      adapters: [{
        allowedPaths: raw.capture.allowedPaths,
        provider: raw.capture.provider,
        upstreamOrigin: raw.capture.upstreamOrigin,
      }],
      legacyClient: "client" in raw.capture && typeof raw.capture.client === "string"
        ? raw.capture.client
        : "unknown",
    },
    device: raw.device,
    marketplace: raw.marketplace,
    schema: "traicer.config/2",
    storage: raw.storage,
  };
  throw new Error("Unsupported Traicer config schema");
};

export const createBootstrap = (config: TraicerConfig): BootstrapV2 => ({
  capture: {
    adapters: config.capture.adapters.map((adapter) => ({ ...adapter, allowedPaths: [...adapter.allowedPaths] })),
    bucketAlias: config.storage.bucketAlias,
    deviceId: config.device.id,
    ...(config.capture.legacyClient ? {
      legacyAdapterCapability: requiredSecret("TRAICER_ADAPTER_CAPABILITY"),
      legacyClient: config.capture.legacyClient,
    } : {}),
    marketplace: {
      apiBaseUrl: config.marketplace.apiBaseUrl,
      ...(process.env.TRAICER_MARKETPLACE_CREDENTIAL
        ? { credential: process.env.TRAICER_MARKETPLACE_CREDENTIAL }
        : {}),
    },
    policy: {
      capturePolicyId: "strict-default",
      pipelineVersion: "1",
      policyVersion: "1",
      redactionProfile: "strict-default",
    },
    signerKeyId: config.device.signerKeyId,
    signingPrivateKey: requiredSecret("TRAICER_SIGNING_PRIVATE_KEY"),
    storage: {
      accessKeyId: requiredSecret("TRAICER_STORAGE_ACCESS_KEY_ID"),
      addressingStyle: config.storage.addressingStyle,
      bucket: config.storage.bucket,
      endpoint: config.storage.endpoint,
      prefix: config.storage.prefix,
      secretAccessKey: requiredSecret("TRAICER_STORAGE_SECRET_ACCESS_KEY"),
      ...(process.env.TRAICER_STORAGE_SESSION_TOKEN
        ? { sessionToken: process.env.TRAICER_STORAGE_SESSION_TOKEN }
        : {}),
      signingRegion: config.storage.signingRegion,
      storageCapabilityProfileId: `s3-compatible:${config.storage.provider}`,
    },
  },
  controlToken: requiredSecret("TRAICER_CONTROL_TOKEN"),
  protocolVersion: 2,
  vaultKey: requiredSecret("TRAICER_VAULT_KEY"),
});
