import {
  CANONICAL_TRACE_SCHEMA,
  OTEL_GENAI_SEMCONV_COMMIT,
  OTEL_GENAI_SCHEMA_URL,
  type CanonicalTrace,
  type CapturePolicyV1,
  type GenAiInputMessage,
  type GenAiMessagePart,
  type GenAiOutputMessage,
  type GenAiSpanAttributes,
  type GenAiToolDefinition,
  type ObservedProviderExchange,
  type RedactionReport,
} from "@traice/domain";

const encoder = new TextEncoder();

const forbiddenHeaderNames = new Set([
  "authorization",
  "cookie",
  "openai-organization",
  "openai-project",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

const forbiddenKeyPattern =
  /(^|_)(api_?key|authorization|cookie|credential|password|private_?key|secret|session|token)($|_)/i;

const detectors: ReadonlyArray<{
  readonly category: string;
  readonly pattern: RegExp;
}> = [
  { category: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { category: "OPENAI_KEY", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { category: "AWS_KEY", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { category: "JWT", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { category: "DATABASE_URL", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/g },
  { category: "EMAIL", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
];

const increment = (counts: Record<string, number>, category: string): string => {
  const next = (counts[category] ?? 0) + 1;
  counts[category] = next;
  return `<REDACTED:${category}:${next}>`;
};

const redactString = (value: string, counts: Record<string, number>): string => {
  let redacted = value;
  for (const detector of detectors) {
    redacted = redacted.replace(detector.pattern, () => increment(counts, detector.category));
  }
  return redacted;
};

const redactUnknown = (
  value: unknown,
  counts: Record<string, number>,
  seen: WeakSet<object>
): unknown => {
  if (typeof value === "string") {
    return redactString(value, counts);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite numbers cannot enter a canonical trace");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error("Cyclic provider payload");
    }
    seen.add(value);
    const result = value.map((item) => redactUnknown(item, counts, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new Error("Cyclic provider payload");
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = forbiddenKeyPattern.test(key)
        ? increment(counts, "SECRET_FIELD")
        : redactUnknown(item, counts, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error(`Unsupported provider payload value: ${typeof value}`);
};

export const stripTransportSecrets = (
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!forbiddenHeaderNames.has(normalized) && !forbiddenKeyPattern.test(normalized)) {
      safe[normalized] = value;
    }
  }
  return safe;
};

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite number in canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
};

export const canonicalBytes = (value: unknown): Uint8Array => encoder.encode(canonicalJson(value));

const recordFrom = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const finiteNumberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const integerFrom = (value: unknown): number | undefined => {
  const number = finiteNumberFrom(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
};

const structuredFrom = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const messageParts = (value: unknown): readonly GenAiMessagePart[] => {
  if (typeof value === "string") return [{ content: value, type: "text" }];
  if (Array.isArray(value)) return value.flatMap(messageParts);
  const record = recordFrom(value);
  const type = stringFrom(record.type);
  const text = stringFrom(record.text) ?? (
    typeof record.content === "string" && ["input_text", "output_text", "text"].includes(type ?? "")
      ? record.content
      : undefined
  );
  if (text !== undefined) return [{ content: text, type: "text" }];

  const functionCall = recordFrom(record.function);
  const functionName = stringFrom(functionCall.name) ?? stringFrom(record.name);
  if ((type === "function_call" || type === "tool_use" || type === "function") && functionName) {
    const id = stringFrom(record.call_id) ?? stringFrom(record.id);
    const argumentsValue = record.arguments ?? record.input ?? functionCall.arguments;
    return [{
      ...(argumentsValue === undefined ? {} : { arguments: structuredFrom(argumentsValue) }),
      ...(id === undefined ? {} : { id }),
      name: functionName,
      type: "tool_call",
    }];
  }
  if (type === "function_call_output" || type === "tool_result") {
    const id = stringFrom(record.call_id) ?? stringFrom(record.tool_use_id) ?? stringFrom(record.id);
    const responseValue = record.output ?? record.content;
    if (responseValue === undefined) return [{ ...record, type } as GenAiMessagePart];
    return [{
      ...(id === undefined ? {} : { id }),
      response: structuredFrom(responseValue),
      type: "tool_call_response",
    }];
  }
  if (Array.isArray(record.content)) return messageParts(record.content);
  return type === undefined ? [] : [{ ...record, type } as GenAiMessagePart];
};

const inputMessage = (value: unknown, fallbackRole = "user"): GenAiInputMessage | undefined => {
  if (typeof value === "string") return { parts: messageParts(value), role: fallbackRole };
  const record = recordFrom(value);
  const role = stringFrom(record.role) ?? (
    record.type === "function_call_output" || record.type === "tool_result" ? "tool" : fallbackRole
  );
  const parts = [
    ...messageParts(record.content ?? record.output ?? record.input),
    ...(Array.isArray(record.tool_calls) ? record.tool_calls.flatMap(messageParts) : []),
    ...(["function_call", "function_call_output", "tool_use", "tool_result"].includes(String(record.type))
      ? messageParts(record)
      : []),
  ];
  if (parts.length === 0) return undefined;
  const name = stringFrom(record.name);
  return { ...(name === undefined ? {} : { name }), parts, role };
};

const inputMessages = (request: Readonly<Record<string, unknown>>): readonly GenAiInputMessage[] => {
  const source = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input)
      ? request.input
      : request.input === undefined
        ? []
        : [request.input];
  return source.flatMap((value) => {
    const message = inputMessage(value);
    return message === undefined ? [] : [message];
  });
};

const systemInstructions = (
  request: Readonly<Record<string, unknown>>
): readonly GenAiMessagePart[] => messageParts(request.instructions ?? request.system);

const toolDefinitions = (
  request: Readonly<Record<string, unknown>>
): readonly GenAiToolDefinition[] => !Array.isArray(request.tools) ? [] : request.tools.flatMap((value) => {
  const tool = recordFrom(value);
  const functionTool = recordFrom(tool.function);
  const name = stringFrom(functionTool.name) ?? stringFrom(tool.name);
  const type = stringFrom(tool.type) ?? "function";
  if (name === undefined) return [];
  const description = stringFrom(functionTool.description) ?? stringFrom(tool.description);
  const parameters = functionTool.parameters ?? tool.parameters ?? tool.input_schema;
  return [{
    ...(description === undefined ? {} : { description }),
    name,
    ...(parameters === undefined ? {} : { parameters }),
    type,
  }];
});

const responseRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  const record = recordFrom(value);
  if (!Array.isArray(record.events)) return record;
  for (const event of [...record.events].reverse()) {
    const nested = recordFrom(recordFrom(event).response);
    if (Object.keys(nested).length > 0) return nested;
  }
  return record;
};

const finishReason = (response: Readonly<Record<string, unknown>>): string => {
  const direct = stringFrom(response.stop_reason) ?? stringFrom(response.finish_reason);
  if (direct) return direct;
  const status = stringFrom(response.status);
  if (status === "completed") return "stop";
  if (status === "incomplete") {
    return stringFrom(recordFrom(response.incomplete_details).reason) ?? "incomplete";
  }
  return status ?? "unknown";
};

const outputMessages = (
  response: Readonly<Record<string, unknown>>
): readonly GenAiOutputMessage[] => {
  if (Array.isArray(response.choices)) {
    return response.choices.flatMap((choice) => {
      const choiceRecord = recordFrom(choice);
      const message = inputMessage(choiceRecord.message ?? choiceRecord.text, "assistant");
      if (!message) return [];
      return [{ ...message, finish_reason: stringFrom(choiceRecord.finish_reason) ?? finishReason(response) }];
    });
  }
  const source = Array.isArray(response.output)
    ? response.output
    : response.content === undefined
      ? []
      : [{ content: response.content, role: "assistant" }];
  const parts = source.flatMap((value) => inputMessage(value, "assistant")?.parts ?? []);
  return parts.length === 0 ? [] : [{ finish_reason: finishReason(response), parts, role: "assistant" }];
};

const stopSequences = (value: unknown): readonly string[] | undefined => {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as readonly string[];
};

const openAiApiType = (adapter: string): "chat_completions" | "responses" | undefined =>
  adapter.startsWith("openai-responses")
    ? "responses"
    : adapter.startsWith("openai-chat-completions")
      ? "chat_completions"
      : undefined;

export const redactExchange = (
  observed: ObservedProviderExchange,
  policy: CapturePolicyV1
): { readonly report: RedactionReport; readonly trace: CanonicalTrace } => {
  if (
    !policy.allowedMethods.includes(observed.method) ||
    !policy.allowedPaths.includes(observed.path) ||
    (policy.successfulResponsesOnly &&
      (observed.responseStatus < 200 || observed.responseStatus >= 300))
  ) {
    throw new Error("Capture policy rejected this provider exchange");
  }

  const replacementCounts: Record<string, number> = {};
  const request = redactUnknown(observed.requestBody, replacementCounts, new WeakSet());
  const response = redactUnknown(observed.responseBody, replacementCounts, new WeakSet());
  const report: RedactionReport = {
    detectorVersion: "builtin/1",
    profile: policy.redactionProfile,
    replacements: replacementCounts,
  };
  const hasCaptureRun = observed.captureRunId !== undefined;
  const hasProjectScope = observed.projectScopeId !== undefined;
  if (hasCaptureRun !== hasProjectScope) {
    throw new Error("Scoped capture requires both project scope and capture run IDs");
  }
  const scoped = hasCaptureRun && hasProjectScope;
  const requestRecord = recordFrom(request);
  const responseValue = responseRecord(response);
  const messages = inputMessages(requestRecord);
  const outputs = outputMessages(responseValue);
  const instructions = systemInstructions(requestRecord);
  const tools = toolDefinitions(requestRecord);
  const reasons = [...new Set(outputs.map((message) => message.finish_reason))];
  const responseModel = stringFrom(responseValue.model);
  const attributes: GenAiSpanAttributes = {
    ...(messages.length === 0 ? {} : { "gen_ai.input.messages": messages }),
    "gen_ai.operation.name": "chat",
    ...(outputs.length === 0 ? {} : { "gen_ai.output.messages": outputs }),
    "gen_ai.provider.name": observed.provider,
    ...(finiteNumberFrom(requestRecord.frequency_penalty) === undefined ? {} : {
      "gen_ai.request.frequency_penalty": finiteNumberFrom(requestRecord.frequency_penalty)!,
    }),
    ...(integerFrom(requestRecord.max_tokens ?? requestRecord.max_completion_tokens) === undefined ? {} : {
      "gen_ai.request.max_tokens": integerFrom(requestRecord.max_tokens ?? requestRecord.max_completion_tokens)!,
    }),
    "gen_ai.request.model": observed.model,
    ...(finiteNumberFrom(requestRecord.presence_penalty) === undefined ? {} : {
      "gen_ai.request.presence_penalty": finiteNumberFrom(requestRecord.presence_penalty)!,
    }),
    ...(integerFrom(requestRecord.seed) === undefined ? {} : { "gen_ai.request.seed": integerFrom(requestRecord.seed)! }),
    ...(stopSequences(requestRecord.stop) === undefined ? {} : {
      "gen_ai.request.stop_sequences": stopSequences(requestRecord.stop)!,
    }),
    ...(typeof requestRecord.stream === "boolean" ? { "gen_ai.request.stream": requestRecord.stream } : {}),
    ...(finiteNumberFrom(requestRecord.temperature) === undefined ? {} : {
      "gen_ai.request.temperature": finiteNumberFrom(requestRecord.temperature)!,
    }),
    ...(finiteNumberFrom(requestRecord.top_p) === undefined ? {} : {
      "gen_ai.request.top_p": finiteNumberFrom(requestRecord.top_p)!,
    }),
    ...(reasons.length === 0 ? {} : { "gen_ai.response.finish_reasons": reasons }),
    ...(stringFrom(responseValue.id) === undefined ? {} : { "gen_ai.response.id": stringFrom(responseValue.id)! }),
    ...(responseModel === undefined ? {} : { "gen_ai.response.model": responseModel }),
    ...(stringFrom(responseValue.status) === undefined ? {} : {
      "gen_ai.response.status": stringFrom(responseValue.status)!,
    }),
    ...(instructions.length === 0 ? {} : { "gen_ai.system_instructions": instructions }),
    ...(tools.length === 0 ? {} : { "gen_ai.tool.definitions": tools }),
    ...(observed.usage.cacheCreationInputTokens === undefined ? {} : {
      "gen_ai.usage.cache_creation.input_tokens": observed.usage.cacheCreationInputTokens,
    }),
    ...(observed.usage.cacheReadInputTokens === undefined ? {} : {
      "gen_ai.usage.cache_read.input_tokens": observed.usage.cacheReadInputTokens,
    }),
    "gen_ai.usage.input_tokens": observed.usage.inputTokens,
    "gen_ai.usage.output_tokens": observed.usage.outputTokens,
    ...(observed.usage.reasoningOutputTokens === undefined ? {} : {
      "gen_ai.usage.reasoning.output_tokens": observed.usage.reasoningOutputTokens,
    }),
    ...(openAiApiType(observed.adapter) === undefined ? {} : {
      "openai.api.type": openAiApiType(observed.adapter)!,
    }),
  };
  return {
    report,
    trace: {
      schema: CANONICAL_TRACE_SCHEMA,
      schemaUrl: OTEL_GENAI_SCHEMA_URL,
      semconvCommit: OTEL_GENAI_SEMCONV_COMMIT,
      span: {
        attributes,
        kind: "CLIENT",
        name: `chat ${observed.model}`,
      },
      traice: {
        adapter: observed.adapter,
        ...(scoped ? {
          captureRunId: observed.captureRunId!,
          projectScopeId: observed.projectScopeId!,
        } : {}),
        capturedAt: observed.capturedAt,
        client: observed.client,
        pipelineVersion: policy.pipelineVersion,
        provenance: "provider_exchange",
        providerRequest: request,
        providerResponse: { body: response, statusCode: observed.responseStatus },
        redaction: report,
        traceId: observed.traceId,
      },
    },
  };
};

export const containsKnownSecret = (value: string): boolean =>
  detectors.some(({ pattern }) => {
    pattern.lastIndex = 0;
    const match = pattern.test(value);
    pattern.lastIndex = 0;
    return match;
  });
