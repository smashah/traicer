import { afterEach, describe, expect, test } from "bun:test";

import type { CaptureBootstrapV2 } from "@traice/api-contract";
import {
  bytesToBase64Url,
  decryptTraceEnvelope,
  generateDeviceSigningKeyPair,
} from "@traice/crypto";
import { openOperationalState } from "@traice/state-sqlite";

import { createCaptureRuntime } from "../src/runtime";

const servers: Bun.Server<undefined>[] = [];
const databasePaths: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const path of databasePaths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      Bun.file(`${path}${suffix}`).delete().catch(() => undefined);
    }
  }
});

describe("daemon capture runtime", () => {
  test("captures to encrypted seller storage while marketplace requests remain unavailable", async () => {
    const objects = new Map<string, Uint8Array>();
    const storage = Bun.serve({
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "PUT") {
          objects.set(path, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { headers: { etag: '"fixture"' } });
        }
        const bytes = objects.get(path);
        if (request.method === "HEAD" && bytes) {
          return new Response(null, {
            headers: {
              "content-length": String(bytes.byteLength),
              "x-amz-meta-traice-sha256":
                request.headers.get("x-amz-meta-traice-sha256") ?? path.match(/[a-f0-9]{64}/)?.[0] ?? "",
            },
          });
        }
        if (request.method === "GET" && bytes) {
          return new Response(Uint8Array.from(bytes).buffer);
        }
        if (request.method === "DELETE") {
          objects.delete(path);
          return new Response(null, { status: 204 });
        }
        return new Response("missing", { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(storage);

    const keys = await generateDeviceSigningKeyPair();
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const databasePath = `/tmp/traicer-runtime-${crypto.randomUUID()}.db`;
    databasePaths.push(databasePath);
    const state = openOperationalState(databasePath);
    const submittedBodies: unknown[] = [];
    const bootstrap: CaptureBootstrapV2 = {
      adapters: [{
        allowedPaths: ["/v1/responses"],
        provider: "openai",
        upstreamOrigin: "https://api.openai.com",
      }],
      bucketAlias: "seller-store-01",
      deviceId: crypto.randomUUID(),
      marketplace: {
        apiBaseUrl: "https://api.traice.market",
        credential: "manifest-capability-secret",
      },
      policy: {
        capturePolicyId: crypto.randomUUID(),
        pipelineVersion: "pipeline/1",
        policyVersion: "policy/1",
        redactionProfile: "strict-default",
      },
      signerKeyId: keys.keyId,
      signingPrivateKey: keys.privateKey,
      storage: {
        accessKeyId: "fixture-access",
        addressingStyle: "path",
        bucket: "seller-bucket",
        endpoint: `http://127.0.0.1:${storage.port}`,
        prefix: "traice",
        secretAccessKey: "fixture-secret",
        signingRegion: "auto",
        storageCapabilityProfileId: "loopback-s3-v1",
      },
    };
    const runtime = createCaptureRuntime(
      bootstrap,
      bytesToBase64Url(wrappingKey),
      state,
      {
        marketplaceFetch: async (request) => {
          const parsed = await request.clone().json();
          submittedBodies.push(parsed);
          expect(request.headers.get("authorization")).toBe(
            "Bearer manifest-capability-secret"
          );
          return new Response(JSON.stringify({ code: "MARKETPLACE_UNAVAILABLE" }), { status: 503 });
        },
        resolveRoute: async (token) => token === "scoped-route" ? {
          captureRunId: "22222222-2222-4222-8222-222222222222",
          client: "codex",
          expiresAt: "2030-01-01T00:00:00.000Z",
          projectScopeId: "33333333-3333-4333-8333-333333333333",
          providers: ["openai"],
          routeId: "11111111-1111-4111-8111-111111111111",
        } : undefined,
        upstreamFetch: async () =>
          new Response(
            JSON.stringify({
              output: [{ content: "synthetic provider output" }],
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
            { headers: { "content-type": "application/json" } }
          ),
      }
    );
    await runtime.initialize();

    const response = await runtime.gateway.request(
      "http://127.0.0.1/openai/scoped-route/v1/responses",
      {
        body: JSON.stringify({
          api_key: "sk-abcdefghijklmnop",
          input: "RAW_CANARY_DO_NOT_EGRESS seller@example.com",
          model: "gpt-test",
        }),
        headers: {
          authorization: "Bearer provider-secret",
          "content-type": "application/json",
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [{ content: "synthetic provider output" }],
    });
    await runtime.scheduler.drain();

    expect(objects.size).toBe(1);
    const encrypted = objects.values().next().value;
    expect(encrypted).toBeDefined();
    if (!encrypted) {
      throw new Error("Expected seller ciphertext");
    }
    const plaintext = new TextDecoder().decode(
      await decryptTraceEnvelope({ envelope: encrypted, wrappingKey })
    );
    expect(plaintext).toContain("RAW_CANARY_DO_NOT_EGRESS");
    expect(plaintext).toContain('"captureRunId":"22222222-2222-4222-8222-222222222222"');
    expect(plaintext).not.toContain("seller@example.com");
    expect(plaintext).not.toContain("sk-abcdefghijklmnop");
    expect(state.counts()).toEqual({ committed: 0, pending: 1 });
    expect(state.traces(10, 0)[0]?.state).toBe("manifest_pending");
    const egress = JSON.stringify(submittedBodies);
    expect(egress).not.toContain("RAW_CANARY_DO_NOT_EGRESS");
    expect(egress).not.toContain("provider-secret");
    expect(egress).not.toContain("manifest-capability-secret");
    expect(egress).not.toContain("seller@example.com");
    expect(egress).toContain('"projectScopeId":"33333333-3333-4333-8333-333333333333"');
    expect(egress).not.toContain("22222222-2222-4222-8222-222222222222");
    state.close();
  });
});
