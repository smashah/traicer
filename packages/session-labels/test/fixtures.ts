import type { CanonicalTrace, GenAiInputMessage, GenAiMessagePart, GenAiOutputMessage } from "@traice/domain";

export const text = (content: string): GenAiMessagePart => ({ content, type: "text" });
export const call = (id: string, name: string, args: unknown): GenAiMessagePart => ({
  arguments: args,
  id,
  name,
  type: "tool_call",
});
export const result = (id: string, response: unknown): GenAiMessagePart => ({
  id,
  response,
  type: "tool_call_response",
});

export const user = (...parts: GenAiMessagePart[]): GenAiInputMessage => ({ parts, role: "user" });
export const assistant = (...parts: GenAiMessagePart[]): GenAiInputMessage => ({ parts, role: "assistant" });
export const tool = (...parts: GenAiMessagePart[]): GenAiInputMessage => ({ parts, role: "tool" });

let counter = 0;

export const exchange = (
  input: readonly GenAiInputMessage[],
  output: readonly GenAiMessagePart[],
  options: { readonly finish?: string; readonly projectScopeId?: string } = {}
): CanonicalTrace => {
  counter += 1;
  const outputMessage: GenAiOutputMessage = {
    finish_reason: options.finish ?? (output.some((part) => part.type === "tool_call") ? "tool_use" : "end_turn"),
    parts: output,
    role: "assistant",
  };
  return {
    schema: "traice.otel-genai.trace/1",
    schemaUrl: "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev",
    semconvCommit: "b694ec35855d8eccfacd5b09e4b72a808b363038",
    span: {
      attributes: {
        "gen_ai.input.messages": input,
        "gen_ai.operation.name": "chat",
        "gen_ai.output.messages": [outputMessage],
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-test",
        "gen_ai.system_instructions": [text("You are a coding agent.")],
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
      },
      kind: "CLIENT",
      name: "chat claude-test",
    },
    traice: {
      adapter: "anthropic-messages/1",
      capturedAt: `2026-10-24T10:${String(counter % 60).padStart(2, "0")}:00.000Z`,
      client: "claude-code",
      pipelineVersion: "otel-genai/1",
      ...(options.projectScopeId === undefined ? {} : { projectScopeId: options.projectScopeId }),
      provenance: "provider_exchange",
      providerRequest: {},
      providerResponse: { body: {}, statusCode: 200 },
      redaction: { detectorVersion: "builtin/1", profile: "strict-default", replacements: {} },
      traceId: `trace-${counter}`,
    },
  };
};

const goal = "the limiter blocks every request after the first one. fix it";

// A Claude Code style session: read, failing test, fix, passing test, done claim, thanks.
export const fixSession = (firstPrompt = goal): CanonicalTrace[] => {
  const history: GenAiInputMessage[] = [user(text(firstPrompt), text("<system-reminder>context</system-reminder>"))];
  const traces: CanonicalTrace[] = [];
  const step = (output: GenAiMessagePart[], response?: { id: string; value: unknown }) => {
    traces.push(exchange([...history], output));
    history.push(assistant(...output));
    if (response) history.push(tool(result(response.id, response.value)));
  };
  step([call("c1", "Read", { file_path: "src/rate-limit.ts" })], { id: "c1", value: "export const limit = () => {}" });
  step([call("c2", "Bash", { command: "pnpm vitest run src/rate-limit.test.ts" })], {
    id: "c2",
    value: "FAIL src/rate-limit.test.ts > allows a burst\nAssertionError: expected 429 to be 200\nTests  1 failed | 6 passed (7)",
  });
  step([call("c3", "Edit", { file_path: "src/rate-limit.ts", new_string: "const key = windowStart;", old_string: "const key = Date.now();" })], {
    id: "c3",
    value: "The file src/rate-limit.ts has been updated.",
  });
  step([call("c4", "Bash", { command: "pnpm vitest run src/rate-limit.test.ts 2>&1 | tail -5" })], {
    id: "c4",
    value: "Tests  7 passed (7)",
  });
  step([text("Fixed: the window key now uses the window start. All 7 tests pass.")]);
  history.push(user(text("thanks, that works")));
  traces.push(exchange([...history], [text("Glad it works.")]));
  return traces;
};
