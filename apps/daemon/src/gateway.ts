import type { ObservedProviderExchange } from "@traice/domain";
import { Hono } from "hono";

export type GatewayFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const capturedPaths = new Set(["/v1/chat/completions", "/v1/responses"]);
const forwardOnlyPaths = new Set(["/v1/embeddings", "/v1/models"]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const safeHeaders = (headers: Headers): Headers => {
  const result = new Headers();
  for (const [name, value] of headers.entries()) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== "host") {
      result.set(name, value);
    }
  }
  return result;
};

const parseBody = (text: string): unknown => {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const events = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
      .map((line) => {
        const data = line.slice(5).trim();
        try {
          return JSON.parse(data) as unknown;
        } catch {
          return data;
        }
      });
    return events.length > 0 ? { events } : { unparsed: true };
  }
};

const recordFromObject = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" ? (value as Readonly<Record<string, unknown>>) : {};

const numberFrom = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

export interface GatewayScheduler {
  readonly drain: () => Promise<void>;
  readonly schedule: (job: Promise<void>) => void;
}

export const createGatewayScheduler = (): GatewayScheduler => {
  const pending = new Set<Promise<void>>();
  return {
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
    schedule: (job) => {
      pending.add(job);
      job.finally(() => pending.delete(job)).catch(() => undefined);
    },
  };
};

export interface GatewayDependencies {
  readonly adapterCapability: string;
  readonly capture: (exchange: ObservedProviderExchange) => Promise<void>;
  readonly captureEnabled: () => boolean;
  readonly client: string;
  readonly fetchUpstream?: GatewayFetch;
  readonly scheduler: GatewayScheduler;
  readonly upstreamOrigin: string;
}

export const createOpenAiGateway = (dependencies: GatewayDependencies) => {
  const upstream = new URL(dependencies.upstreamOrigin);
  if (upstream.protocol !== "https:" && upstream.hostname !== "127.0.0.1" && upstream.hostname !== "localhost") {
    throw new Error("The fixed model-provider upstream must use HTTPS outside loopback tests");
  }
  const send = dependencies.fetchUpstream ?? globalThis.fetch;
  const app = new Hono();

  app.all("/openai/:capability/v1/*", async (context) => {
    if (context.req.param("capability") !== dependencies.adapterCapability) {
      return context.json({ code: "INVALID_ADAPTER_CAPABILITY" }, 401);
    }
    const providerPath = context.req.path.replace(
      `/openai/${dependencies.adapterCapability}`,
      ""
    );
    const isModelLookup = providerPath.startsWith("/v1/models/");
    const captureEligible = capturedPaths.has(providerPath) && context.req.method === "POST";
    const forwardOnly =
      forwardOnlyPaths.has(providerPath) ||
      isModelLookup ||
      (providerPath === "/v1/models" && context.req.method === "GET");
    if (!captureEligible && !forwardOnly) {
      return context.json({ code: "UNSUPPORTED_PROVIDER_ROUTE" }, 404);
    }

    const requestBody = context.req.method === "GET" ? "" : await context.req.raw.text();
    const target = new URL(providerPath, upstream);
    const upstreamResponse = await send(target, {
      ...(requestBody.length > 0 ? { body: requestBody } : {}),
      headers: safeHeaders(context.req.raw.headers),
      method: context.req.method,
      redirect: "manual",
    });

    if (captureEligible && dependencies.captureEnabled()) {
      const responseCopy = upstreamResponse.clone();
      const requestPayload = parseBody(requestBody);
      const requestRecord = recordFromObject(requestPayload);
      const model = typeof requestRecord.model === "string" ? requestRecord.model : "unknown";
      const traceId = crypto.randomUUID();
      dependencies.scheduler.schedule(
        (async () => {
          const responsePayload = parseBody(await responseCopy.text());
          const responseRecord = recordFromObject(responsePayload);
          const usage = recordFromObject(responseRecord.usage);
          await dependencies.capture({
            adapter:
              providerPath === "/v1/responses"
                ? "openai-responses/1"
                : "openai-chat-completions/1",
            capturedAt: new Date().toISOString(),
            client: dependencies.client,
            method: "POST",
            model,
            path: providerPath,
            provider: "openai",
            requestBody: requestPayload,
            requestHeaders: Object.fromEntries(context.req.raw.headers.entries()),
            responseBody: responsePayload,
            responseStatus: upstreamResponse.status,
            traceId,
            usage: {
              inputTokens: numberFrom(usage.input_tokens ?? usage.prompt_tokens),
              outputTokens: numberFrom(usage.output_tokens ?? usage.completion_tokens),
            },
          });
        })().catch(() => undefined)
      );
    }

    return new Response(upstreamResponse.body, {
      headers: safeHeaders(upstreamResponse.headers),
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
    });
  });

  return app;
};
