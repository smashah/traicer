import { describe, expect, test } from "bun:test";

import type { ObservedProviderExchange } from "@traice/domain";

import { createGatewayScheduler, createOpenAiGateway } from "../src/gateway";

describe("OpenAI-compatible fixed-upstream gateway", () => {
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
