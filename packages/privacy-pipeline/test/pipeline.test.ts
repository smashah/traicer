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
  pipelineVersion: "otel-genai/1",
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
  responseBody: {
    id: "resp_fixture",
    model: "gpt-test-2026-08-01",
    output: [{
      content: [{ text: "safe synthetic response", type: "output_text" }],
      role: "assistant",
      type: "message",
    }],
    status: "completed",
  },
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

  test("maps a provider exchange to the OTel GenAI canonical span and survives a JSON round trip byte-for-byte", () => {
    const rich = redactExchange({
      ...observed,
      requestBody: {
        input: [{
          content: [{ text: "Weather in Paris?", type: "input_text" }],
          role: "user",
          type: "message",
        }],
        instructions: "Use tools when needed",
        model: "gpt-test",
        stream: false,
        temperature: 0.25,
        tools: [{
          description: "Get weather",
          name: "get_weather",
          parameters: { properties: { city: { type: "string" } }, type: "object" },
          type: "function",
        }],
      },
    }, policy).trace;
    const first = canonicalJson(rich);
    const second = canonicalJson(redactExchange({
      ...observed,
      requestBody: {
        input: [{
          content: [{ text: "Weather in Paris?", type: "input_text" }],
          role: "user",
          type: "message",
        }],
        instructions: "Use tools when needed",
        model: "gpt-test",
        stream: false,
        temperature: 0.25,
        tools: [{
          description: "Get weather",
          name: "get_weather",
          parameters: { properties: { city: { type: "string" } }, type: "object" },
          type: "function",
        }],
      },
    }, policy).trace);

    expect(rich).toMatchObject({
      schema: "traice.otel-genai.trace/1",
      schemaUrl: "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev",
      semconvCommit: "b694ec35855d8eccfacd5b09e4b72a808b363038",
      span: {
        attributes: {
          "gen_ai.input.messages": [{
            parts: [{ content: "Weather in Paris?", type: "text" }],
            role: "user",
          }],
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": [{
            finish_reason: "stop",
            parts: [{ content: "safe synthetic response", type: "text" }],
            role: "assistant",
          }],
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-test",
          "gen_ai.request.stream": false,
          "gen_ai.request.temperature": 0.25,
          "gen_ai.response.finish_reasons": ["stop"],
          "gen_ai.response.id": "resp_fixture",
          "gen_ai.response.model": "gpt-test-2026-08-01",
          "gen_ai.tool.definitions": [{
            description: "Get weather",
            name: "get_weather",
            parameters: { properties: { city: { type: "string" } }, type: "object" },
            type: "function",
          }],
          "gen_ai.usage.input_tokens": 4,
          "gen_ai.usage.output_tokens": 3,
          "openai.api.type": "responses",
        },
        kind: "CLIENT",
        name: "chat gpt-test",
      },
      traice: {
        adapter: "openai-responses/1",
        pipelineVersion: "otel-genai/1",
        provenance: "provider_exchange",
        traceId: "trace-test",
      },
    });
    expect(second).toBe(first);
    expect(canonicalJson(JSON.parse(first))).toBe(first);
  });

  test("maps Anthropic messages, tool calls, finish reason, and detailed token usage", () => {
    const trace = redactExchange({
      ...observed,
      adapter: "anthropic-messages/1",
      model: "claude-test",
      path: "/v1/messages",
      provider: "anthropic",
      requestBody: {
        messages: [{
          content: [{ content: "sunny", tool_use_id: "tool-1", type: "tool_result" }],
          role: "user",
        }],
        model: "claude-test",
        system: "Use the weather tool",
        tools: [{
          description: "Get weather",
          input_schema: { properties: { city: { type: "string" } }, type: "object" },
          name: "get_weather",
        }],
      },
      responseBody: {
        content: [{ id: "tool-1", input: { city: "Paris" }, name: "get_weather", type: "tool_use" }],
        id: "msg_fixture",
        model: "claude-test-20260801",
        stop_reason: "tool_use",
      },
      usage: {
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        inputTokens: 8,
        outputTokens: 5,
        reasoningOutputTokens: 1,
      },
    }, { ...policy, allowedPaths: ["/v1/messages"] }).trace;

    expect(trace.span.attributes).toMatchObject({
      "gen_ai.input.messages": [{
        parts: [{ id: "tool-1", response: "sunny", type: "tool_call_response" }],
        role: "tool",
      }],
      "gen_ai.output.messages": [{
        finish_reason: "tool_use",
        parts: [{ arguments: { city: "Paris" }, id: "tool-1", name: "get_weather", type: "tool_call" }],
        role: "assistant",
      }],
      "gen_ai.provider.name": "anthropic",
      "gen_ai.response.finish_reasons": ["tool_use"],
      "gen_ai.response.model": "claude-test-20260801",
      "gen_ai.system_instructions": [{ content: "Use the weather tool", type: "text" }],
      "gen_ai.tool.definitions": [{ name: "get_weather", type: "function" }],
      "gen_ai.usage.cache_creation.input_tokens": 2,
      "gen_ai.usage.cache_read.input_tokens": 3,
      "gen_ai.usage.reasoning.output_tokens": 1,
    });
  });

  test("preserves one finish reason per output choice, including duplicates", () => {
    const trace = redactExchange({
      ...observed,
      adapter: "openai-chat-completions/1",
      responseBody: {
        choices: [
          { finish_reason: "stop", message: { content: "first", role: "assistant" } },
          { finish_reason: "stop", message: { content: "second", role: "assistant" } },
        ],
      },
    }, policy).trace;

    expect(trace.span.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop", "stop"]);
  });

  test("maps OpenAI Chat tool results to tool-call response parts", () => {
    const trace = redactExchange({
      ...observed,
      adapter: "openai-chat-completions/1",
      requestBody: {
        messages: [{ content: "sunny", role: "tool", tool_call_id: "call-1" }],
        model: "gpt-test",
      },
    }, policy).trace;

    expect(trace.span.attributes["gen_ai.input.messages"]).toEqual([{
      parts: [{ id: "call-1", response: "sunny", type: "tool_call_response" }],
      role: "tool",
    }]);
  });

  test("redacts the model before it enters canonical bytes", () => {
    const trace = redactExchange({
      ...observed,
      model: "sk-abcdefghijklmnop",
      requestBody: { input: "safe" },
    }, policy).trace;

    const encoded = canonicalJson(trace);
    expect(encoded).not.toContain("sk-abcdefghijklmnop");
    expect(trace.span.attributes["gen_ai.request.model"]).toBe("<REDACTED:OPENAI_KEY:1>");
  });

  test("rejects a policy carrying a different canonical pipeline marker", () => {
    expect(() => redactExchange(observed, {
      ...policy,
      pipelineVersion: "wrong/1",
    } as unknown as CapturePolicyV1)).toThrow("pipeline marker");
  });

  test("rejects capture outside the exact method/path policy", () => {
    expect(() => redactExchange({ ...observed, path: "/v1/files" }, policy)).toThrow(
      "Capture policy rejected"
    );
  });

  test("puts only opaque project and run identifiers in scoped traces", () => {
    const scoped = redactExchange({
      ...observed,
      captureRunId: "22222222-2222-4222-8222-222222222222",
      projectScopeId: "33333333-3333-4333-8333-333333333333",
    }, policy).trace;
    expect(scoped).toMatchObject({
      schema: "traice.otel-genai.trace/1",
      traice: {
        captureRunId: "22222222-2222-4222-8222-222222222222",
        projectScopeId: "33333333-3333-4333-8333-333333333333",
      },
    });
  });

  test("rejects a partial scoped context", () => {
    expect(() => redactExchange({
      ...observed,
      projectScopeId: "33333333-3333-4333-8333-333333333333",
    }, policy)).toThrow("requires both");
  });

  test("rejects provider errors when inventory is restricted to successful responses", () => {
    expect(() => redactExchange({ ...observed, responseStatus: 429 }, policy)).toThrow(
      "Capture policy rejected"
    );
  });
});
