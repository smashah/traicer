import { describe, expect, test } from "bun:test";

import type { ObservedProviderExchange } from "@traice/domain";

import {
  createAnthropicGateway,
  createGatewayScheduler,
  createOpenAiGateway,
} from "../src/gateway";

describe("OpenAI-compatible fixed-upstream gateway", () => {
  test("binds captures to the project-scoped route context", async () => {
    const scheduler = createGatewayScheduler();
    const captures: ObservedProviderExchange[] = [];
    const app = createOpenAiGateway({
      capture: async (exchange) => {
        captures.push(exchange);
      },
      captureEnabled: () => true,
      fetchUpstream: async () => new Response(JSON.stringify({ usage: {} })),
      resolveRoute: async (token) => token === "scoped-token" ? {
        captureRunId: "22222222-2222-4222-8222-222222222222",
        client: "codex",
        expiresAt: "2030-01-01T00:00:00.000Z",
        projectScopeId: "33333333-3333-4333-8333-333333333333",
        providers: ["openai"],
        routeId: "11111111-1111-4111-8111-111111111111",
      } : undefined,
      scheduler,
      upstreamOrigin: "https://api.openai.com",
    });
    const response = await app.request("http://127.0.0.1/openai/scoped-token/v1/responses", {
      body: JSON.stringify({ model: "gpt-test" }),
      method: "POST",
    });
    await scheduler.drain();

    expect(response.status).toBe(200);
    expect(captures[0]).toMatchObject({
      captureRunId: "22222222-2222-4222-8222-222222222222",
      client: "codex",
      projectScopeId: "33333333-3333-4333-8333-333333333333",
    });
  });

  test("preserves provider response and captures an eligible synthetic exchange", async () => {
    const scheduler = createGatewayScheduler();
    const captures: ObservedProviderExchange[] = [];
    let upstreamRequest: Request | undefined;
    const app = createOpenAiGateway({
      adapterCapability: "local-capability",
      capture: async (exchange) => {
        captures.push(exchange);
      },
      captureEnabled: () => true,
      client: "codex",
      fetchUpstream: async (input, init) => {
        upstreamRequest = new Request(input, init);
        return new Response(
          'data: {"type":"response.completed","response":{"id":"synthetic"},"usage":{"input_tokens":2,"output_tokens":3}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" }, status: 200 }
        );
      },
      scheduler,
      upstreamOrigin: "https://api.openai.com",
    });
    const response = await app.request(
      "http://127.0.0.1/openai/local-capability/v1/responses",
      {
        body: JSON.stringify({ input: "synthetic", model: "gpt-test", stream: true }),
        headers: { authorization: "Bearer provider-secret", "content-type": "application/json" },
        method: "POST",
      }
    );
    const body = await response.text();
    await scheduler.drain();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(upstreamRequest?.url).toBe("https://api.openai.com/v1/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer provider-secret");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.path).toBe("/v1/responses");
  });

  test("fails open for provider forwarding when persistence fails", async () => {
    const scheduler = createGatewayScheduler();
    const app = createOpenAiGateway({
      adapterCapability: "local-capability",
      capture: async () => {
        throw new Error("synthetic persistence failure");
      },
      captureEnabled: () => true,
      client: "codex",
      fetchUpstream: async () => new Response(JSON.stringify({ id: "provider-response" })),
      scheduler,
      upstreamOrigin: "https://api.openai.com",
    });
    const response = await app.request(
      "http://127.0.0.1/openai/local-capability/v1/chat/completions",
      {
        body: JSON.stringify({ messages: [], model: "gpt-test" }),
        headers: { authorization: "Bearer provider-secret", "content-type": "application/json" },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "provider-response" });
    await scheduler.drain();
  });

  test("rejects unknown capabilities and arbitrary provider paths", async () => {
    const scheduler = createGatewayScheduler();
    const app = createOpenAiGateway({
      adapterCapability: "local-capability",
      capture: async () => undefined,
      captureEnabled: () => true,
      client: "codex",
      fetchUpstream: async () => new Response("unexpected"),
      scheduler,
      upstreamOrigin: "https://api.openai.com",
    });
    expect(
      (await app.request("http://127.0.0.1/openai/wrong/v1/responses", { method: "POST" })).status
    ).toBe(401);
    expect(
      (
        await app.request("http://127.0.0.1/openai/local-capability/v1/files", {
          method: "POST",
        })
      ).status
    ).toBe(404);
  });
});

describe("Anthropic fixed-upstream gateway", () => {
  test("removes upstream compression metadata after Bun decodes the response body", async () => {
    const scheduler = createGatewayScheduler();
    const app = createAnthropicGateway({
      adapterCapability: "anthropic-local-capability",
      capture: async () => undefined,
      captureEnabled: () => true,
      client: "claude-code",
      fetchUpstream: async () => new Response("decoded provider response", {
        headers: {
          "content-encoding": "gzip",
          "content-length": "42",
          "content-type": "application/json",
        },
      }),
      scheduler,
      upstreamOrigin: "https://api.anthropic.com",
    });
    const response = await app.request(
      "http://127.0.0.1/anthropic/anthropic-local-capability/v1/messages",
      {
        body: JSON.stringify({ messages: [], model: "claude-test" }),
        method: "POST",
      }
    );

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("decoded provider response");
    await scheduler.drain();
  });

  test("preserves Messages streaming and captures sanitised usage", async () => {
    const scheduler = createGatewayScheduler();
    const captures: ObservedProviderExchange[] = [];
    let forwarded: Request | undefined;
    const app = createAnthropicGateway({
      adapterCapability: "anthropic-local-capability",
      capture: async (exchange) => {
        captures.push(exchange);
      },
      captureEnabled: () => true,
      client: "claude-code",
      fetchUpstream: async (input, init) => {
        forwarded = new Request(input, init);
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
          { headers: { "content-type": "text/event-stream" }, status: 200 }
        );
      },
      scheduler,
      upstreamOrigin: "https://api.anthropic.com",
    });
    const response = await app.request(
      "http://127.0.0.1/anthropic/anthropic-local-capability/v1/messages",
      {
        body: JSON.stringify({ messages: [{ content: "synthetic", role: "user" }], model: "claude-test", stream: true }),
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": "provider-secret",
        },
        method: "POST",
      }
    );
    await response.text();
    await scheduler.drain();

    expect(forwarded?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(forwarded?.headers.get("x-api-key")).toBe("provider-secret");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      adapter: "anthropic-messages/1",
      model: "claude-test",
      provider: "anthropic",
    });
    expect(captures[0]?.requestHeaders).not.toHaveProperty("x-api-key");
  });
});
