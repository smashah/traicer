import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
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

export interface MultipartUploadJournal {
  readonly clear: (ciphertextHash: string) => void;
  readonly load: (ciphertextHash: string) => {
    readonly parts: readonly { readonly eTag: string; readonly partNumber: number }[];
    readonly uploadId: string;
  } | undefined;
  readonly recordPart: (ciphertextHash: string, partNumber: number, eTag: string) => void;
  readonly start: (ciphertextHash: string, uploadId: string) => void;
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
  credentials: S3CompatibleCredentials,
  multipartJournal?: MultipartUploadJournal
): SellerObjectStore & {
  readonly abortMultipart: (ciphertextHash: string) => Promise<boolean>;
  readonly deleteEnvelope: (ciphertextHash: string) => Promise<void>;
  readonly getEnvelope: (ciphertextHash: string) => Promise<Uint8Array>;
  readonly presignGet: (ciphertextHash: string, expiresInSeconds: number) => Promise<string>;
  readonly probe: () => Promise<{
    readonly checks: Readonly<Record<"capabilityCreate" | "capabilityExpire" | "delete" | "head" | "readIntegrity" | "write", boolean>>;
    readonly versioningEnabled: boolean | undefined;
  }>;
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

  const uploadMultipart = async (bytes: Uint8Array, ciphertextHash: string, key: string) => {
    if (!multipartJournal) throw new Error("Large uploads require a durable multipart journal");
    let persisted = multipartJournal.load(ciphertextHash);
    if (!persisted) {
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        Metadata: { "traice-sha256": ciphertextHash },
      }));
      if (!created.UploadId) throw new Error("S3-compatible storage did not return a multipart upload ID");
      multipartJournal.start(ciphertextHash, created.UploadId);
      persisted = { parts: [], uploadId: created.UploadId };
    }
    const completed = new Map(persisted.parts.map((part) => [part.partNumber, part.eTag]));
    const partSize = 8 * 1024 * 1024;
    try {
      for (let offset = 0, partNumber = 1; offset < bytes.byteLength; offset += partSize, partNumber += 1) {
        if (completed.has(partNumber)) continue;
        const body = bytes.slice(offset, Math.min(offset + partSize, bytes.byteLength));
        const uploaded = await client.send(new UploadPartCommand({
          Body: body,
          Bucket: config.bucket,
          ContentLength: body.byteLength,
          Key: key,
          PartNumber: partNumber,
          UploadId: persisted.uploadId,
        }));
        if (!uploaded.ETag) throw new Error(`Multipart part ${partNumber} returned no ETag`);
        completed.set(partNumber, uploaded.ETag);
        multipartJournal.recordPart(ciphertextHash, partNumber, uploaded.ETag);
      }
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        MultipartUpload: {
          Parts: [...completed.entries()].sort(([left], [right]) => left - right)
            .map(([PartNumber, ETag]) => ({ ETag, PartNumber })),
        },
        UploadId: persisted.uploadId,
      }));
      multipartJournal.clear(ciphertextHash);
    } catch (error) {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => undefined);
      if (head?.ContentLength === bytes.byteLength && head.Metadata?.["traice-sha256"] === ciphertextHash) {
        multipartJournal.clear(ciphertextHash);
        return;
      }
      throw error;
    }
  };

  return {
    abortMultipart: async (ciphertextHash) => {
      const persisted = multipartJournal?.load(ciphertextHash);
      if (!persisted) return false;
      await client.send(new AbortMultipartUploadCommand({
        Bucket: config.bucket,
        Key: objectKey(config.prefix, ciphertextHash),
        UploadId: persisted.uploadId,
      }));
      multipartJournal?.clear(ciphertextHash);
      return true;
    },
    deleteEnvelope: async (ciphertextHash) => {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(config.prefix, ciphertextHash),
        })
      );
    },
    getEnvelope: async (ciphertextHash) => {
      const response = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: objectKey(config.prefix, ciphertextHash),
      }));
      const bytes = await bytesFromBody(response.Body);
      if ((await sha256Hex(bytes)) !== ciphertextHash) throw new Error("Downloaded ciphertext hash mismatch");
      return bytes;
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
    probe: async () => {
      const bytes = crypto.getRandomValues(new Uint8Array(96));
      const ciphertextHash = await sha256Hex(bytes);
      const key = objectKey(config.prefix, ciphertextHash);
      const checks = {
        capabilityCreate: false,
        capabilityExpire: false,
        delete: false,
        head: false,
        readIntegrity: false,
        write: false,
      };
      try {
        await client.send(new PutObjectCommand({
          Body: bytes,
          Bucket: config.bucket,
          ContentLength: bytes.byteLength,
          Key: key,
          Metadata: { "traice-sha256": ciphertextHash, "traice-test": "conformance-v1" },
        }));
        checks.write = true;
        const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        checks.head = head.ContentLength === bytes.byteLength && head.Metadata?.["traice-sha256"] === ciphertextHash;
        const downloaded = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        checks.readIntegrity = (await sha256Hex(await bytesFromBody(downloaded.Body))) === ciphertextHash;
        const capability = new URL(await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
          { expiresIn: 60 }
        ));
        checks.capabilityCreate = capability.protocol === "https:" || capability.hostname === "127.0.0.1" || capability.hostname === "localhost";
        checks.capabilityExpire = capability.searchParams.get("X-Amz-Expires") === "60";
      } finally {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => undefined);
        try {
          await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        } catch {
          checks.delete = true;
        }
      }
      const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: config.bucket })).catch(() => undefined);
      return {
        checks,
        versioningEnabled: versioning ? versioning.Status === "Enabled" : undefined,
      };
    },
    putEnvelope: async ({ bytes, ciphertextHash }) => {
      if ((await sha256Hex(bytes)) !== ciphertextHash) {
        throw new Error("Ciphertext hash does not match upload bytes");
      }
      const key = objectKey(config.prefix, ciphertextHash);
      if (bytes.byteLength >= 16 * 1024 * 1024) {
        await uploadMultipart(bytes, ciphertextHash, key);
      } else {
        await client.send(
          new PutObjectCommand({
            Body: bytes,
            Bucket: config.bucket,
            ContentLength: bytes.byteLength,
            Key: key,
            Metadata: { "traice-sha256": ciphertextHash },
          })
        );
      }
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
