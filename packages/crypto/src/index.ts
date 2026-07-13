const encoder = new TextEncoder();
const decoder = new TextDecoder();
const envelopeMagic = encoder.encode("TRCE");

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const base64UrlToBytes = (value: string): Uint8Array => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const sha256Hex = async (value: Uint8Array | string): Promise<string> => {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

export const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const size = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < size; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
};

const importAesKey = (raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", asArrayBuffer(raw), { name: "AES-GCM" }, false, usages);

export interface EncryptedTraceEnvelope {
  readonly bytes: Uint8Array;
  readonly canonicalHash: string;
  readonly ciphertextHash: string;
}

interface EnvelopeHeaderV1 {
  readonly schema: "traice.envelope/1";
  readonly canonicalHash: string;
  readonly nonce: string;
  readonly traceId: string;
  readonly wrapNonce: string;
  readonly wrappedDataKey: string;
}

export const encryptTraceEnvelope = async (input: {
  readonly canonicalBytes: Uint8Array;
  readonly traceId: string;
  readonly wrappingKey: Uint8Array;
}): Promise<EncryptedTraceEnvelope> => {
  if (input.wrappingKey.byteLength !== 32) {
    throw new Error("The wrapping key must be 256 bits");
  }

  const canonicalHash = await sha256Hex(input.canonicalBytes);
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
  const [dataKey, wrappingKey] = await Promise.all([
    importAesKey(dataKeyBytes, ["encrypt", "decrypt"]),
    importAesKey(input.wrappingKey, ["encrypt", "decrypt"]),
  ]);
  const wrappedDataKey = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asArrayBuffer(wrapNonce) },
      wrappingKey,
      asArrayBuffer(dataKeyBytes)
    )
  );

  const header: EnvelopeHeaderV1 = {
    canonicalHash,
    nonce: bytesToBase64Url(nonce),
    schema: "traice.envelope/1",
    traceId: input.traceId,
    wrapNonce: bytesToBase64Url(wrapNonce),
    wrappedDataKey: bytesToBase64Url(wrappedDataKey),
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        additionalData: asArrayBuffer(headerBytes),
        iv: asArrayBuffer(nonce),
        name: "AES-GCM",
      },
      dataKey,
      asArrayBuffer(input.canonicalBytes)
    )
  );
  dataKeyBytes.fill(0);

  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength, false);
  const bytes = concatBytes(envelopeMagic, new Uint8Array([1]), headerLength, headerBytes, ciphertext);
  return { bytes, canonicalHash, ciphertextHash: await sha256Hex(bytes) };
};

export const decryptTraceEnvelope = async (input: {
  readonly envelope: Uint8Array;
  readonly wrappingKey: Uint8Array;
}): Promise<Uint8Array> => {
  if (input.envelope.byteLength < 10 || decoder.decode(input.envelope.slice(0, 4)) !== "TRCE") {
    throw new Error("Invalid Traicer envelope");
  }
  if (input.envelope[4] !== 1) {
    throw new Error("Unsupported Traicer envelope version");
  }
  const headerLength = new DataView(
    input.envelope.buffer,
    input.envelope.byteOffset + 5,
    4
  ).getUint32(0, false);
  const headerStart = 9;
  const headerEnd = headerStart + headerLength;
  if (headerEnd >= input.envelope.byteLength) {
    throw new Error("Invalid Traicer envelope header length");
  }
  const headerBytes = input.envelope.slice(headerStart, headerEnd);
  const header = JSON.parse(decoder.decode(headerBytes)) as EnvelopeHeaderV1;
  if (header.schema !== "traice.envelope/1") {
    throw new Error("Invalid Traicer envelope schema");
  }
  const wrappingKey = await importAesKey(input.wrappingKey, ["decrypt"]);
  const dataKeyBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { iv: asArrayBuffer(base64UrlToBytes(header.wrapNonce)), name: "AES-GCM" },
      wrappingKey,
      asArrayBuffer(base64UrlToBytes(header.wrappedDataKey))
    )
  );
  const dataKey = await importAesKey(dataKeyBytes, ["decrypt"]);
  dataKeyBytes.fill(0);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        additionalData: asArrayBuffer(headerBytes),
        iv: asArrayBuffer(base64UrlToBytes(header.nonce)),
        name: "AES-GCM",
      },
      dataKey,
      asArrayBuffer(input.envelope.slice(headerEnd))
    )
  );
  if ((await sha256Hex(plaintext)) !== header.canonicalHash) {
    throw new Error("Canonical hash mismatch");
  }
  return plaintext;
};

export interface DeviceSigningKeyPair {
  readonly keyId: string;
  readonly privateKey: string;
  readonly publicKey: string;
}

export const generateDeviceSigningKeyPair = async (): Promise<DeviceSigningKeyPair> => {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    crypto.subtle.exportKey("raw", keyPair.publicKey),
  ]);
  const publicBytes = new Uint8Array(publicKey);
  return {
    keyId: (await sha256Hex(publicBytes)).slice(0, 32),
    privateKey: bytesToBase64Url(new Uint8Array(privateKey)),
    publicKey: bytesToBase64Url(publicBytes),
  };
};

export const signBytes = async (privateKey: string, bytes: Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    asArrayBuffer(base64UrlToBytes(privateKey)),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", key, asArrayBuffer(bytes)))
  );
};

export const verifyBytes = async (
  publicKey: string,
  signature: string,
  bytes: Uint8Array
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(base64UrlToBytes(publicKey)),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "Ed25519",
    key,
    asArrayBuffer(base64UrlToBytes(signature)),
    asArrayBuffer(bytes)
  );
};

interface RecipientEnvelopeV1 {
  readonly ciphertext: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly salt: string;
  readonly schema: "traice.recipient-envelope/1";
}

const deriveRecipientKey = async (
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  usage: KeyUsage
) => {
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: encoder.encode("traice-delivery-envelope-v1"),
      name: "HKDF",
      salt: asArrayBuffer(salt),
    },
    material,
    { length: 256, name: "AES-GCM" },
    false,
    [usage]
  );
};

export const encryptForX25519Recipient = async (
  recipientPublicKey: string,
  plaintext: Uint8Array
): Promise<string> => {
  const recipient = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(base64UrlToBytes(recipientPublicKey)),
    "X25519",
    false,
    []
  );
  const ephemeral = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  if (!("privateKey" in ephemeral)) throw new Error("X25519 key generation failed");
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveRecipientKey(ephemeral.privateKey, recipient, salt, "encrypt");
  const ephemeralPublicKey = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      additionalData: encoder.encode(`traice.recipient-envelope/1:${ephemeralPublicKey}`),
      iv: asArrayBuffer(nonce),
      name: "AES-GCM",
    },
    key,
    asArrayBuffer(plaintext)
  ));
  const envelope: RecipientEnvelopeV1 = {
    ciphertext: bytesToBase64Url(ciphertext),
    ephemeralPublicKey,
    nonce: bytesToBase64Url(nonce),
    salt: bytesToBase64Url(salt),
    schema: "traice.recipient-envelope/1",
  };
  return bytesToBase64Url(encoder.encode(JSON.stringify(envelope)));
};

export const decryptFromX25519Recipient = async (
  recipientPrivateKey: CryptoKey,
  encodedEnvelope: string
): Promise<Uint8Array> => {
  const envelope = JSON.parse(
    decoder.decode(base64UrlToBytes(encodedEnvelope))
  ) as RecipientEnvelopeV1;
  if (envelope.schema !== "traice.recipient-envelope/1") throw new Error("Invalid recipient envelope");
  const ephemeral = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(base64UrlToBytes(envelope.ephemeralPublicKey)),
    "X25519",
    false,
    []
  );
  const key = await deriveRecipientKey(
    recipientPrivateKey,
    ephemeral,
    base64UrlToBytes(envelope.salt),
    "decrypt"
  );
  return new Uint8Array(await crypto.subtle.decrypt(
    {
      additionalData: encoder.encode(`traice.recipient-envelope/1:${envelope.ephemeralPublicKey}`),
      iv: asArrayBuffer(base64UrlToBytes(envelope.nonce)),
      name: "AES-GCM",
    },
    key,
    asArrayBuffer(base64UrlToBytes(envelope.ciphertext))
  ));
};
