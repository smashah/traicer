import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  CanonicalTraceSchema,
  OTEL_GENAI_SEMCONV_COMMIT,
  OTEL_GENAI_SCHEMA_URL,
} from "../src";

const validTrace = {
  schema: "traice.otel-genai.trace/1",
  schemaUrl: OTEL_GENAI_SCHEMA_URL,
  semconvCommit: OTEL_GENAI_SEMCONV_COMMIT,
  span: {
    attributes: {
      "gen_ai.input.messages": [{ parts: [{ content: "hello", type: "text" }], role: "user" }],
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-test",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 1,
    },
    kind: "CLIENT",
    name: "chat gpt-test",
  },
  traice: {
    adapter: "openai-responses/1",
    capturedAt: "2026-08-05T12:00:00.000Z",
    client: "test",
    pipelineVersion: "otel-genai/1",
    provenance: "provider_exchange",
    providerRequest: {},
    providerResponse: { body: {}, statusCode: 200 },
    redaction: { detectorVersion: "builtin/1", profile: "strict", replacements: {} },
    traceId: "trace-1",
  },
} as const;

describe("CanonicalTraceSchema", () => {
  test("accepts a structured OTel GenAI message", () => {
    expect(() => Schema.decodeUnknownSync(CanonicalTraceSchema)(validTrace)).not.toThrow();
  });

  test("rejects malformed messages and an unversioned pipeline", () => {
    expect(() => Schema.decodeUnknownSync(CanonicalTraceSchema)({
      ...validTrace,
      span: {
        ...validTrace.span,
        attributes: { ...validTrace.span.attributes, "gen_ai.input.messages": [{ bogus: true }] },
      },
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(CanonicalTraceSchema)({
      ...validTrace,
      traice: { ...validTrace.traice, pipelineVersion: "wrong/1" },
    })).toThrow();
  });
});
