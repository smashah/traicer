import { describe, expect, test } from "bun:test";

import type { CapturePolicyV1, ObservedProviderExchange } from "@traice/domain";

import {
  canonicalJson,
  containsKnownSecret,
  redactExchange,
  stripTransportSecrets,
} from "../src";

const policy: CapturePolicyV1 = {
  allowedMethods: ["POST"],
  allowedPaths: ["/v1/responses"],
  capturePolicyId: "policy-test",
  pipelineVersion: "pipeline/1",
  policyVersion: "policy/1",
  redactionProfile: "strict-default",
  schema: "traice.capture-policy/1",
  successfulResponsesOnly: true,
};

const observed: ObservedProviderExchange = {
  adapter: "openai-responses/1",
  capturedAt: "2026-07-13T12:00:00.000Z",
  client: "codex",
  method: "POST",
  model: "gpt-test",
  path: "/v1/responses",
  provider: "openai",
  requestBody: {
    authorization: "sk-this-must-go",
    input: "email me at seller@example.com using sk-abcdefghijklmnop",
  },
  requestHeaders: { Authorization: "Bearer provider-secret", "content-type": "application/json" },
  responseBody: { output: [{ text: "safe synthetic response" }] },
  responseStatus: 200,
  traceId: "trace-test",
  usage: { inputTokens: 4, outputTokens: 3 },
};

describe("privacy pipeline", () => {
  test("strips transport credentials before capture values are built", () => {
    expect(stripTransportSecrets(observed.requestHeaders)).toEqual({
      "content-type": "application/json",
    });
  });

  test("redacts structured and string secrets before deterministic canonicalisation", () => {
    const first = redactExchange(observed, policy);
    const second = redactExchange(observed, policy);
    const encoded = canonicalJson(first.trace);

    expect(canonicalJson(second.trace)).toBe(encoded);
    expect(encoded).not.toContain("provider-secret");
    expect(encoded).not.toContain("seller@example.com");
    expect(encoded).not.toContain("sk-abcdefghijklmnop");
    expect(containsKnownSecret(encoded)).toBe(false);
    expect(first.report.replacements).toEqual({
      EMAIL: 1,
      OPENAI_KEY: 1,
      SECRET_FIELD: 1,
    });
  });

  test("rejects capture outside the exact method/path policy", () => {
    expect(() => redactExchange({ ...observed, path: "/v1/files" }, policy)).toThrow(
      "Capture policy rejected"
    );
  });

  test("rejects provider errors when inventory is restricted to successful responses", () => {
    expect(() => redactExchange({ ...observed, responseStatus: 429 }, policy)).toThrow(
      "Capture policy rejected"
    );
  });
});
