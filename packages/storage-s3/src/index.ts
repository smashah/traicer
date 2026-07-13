import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SellerObjectStore } from "@traice/capture-core";
import { sha256Hex } from "@traice/crypto";

export interface S3CompatibleConfig {
  readonly addressingStyle: "path" | "virtual_hosted";
  readonly bucket: string;
  readonly endpoint: string;
  readonly prefix: string;
  readonly signingRegion: string;
  readonly storageCapabilityProfileId: string;
}

export interface S3CompatibleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const objectKey = (prefix: string, ciphertextHash: string): string => {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  return `${normalized ? `${normalized}/` : ""}objects/v1/${ciphertextHash.slice(0, 2)}/${ciphertextHash}.trce`;
};

const bytesFromBody = async (body: unknown): Promise<Uint8Array> => {
  if (body && typeof body === "object" && "transformToByteArray" in body) {
    const transform = Reflect.get(body, "transformToByteArray");
    if (typeof transform === "function") {
      return new Uint8Array(await Reflect.apply(transform, body, []));
    }
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  throw new Error("S3-compatible response body is not readable");
};

export const createS3CompatibleObjectStore = (
  config: S3CompatibleConfig,
  credentials: S3CompatibleCredentials
): SellerObjectStore & {
  readonly deleteEnvelope: (ciphertextHash: string) => Promise<void>;
  readonly presignGet: (ciphertextHash: string, expiresInSeconds: number) => Promise<string>;
} => {
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" &&
    endpoint.hostname !== "127.0.0.1" &&
    endpoint.hostname !== "localhost"
  ) {
    throw new Error("S3-compatible storage must use HTTPS outside loopback development");
  }
  const clientConfig: S3ClientConfig = {
    credentials,
    endpoint: endpoint.toString(),
    forcePathStyle: config.addressingStyle === "path",
    region: config.signingRegion,
    requestChecksumCalculation: "WHEN_SUPPORTED",
    responseChecksumValidation: "WHEN_SUPPORTED",
  };
  const client = new S3Client(clientConfig);

  return {
    deleteEnvelope: async (ciphertextHash) => {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(config.prefix, ciphertextHash),
        })
      );
    },
    presignGet: (ciphertextHash, expiresInSeconds) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(config.prefix, ciphertextHash),
        }),
        { expiresIn: Math.min(Math.max(expiresInSeconds, 60), 900) }
      ),
    putEnvelope: async ({ bytes, ciphertextHash }) => {
      if ((await sha256Hex(bytes)) !== ciphertextHash) {
        throw new Error("Ciphertext hash does not match upload bytes");
      }
      const key = objectKey(config.prefix, ciphertextHash);
      await client.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: config.bucket,
          ContentLength: bytes.byteLength,
          Key: key,
          Metadata: { "traice-sha256": ciphertextHash },
        })
      );
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      if (
        head.ContentLength !== bytes.byteLength ||
        head.Metadata?.["traice-sha256"] !== ciphertextHash
      ) {
        throw new Error("S3-compatible metadata did not reconcile after upload");
      }
      const downloaded = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const readback = await bytesFromBody(downloaded.Body);
      if ((await sha256Hex(readback)) !== ciphertextHash) {
        throw new Error("S3-compatible full readback failed integrity verification");
      }
      return {
        encryptedBytes: bytes.byteLength,
        integrityAssurance: "full_readback",
        objectCommitment: await sha256Hex(key),
        storageCapabilityProfileId: config.storageCapabilityProfileId,
      };
    },
  };
};
