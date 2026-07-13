import type {
  CanonicalTraceV1,
  CapturePolicyV1,
  ObservedProviderExchange,
  RedactionReport,
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

export const redactExchange = (
  observed: ObservedProviderExchange,
  policy: CapturePolicyV1
): { readonly report: RedactionReport; readonly trace: CanonicalTraceV1 } => {
  if (
    !policy.allowedMethods.includes(observed.method) ||
    !policy.allowedPaths.includes(observed.path)
  ) {
    throw new Error("Capture policy rejected this provider route");
  }

  const replacementCounts: Record<string, number> = {};
  const request = redactUnknown(observed.requestBody, replacementCounts, new WeakSet());
  const response = redactUnknown(observed.responseBody, replacementCounts, new WeakSet());
  const report: RedactionReport = {
    detectorVersion: "builtin/1",
    profile: policy.redactionProfile,
    replacements: replacementCounts,
  };
  return {
    report,
    trace: {
      adapter: observed.adapter,
      capturedAt: observed.capturedAt,
      client: observed.client,
      model: observed.model,
      provider: observed.provider,
      redaction: report,
      request,
      response: { body: response, status: observed.responseStatus },
      schema: "traice.trace/1",
      traceId: observed.traceId,
      usage: observed.usage,
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
