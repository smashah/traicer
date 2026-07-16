import { sanitizeTransportHeaders } from "@traice/capture-core";
import type { CaptureProvider, ObservedProviderExchange } from "@traice/domain";
import { Hono } from "hono";

import type { CaptureRoute } from "./capture-routes";

export type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

const decodedResponseHeaders = (headers: Headers): Headers => {
  const result = safeHeaders(headers);
  // Bun's fetch decodes compressed upstream bodies before exposing them. Keeping
  // the upstream encoding or length makes clients decompress or truncate the
  // already-decoded stream.
  result.delete("content-encoding");
  result.delete("content-length");
  return result;
};

const parseBody = (text: string): unknown => {
  if (text.length === 0) return null;
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
          return { unparsed: true };
        }
      });
    return events.length > 0 ? { events } : { unparsed: true };
  }
};

const recordFromObject = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const numberFrom = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

const usageFrom = (value: unknown, depth = 0): Readonly<Record<string, unknown>> => {
  if (depth > 4) return {};
  const record = recordFromObject(value);
  const usage = recordFromObject(record.usage);
  if (Object.keys(usage).length > 0) return usage;
  const messageUsage = recordFromObject(recordFromObject(record.message).usage);
  if (Object.keys(messageUsage).length > 0) return messageUsage;
  const responseUsage = recordFromObject(recordFromObject(record.response).usage);
  if (Object.keys(responseUsage).length > 0) return responseUsage;
  if (Array.isArray(record.events)) {
    for (const event of [...record.events].reverse()) {
      const found = usageFrom(event, depth + 1);
      if (Object.keys(found).length > 0) return found;
    }
  }
  return {};
};

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
  readonly adapterCapability?: string;
  readonly capture: (exchange: ObservedProviderExchange) => Promise<void>;
  readonly captureEnabled: () => boolean;
  readonly client?: string;
  readonly fetchUpstream?: GatewayFetch;
  readonly resolveRoute?: (routeToken: string) => Promise<CaptureRoute | undefined>;
  readonly scheduler: GatewayScheduler;
  readonly upstreamOrigin: string;
}

interface ProviderGatewayConfig {
  readonly adapterForPath: (path: string) => string;
  readonly capturedPaths: ReadonlySet<string>;
  readonly forwardOnlyPaths: ReadonlySet<string>;
  readonly prefix: string;
  readonly provider: CaptureProvider;
}

const createProviderGateway = (
  dependencies: GatewayDependencies,
  config: ProviderGatewayConfig
) => {
  const upstream = new URL(dependencies.upstreamOrigin);
  if (
    upstream.protocol !== "https:" &&
    upstream.hostname !== "127.0.0.1" &&
    upstream.hostname !== "localhost"
  ) {
    throw new Error("The fixed model-provider upstream must use HTTPS outside loopback tests");
  }
  const send = dependencies.fetchUpstream ?? globalThis.fetch;
  const app = new Hono();

  app.all(`/${config.prefix}/:capability/v1/*`, async (context) => {
    const capability = context.req.param("capability");
    const route = await dependencies.resolveRoute?.(capability);
    const legacyAuthorized = dependencies.adapterCapability !== undefined &&
      capability === dependencies.adapterCapability;
    if (!route && !legacyAuthorized) {
      return context.json({ code: "INVALID_ADAPTER_CAPABILITY" }, 401);
    }
    if (route && !route.providers.includes(config.provider)) {
      return context.json({ code: "PROVIDER_NOT_AUTHORIZED" }, 403);
    }
    const providerPath = context.req.path.replace(`/${config.prefix}/${capability}`, "");
    const isModelLookup = providerPath.startsWith("/v1/models/");
    const captureEligible = config.capturedPaths.has(providerPath) && context.req.method === "POST";
    const forwardOnly =
      config.forwardOnlyPaths.has(providerPath) ||
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
      const safeRequestHeaders = sanitizeTransportHeaders(
        Object.fromEntries(context.req.raw.headers.entries())
      );
      const requestPayload = parseBody(requestBody);
      const requestRecord = recordFromObject(requestPayload);
      const model = typeof requestRecord.model === "string" ? requestRecord.model : "unknown";
      dependencies.scheduler.schedule(
        (async () => {
          const responsePayload = parseBody(await responseCopy.text());
          const usage = usageFrom(responsePayload);
          await dependencies.capture({
            adapter: config.adapterForPath(providerPath),
            capturedAt: new Date().toISOString(),
            ...(route ? {
              captureRunId: route.captureRunId,
              projectScopeId: route.projectScopeId,
            } : {}),
            client: route?.client ?? dependencies.client ?? "unknown",
            method: "POST",
            model,
            path: providerPath,
            provider: config.provider,
            requestBody: requestPayload,
            requestHeaders: safeRequestHeaders,
            responseBody: responsePayload,
            responseStatus: upstreamResponse.status,
            traceId: crypto.randomUUID(),
            usage: {
              inputTokens: numberFrom(usage.input_tokens ?? usage.prompt_tokens),
              outputTokens: numberFrom(usage.output_tokens ?? usage.completion_tokens),
            },
          });
        })().catch(() => undefined)
      );
    }

    return new Response(upstreamResponse.body, {
      headers: decodedResponseHeaders(upstreamResponse.headers),
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
    });
  });

  return app;
};

export const createOpenAiGateway = (dependencies: GatewayDependencies) =>
  createProviderGateway(dependencies, {
    adapterForPath: (path) =>
      path === "/v1/responses" ? "openai-responses/1" : "openai-chat-completions/1",
    capturedPaths: new Set(["/v1/chat/completions", "/v1/responses"]),
    forwardOnlyPaths: new Set(["/v1/embeddings", "/v1/models"]),
    prefix: "openai",
    provider: "openai",
  });

export const createAnthropicGateway = (dependencies: GatewayDependencies) =>
  createProviderGateway(dependencies, {
    adapterForPath: () => "anthropic-messages/1",
    capturedPaths: new Set(["/v1/messages"]),
    forwardOnlyPaths: new Set(["/v1/messages/count_tokens", "/v1/models"]),
    prefix: "anthropic",
    provider: "anthropic",
  });
