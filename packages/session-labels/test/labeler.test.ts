import { describe, expect, test } from "bun:test";

import {
  createSessionLabeler,
  inventoryDimensions,
  viewExchange,
  type Answer,
  type ExchangeLabels,
  type SessionLabels,
  type SystemOneRequest,
} from "../src";
import { assistant, call, exchange, fixSession, result, text, tool, user } from "./fixtures";

const collect = () => {
  const exchanges = new Map<string, ExchangeLabels>();
  const sessions = new Map<string, SessionLabels>();
  return {
    exchanges,
    sessions,
    sink: {
      exchange: ({ labels, traceId }: { labels: ExchangeLabels; traceId: string }) => exchanges.set(traceId, labels),
      session: ({ labels, sessionKey }: { labels: SessionLabels; sessionKey: string }) => sessions.set(sessionKey, labels),
    },
  };
};

describe("exchange views", () => {
  test("strip client-injected text from the human's words", () => {
    const [first] = fixSession();
    const view = viewExchange(first!);
    expect(view.humanText).toBe("the limiter blocks every request after the first one. fix it");
    expect(view.answeredCalls).toHaveLength(0);
  });

  test("pair the previous tool calls with their results", () => {
    const traces = fixSession();
    const view = viewExchange(traces[2]!);
    expect(view.humanText).toBeUndefined();
    expect(view.answeredCalls.map((item) => item.name)).toEqual(["Bash"]);
    expect(view.answeredCalls[0]?.response).toContain("1 failed");
  });

  test("give every exchange in one conversation the same session key", () => {
    const keys = new Set(fixSession().map((trace) => viewExchange(trace).sessionKey));
    expect(keys.size).toBe(1);
    expect(viewExchange(fixSession("a different task")[0]!).sessionKey).not.toBe([...keys][0]);
  });
});

describe("rules-only labelling", () => {
  test("finds a fail-to-pass test run and verified completion without a model", async () => {
    const { exchanges, sessions, sink } = collect();
    const labeler = createSessionLabeler({ sink });
    const traces = fixSession();
    for (const trace of traces) await labeler.ingest(trace);

    const done = exchanges.get(traces[4]!.traice.traceId);
    expect(done?.doneClaim).toBe(true);
    expect(done?.workUnit?.failToPass).toBe("found");
    expect(done?.workUnit?.verificationEvidence?.value).toBe("existing_tests_pass");
    expect(done?.workUnit?.testRuns).toBe(2);

    const failingStep = exchanges.get(traces[2]!.traice.traceId);
    expect(failingStep?.steps).toEqual([{ activity: "run_tests", result: "test_failure" }]);

    await labeler.closeAll();
    const session = [...sessions.values()][0];
    expect(session?.closed).toBe(true);
    expect(session?.languages).toEqual(["typescript"]);
    expect(session?.counts.failToPass).toBe(1);
    expect(session?.counts.verifiedUnits).toBe(1);
    expect(session?.outcome.value).toBe("completed_verified");
    expect(exchanges.get(traces[4]!.traice.traceId)?.workUnit?.userVerdict).toBeUndefined();
  });

  test("records no_reply when the session ends after a done claim", async () => {
    const { exchanges, sink } = collect();
    const labeler = createSessionLabeler({ sink });
    const traces = fixSession().slice(0, 5);
    for (const trace of traces) await labeler.ingest(trace);
    await labeler.closeAll();
    expect(exchanges.get(traces[4]!.traice.traceId)?.workUnit?.userVerdict?.value).toBe("no_reply");
  });

  test("flags a claim that tests pass when the last test run failed", async () => {
    const { exchanges, sink } = collect();
    const labeler = createSessionLabeler({ sink });
    const history = [user(text("make the test pass"))];
    const first = exchange(history, [call("e1", "Edit", { file_path: "lib/a.py", new_string: "x = 2", old_string: "x = 1" })]);
    const second = exchange(
      [...history, assistant(call("e1", "Edit", { file_path: "lib/a.py", new_string: "x = 2", old_string: "x = 1" })), tool(result("e1", "ok")),
        assistant(call("t1", "Bash", { command: "pytest tests/test_a.py" })), tool(result("t1", "FAILED tests/test_a.py::test_x - assert 2 == 3\n1 failed in 0.1s"))],
      [text("Done, all tests pass now.")]
    );
    await labeler.ingest(first);
    await labeler.ingest(second);
    expect(exchanges.get(second.traice.traceId)?.workUnit?.completionClaim?.value).toBe("contradicted");
  });

  test("treats a newly skipped test as tampering", async () => {
    const { exchanges, sessions, sink } = collect();
    const labeler = createSessionLabeler({ sink });
    const edit = call("s1", "Edit", {
      file_path: "src/limit.test.ts",
      new_string: "it.skip(\"allows a burst\", () => {",
      old_string: "it(\"allows a burst\", () => {",
    });
    const history = [user(text("get CI green")), assistant(edit), tool(result("s1", "updated"))];
    const trace = exchange(history, [call("n1", "Bash", { command: "pnpm test" })]);
    await labeler.ingest(trace);
    expect(exchanges.get(trace.traice.traceId)?.testIntegrity?.[0]).toMatchObject({
      fileRole: "test",
      skipAdded: true,
      tampering: { source: "rule", value: "deleted_or_skipped_tests" },
    });
    expect([...sessions.values()][0]?.counts.testTampering).toBe(1);
  });

  test("reads Codex shell commands", async () => {
    const { exchanges, sink } = collect();
    const labeler = createSessionLabeler({ sink });
    const shell = call("x1", "shell", { command: ["bash", "-lc", "cargo test -p core"] });
    const trace = exchange(
      [user(text("run the tests")), assistant(shell), tool(result("x1", "test result: ok. 12 passed; 0 failed"))],
      [text("All 12 tests pass.")]
    );
    await labeler.ingest(trace);
    expect(exchanges.get(trace.traice.traceId)?.steps).toEqual([{ activity: "run_tests", result: "success" }]);
  });
});

describe("model-assisted labelling", () => {
  const scripted = (answers: Readonly<Record<string, Answer>>) => {
    const requests: SystemOneRequest[] = [];
    return {
      classifier: {
        decide: async (request: SystemOneRequest) => {
          requests.push(request);
          return Object.fromEntries(Object.keys(request.questions).flatMap((id) => {
            const answer = answers[id];
            return answer ? [[id, answer] as const] : [];
          }));
        },
      },
      requests,
    };
  };

  test("uses confident answers and ignores unsure ones", async () => {
    const { classifier, requests } = scripted({
      domain: { choice: "backend_api", confidence: 0.95, type: "choice" },
      request_kind: { choice: "new_task", confidence: 0.93, type: "choice" },
      task_type: { choice: "bug_fix", confidence: 0.55, type: "choice" },
      user_verdict: { choice: "accepted", confidence: 0.97, type: "choice" },
      correction_reason: { choice: "not_a_correction", confidence: 0.96, type: "choice" },
      primary_task_type: { choice: "bug_fix", confidence: 0.9, type: "choice" },
      primary_domain: { choice: "backend_api", confidence: 0.9, type: "choice" },
      outcome: { choice: "completed_verified", confidence: 0.92, type: "choice" },
    });
    const { exchanges, sessions, sink } = collect();
    const labeler = createSessionLabeler({ classifier, sink });
    const traces = fixSession();
    for (const trace of traces) await labeler.ingest(trace);
    await labeler.closeAll();

    const first = exchanges.get(traces[0]!.traice.traceId);
    expect(first?.request?.requestKind?.value).toBe("new_task");
    expect(first?.request?.taskType).toMatchObject({ confidence: 0.55, value: "bug_fix" });
    const done = exchanges.get(traces[4]!.traice.traceId);
    expect(done?.workUnit?.userVerdict?.value).toBe("accepted");

    const session = [...sessions.values()][0];
    expect(session?.primaryTaskType?.value).toBe("bug_fix");
    expect(session?.primaryDomain?.value).toBe("backend_api");
    expect(session?.counts.acceptedUnits).toBe(1);
    expect(session?.counts.corrections).toBe(0);

    const verdictCall = requests.find((request) => "user_verdict" in request.questions);
    expect(verdictCall?.state).toMatchObject({ user_reply: "thanks, that works" });
    const unitCall = requests.find((request) => "completion_claim" in request.questions);
    expect(unitCall?.questions).toHaveProperty("test_targets_request");
    expect(JSON.stringify(unitCall?.state)).not.toContain("old_string");
  });

  test("keeps rule labels when the classifier fails", async () => {
    let errors = 0;
    const { exchanges, sink } = collect();
    const labeler = createSessionLabeler({
      classifier: { decide: async () => { throw new Error("offline"); } },
      onClassifierError: () => { errors += 1; },
      sink,
    });
    const traces = fixSession();
    for (const trace of traces) await labeler.ingest(trace);
    expect(errors).toBeGreaterThan(0);
    expect(exchanges.get(traces[4]!.traice.traceId)?.workUnit?.failToPass).toBe("found");
  });
});

describe("inventory dimensions", () => {
  const session = (overrides: Partial<SessionLabels["counts"]> = {}): SessionLabels => ({
    closed: true,
    counts: {
      acceptedUnits: 0,
      contradictedClaims: 0,
      corrections: 0,
      failToPass: 0,
      failedChecks: 0,
      flakyOrTestEdit: 0,
      permissionDenied: 0,
      skipsAdded: 0,
      suppressionsAdded: 0,
      testTampering: 0,
      unverifiedClaims: 0,
      verifiedUnits: 0,
      ...overrides,
    },
    exchanges: 4,
    labelerVersion: "session-labels/1",
    languages: ["typescript"],
    outcome: { confidence: 0.9, source: "rule", value: "completed_verified" },
    primaryTaskType: { confidence: 0.6, source: "model", value: "feature" },
    schema: "traice.labels.session/1",
    userRequests: 1,
    workUnits: 1,
  });

  test("publish a value only when enough sessions and manifests carry it", () => {
    const rows = [
      { labels: session({ failToPass: 1 }), manifestCount: 4 },
      { labels: session({ failToPass: 1 }), manifestCount: 4 },
      { labels: session({ failToPass: 1, testTampering: 1 }), manifestCount: 4 },
    ];
    const dimensions = inventoryDimensions(rows);
    expect(dimensions.signals).toEqual(["fail_to_pass"]);
    expect(dimensions.language).toEqual(["typescript"]);
    expect(dimensions.outcome).toEqual(["completed_verified"]);
    expect(dimensions.task).toBeUndefined();
    expect(inventoryDimensions(rows.slice(0, 2)).signals).toBeUndefined();
  });
});
