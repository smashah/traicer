import { afterEach, describe, expect, test } from "bun:test";

import { sha256Hex } from "@traice/crypto";

import { createS3CompatibleObjectStore } from "../src";

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("S3-compatible storage", () => {
  test("SigV4 client uploads, heads, reads back, presigns and deletes ciphertext", async () => {
    const objects = new Map<string, { bytes: Uint8Array; digest: string }>();
    const server = Bun.serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        const key = url.pathname;
        if (request.method === "PUT") {
          const bytes = new Uint8Array(await request.arrayBuffer());
          const digest = request.headers.get("x-amz-meta-traice-sha256") ?? "";
          objects.set(key, { bytes, digest });
          return new Response(null, { headers: { etag: '"fixture-etag"' }, status: 200 });
        }
        const object = objects.get(key);
        if (request.method === "HEAD" && object) {
          return new Response(null, {
            headers: {
              "content-length": String(object.bytes.byteLength),
              "x-amz-meta-traice-sha256": object.digest,
            },
            status: 200,
          });
        }
        if (request.method === "GET" && object) {
          return new Response(Uint8Array.from(object.bytes).buffer, { status: 200 });
        }
        if (request.method === "DELETE") {
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        return new Response("<Error><Code>NoSuchKey</Code></Error>", {
          headers: { "content-type": "application/xml" },
          status: 404,
        });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const store = createS3CompatibleObjectStore(
      {
        addressingStyle: "path",
        bucket: "seller-bucket",
        endpoint: `http://127.0.0.1:${server.port}`,
        prefix: "traice",
        signingRegion: "auto",
        storageCapabilityProfileId: "loopback-s3-v1",
      },
      { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" }
    );
    const bytes = crypto.getRandomValues(new Uint8Array(128));
    const ciphertextHash = await sha256Hex(bytes);
    const receipt = await store.putEnvelope({ bytes, ciphertextHash });

    expect(receipt.integrityAssurance).toBe("full_readback");
    expect(receipt.encryptedBytes).toBe(bytes.byteLength);
    expect(objects.size).toBe(1);
    const signedUrl = await store.presignGet(ciphertextHash, 120);
    expect(signedUrl).toContain("X-Amz-Signature=");
    await store.deleteEnvelope(ciphertextHash);
    expect(objects.size).toBe(0);
    const probe = await store.probe();
    expect(probe.checks).toEqual({
      capabilityCreate: true,
      capabilityExpire: true,
      delete: true,
      head: true,
      readIntegrity: true,
      write: true,
    });
    expect(objects.size).toBe(0);
  });
});
