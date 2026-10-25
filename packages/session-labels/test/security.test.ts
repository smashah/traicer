import { describe, expect, test } from "bun:test";

import {
  classifierEndpoint,
  createSessionLabeler,
  createSystemOneClient,
  languages,
  lastResults,
  stepActivities,
  agentStepQuestions,
  sessionOutcomeQuestions,
  testIntegrityQuestions,
  userRequestQuestions,
  userVerdictQuestions,
  workUnitQuestions,
} from "../src";
import { fixSession } from "./fixtures";

const choiceValues = [
  agentStepQuestions,
  sessionOutcomeQuestions,
  testIntegrityQuestions,
  userRequestQuestions,
  userVerdictQuestions,
  workUnitQuestions,
].flatMap((set) => Object.values(set).flatMap((question) =>
  question.type === "choice" ? Object.keys(question.criteria) : []
));

const allowedStrings = new Set<string>([
  ...choiceValues,
  ...languages,
  ...lastResults,
  ...stepActivities,
  "agent_step",
  "check_config",
  "flaky_or_test_edit",
  "found",
  "model",
  "no_reply",
  "none",
  "other",
  "rule",
  "session-labels/1",
  "source",
  "test",
  "traice.labels.exchange/1",
  "traice.labels.session/1",
  "user_request",
]);

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

describe("label safety", () => {
  test("labels never carry trace text", async () => {
    const stored: unknown[] = [];
    const labeler = createSessionLabeler({
      classifier: {
        decide: async (request) => Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [
          id,
          question.type === "choice"
            ? { choice: Object.keys(question.criteria)[0]!, confidence: 0.99, type: "choice" as const }
            : question.type === "score"
              ? { confidence: 0.9, score: 1, type: "score" as const }
              : { noul: 0.2, type: "noul" as const },
        ])),
      },
      sink: {
        exchange: ({ labels }) => stored.push(labels),
        session: ({ labels }) => stored.push(labels),
      },
    });
    for (const trace of fixSession()) await labeler.ingest(trace);
    await labeler.closeAll();
    const unexpected = strings(stored).filter((value) => !allowedStrings.has(value));
    expect(unexpected).toEqual([]);
  });

  test("classifiers must run on this machine", () => {
    expect(classifierEndpoint("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(classifierEndpoint("http://localhost:8009/v1/systemone")).toBe("http://localhost:8009/v1/systemone");
    expect(classifierEndpoint("http://[::1]:8017/")).toBe("http://[::1]:8017/v1/systemone");
    expect(() => classifierEndpoint("https://api.typesafe.ai")).toThrow("must run on this machine");
    expect(() => classifierEndpoint("http://10.0.0.5:8000")).toThrow("must run on this machine");
    expect(() => classifierEndpoint("http://user:pass@127.0.0.1:8000")).toThrow("credentials");
  });

  test("the client drops answers that are not one of the offered options", async () => {
    const client = createSystemOneClient({
      baseUrl: "http://127.0.0.1:8000",
      fetch: async (_input, init) => {
        expect(init.redirect).toBe("error");
        return Response.json({
          answers: {
            outcome: { choice: "made_up", confidence: 0.99 },
            difficulty: { confidence: 0.7, score: 2.4 },
            human_steering: { confidence: 0.7, score: 9 },
          },
        });
      },
    });
    const answers = await client.decide({ model: "jev-latest", questions: sessionOutcomeQuestions, state: {} });
    expect(answers).toEqual({ difficulty: { confidence: 0.7, score: 2.4, type: "score" } });
  });
});
