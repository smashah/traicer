import { describe, expect, test } from "bun:test";

import {
  constantTimeEqual,
  decryptTraceEnvelope,
  encryptTraceEnvelope,
  generateDeviceSigningKeyPair,
  sha256Hex,
  signBytes,
  verifyBytes,
} from "../src";

describe("crypto known-answer tests", () => {
  test("matches the NIST SHA-256 abc vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  test("compares capabilities without an early content exit", () => {
    expect(constantTimeEqual("same-capability", "same-capability")).toBe(true);
    expect(constantTimeEqual("same-capability", "other-capability")).toBe(false);
  });

  test("round-trips an authenticated per-trace envelope and rejects mutation", async () => {
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('{"safe":"canonical"}');
    const encrypted = await encryptTraceEnvelope({
      canonicalBytes: plaintext,
      traceId: "trace-test",
      wrappingKey,
    });

    expect(encrypted.bytes.slice(0, 4)).toEqual(new TextEncoder().encode("TRCE"));
    expect(await decryptTraceEnvelope({ envelope: encrypted.bytes, wrappingKey })).toEqual(
      plaintext
    );

    const mutated = encrypted.bytes.slice();
    const lastIndex = mutated.length - 1;
    mutated[lastIndex] = (mutated[lastIndex] ?? 0) ^ 1;
    await expect(decryptTraceEnvelope({ envelope: mutated, wrappingKey })).rejects.toThrow();
  });

  test("signs exact safe-manifest bytes with Ed25519", async () => {
    const keys = await generateDeviceSigningKeyPair();
    const bytes = new TextEncoder().encode('{"schema":"traice.manifest/1"}');
    const signature = await signBytes(keys.privateKey, bytes);

    expect(await verifyBytes(keys.publicKey, signature, bytes)).toBe(true);
    expect(
      await verifyBytes(
        keys.publicKey,
        signature,
        new TextEncoder().encode('{"schema":"traice.manifest/2"}')
      )
    ).toBe(false);
  });
});
