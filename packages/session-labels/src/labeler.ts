import type { CanonicalTrace } from "@traice/domain";

import { clip, viewExchange, type ExchangeView } from "./exchange";
import {
  LABELER_VERSION,
  type CompletionClaim,
  type ExchangeLabels,
  type Labeled,
  type Outcome,
  type RequestKind,
  type RequestLabels,
  type ScoreLabel,
  type SessionCounts,
  type SessionDomain,
  type SessionLabels,
  type StepModelLabels,
  type TaskType,
  type TestIntegrityLabels,
  type VerificationEvidence,
  type WorkUnitLabels,
} from "./labels";
import {
  agentStepQuestions,
  sessionOutcomeQuestions,
  testIntegrityQuestions,
  userRequestQuestions,
  userVerdictQuestions,
  workUnitQuestions,
} from "./questions";
import {
  addsSkip,
  addsSuppression,
  claimsTestsPass,
  editHunks,
  isCheckConfigPath,
  isTestPath,
  languageOfPath,
  normaliseCommand,
  shellCommand,
  stepsOf,
  touchedPaths,
  unifiedDiff,
  type Language,
  type LastResult,
  type StepActivity,
  type StepView,
} from "./rules";
import type { Answer, QuestionSet, SystemOneClient } from "./systemone";

export interface LabelSink {
  readonly exchange: (input: {
    readonly labels: ExchangeLabels;
    readonly sessionKey: string;
    readonly traceId: string;
  }) => void;
  readonly session: (input: {
    readonly labels: SessionLabels;
    readonly projectScopeId?: string;
    readonly sessionKey: string;
  }) => void;
}

export interface SessionLabelerOptions {
  readonly classifier?: SystemOneClient;
  readonly idleMs?: number;
  readonly maxBacklog?: number;
  readonly maxSessions?: number;
  readonly minConfidence?: number;
  readonly model?: string;
  readonly now?: () => number;
  readonly onClassifierError?: () => void;
  readonly onError?: () => void;
  // Saved rollup for a session the daemon saw before a restart. Counts carry
  // on; the conversation text needed for context does not survive restarts.
  readonly restore?: (sessionKey: string) => SessionLabels | undefined;
  readonly sink: LabelSink;
}

type CheckActivity = "inspect_runtime" | "run_app_or_script" | "run_build_lint_typecheck" | "run_tests";

interface Check {
  readonly activity: CheckActivity;
  readonly command: string;
  readonly excerpt: string;
  readonly result: LastResult;
  readonly step: number;
}

interface Edit {
  readonly path: string;
  readonly step: number;
  readonly test: boolean;
}

interface UnitState {
  checks: Check[];
  edits: Edit[];
  goal?: string;
  steps: number;
}

interface PendingVerdict {
  readonly claim: string;
  readonly files: readonly string[];
  readonly goal?: string;
  labels: ExchangeLabels;
  readonly traceId: string;
}

type MutableCounts = { -readonly [K in keyof SessionCounts]: number };

interface SessionState {
  backlog: number;
  chain: Promise<void>;
  readonly client: string;
  counts: MutableCounts;
  exchanges: number;
  readonly key: string;
  lastAgentReply?: string;
  lastChecks: Check[];
  lastSeen: number;
  lastUnit?: WorkUnitLabels;
  readonly languageWeights: Map<Language, number>;
  model: {
    difficulty?: ScoreLabel;
    humanSteering?: ScoreLabel;
    outcome?: Labeled<Outcome>;
    primaryDomain?: Labeled<SessionDomain>;
    primaryTaskType?: Labeled<TaskType>;
  };
  pendingVerdict?: PendingVerdict | undefined;
  readonly projectScopeId?: string;
  recentSteps: string[];
  requests: { kind?: RequestKind; taskType?: TaskType; text: string }[];
  readonly requestDomains: Map<string, number>;
  readonly requestTasks: Map<TaskType, number>;
  unit: UnitState;
  userRequests: number;
  workUnits: number;
}

const checkActivities = new Set<StepActivity>([
  "inspect_runtime",
  "run_app_or_script",
  "run_build_lint_typecheck",
  "run_tests",
]);
const failures = new Set<LastResult>(["build_or_type_error", "command_or_env_error", "runtime_error", "test_failure", "timeout"]);
const verified = new Set<VerificationEvidence>(["existing_tests_pass", "ran_the_app", "tests_added_and_pass", "user_confirmed"]);

const emptyCounts = (): MutableCounts => ({
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
});

const newUnit = (goal?: string): UnitState => ({ checks: [], edits: [], ...(goal === undefined ? {} : { goal }), steps: 0 });

const increment = <K>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

const top = <K>(map: ReadonlyMap<K, number>, limit: number): K[] =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key]) => key);

const argumentSummary = (call: StepView["call"] | ExchangeView["outputCalls"][number]): string => {
  const command = shellCommand(call);
  if (command !== undefined) return clip(command, 300, 0);
  const paths = touchedPaths(call);
  return paths.length > 0 ? paths.slice(0, 3).join(", ") : "";
};

export const createSessionLabeler = (options: SessionLabelerOptions) => {
  const minConfidence = options.minConfidence ?? 0.8;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const maxSessions = options.maxSessions ?? 200;
  const maxBacklog = options.maxBacklog ?? 200;
  const model = options.model ?? "jev-latest";
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionState>();

  const ask = async (
    session: SessionState,
    state: unknown,
    questions: QuestionSet
  ): Promise<Readonly<Record<string, Answer>>> => {
    if (!options.classifier || session.backlog > maxBacklog) return {};
    try {
      return await options.classifier.decide({ model, questions, state });
    } catch {
      options.onClassifierError?.();
      return {};
    }
  };

  const choice = <T extends string>(answer: Answer | undefined): Labeled<T> | undefined =>
    answer?.type === "choice"
      ? { confidence: answer.confidence, source: "model", value: answer.choice as T }
      : undefined;
  const score = (answer: Answer | undefined): ScoreLabel | undefined =>
    answer?.type === "score" ? { confidence: answer.confidence, score: answer.score } : undefined;
  const noul = (answer: Answer | undefined): number | undefined =>
    answer?.type === "noul" ? answer.noul : undefined;
  const sure = <T extends string>(label: Labeled<T> | undefined): T | undefined =>
    label !== undefined && label.confidence >= minConfidence ? label.value : undefined;
  // A confident model answer wins; otherwise keep whatever the rules found.
  const prefer = <T extends string>(modelLabel: Labeled<T> | undefined, ruleLabel: Labeled<T> | undefined) =>
    sure(modelLabel) !== undefined ? modelLabel : ruleLabel ?? modelLabel;

  const rollup = (session: SessionState, closed: boolean): SessionLabels => {
    const last = session.lastUnit;
    const evidence = sure(last?.verificationEvidence);
    const claim = last?.completionClaim?.value;
    const verdict = last?.userVerdict?.value;
    const ruleOutcome: Labeled<Outcome> = !last
      ? { confidence: 0.5, source: "rule", value: "unclear" }
      : verdict === "abandoned"
        ? { confidence: 0.85, source: "rule", value: "abandoned" }
        : verdict === "rejected" || verdict === "partially_accepted"
          ? { confidence: 0.6, source: "rule", value: "partial" }
          : evidence !== undefined && verified.has(evidence) && claim !== "contradicted"
            ? { confidence: 0.9, source: "rule", value: "completed_verified" }
            : { confidence: 0.6, source: "rule", value: "completed_unverified" };
    const requestTask = top(session.requestTasks, 1)[0];
    const requestDomain = top(session.requestDomains, 1)[0];
    const primaryTaskType = prefer(
      session.model.primaryTaskType,
      requestTask === undefined ? undefined : { confidence: minConfidence, source: "rule", value: requestTask }
    );
    const primaryDomain = prefer(
      session.model.primaryDomain,
      requestDomain === undefined
        ? undefined
        : { confidence: minConfidence, source: "rule", value: requestDomain as SessionDomain }
    );
    return {
      closed,
      counts: { ...session.counts },
      ...(session.model.difficulty ? { difficulty: session.model.difficulty } : {}),
      exchanges: session.exchanges,
      ...(session.model.humanSteering ? { humanSteering: session.model.humanSteering } : {}),
      labelerVersion: LABELER_VERSION,
      languages: top(session.languageWeights, 3),
      outcome: prefer(session.model.outcome, ruleOutcome) ?? ruleOutcome,
      ...(primaryDomain ? { primaryDomain } : {}),
      ...(primaryTaskType ? { primaryTaskType } : {}),
      schema: "traice.labels.session/1",
      userRequests: session.userRequests,
      workUnits: session.workUnits,
    };
  };

  const publishSession = (session: SessionState, closed: boolean) =>
    options.sink.session({
      labels: rollup(session, closed),
      ...(session.projectScopeId === undefined ? {} : { projectScopeId: session.projectScopeId }),
      sessionKey: session.key,
    });

  const finishUnit = async (
    session: SessionState,
    claim?: { readonly text: string }
  ): Promise<WorkUnitLabels | undefined> => {
    const unit = session.unit;
    if (unit.steps === 0 && claim === undefined) return undefined;
    const lastEdit = unit.edits.at(-1)?.step ?? -1;
    const after = unit.checks.filter((check) => check.step > lastEdit);
    const passedAfter = (activity: CheckActivity) =>
      after.some((check) => check.activity === activity && check.result === "success");
    const testFilesEdited = unit.edits.some((edit) => edit.test);
    let failToPass: WorkUnitLabels["failToPass"] = "none";
    let failToPassCheck: { failing: Check; passing: Check } | undefined;
    for (const failing of unit.checks) {
      if (failing.activity !== "run_tests" || failing.result !== "test_failure") continue;
      const passing = unit.checks.find((check) =>
        check.step > failing.step
        && check.activity === "run_tests"
        && check.result === "success"
        && (check.command === failing.command || check.command.startsWith(failing.command) || failing.command.startsWith(check.command))
      );
      if (!passing) continue;
      const between = unit.edits.filter((edit) => edit.step > failing.step && edit.step < passing.step);
      if (between.some((edit) => !edit.test)) {
        failToPass = "found";
        failToPassCheck = { failing, passing };
        break;
      }
      failToPass = "flaky_or_test_edit";
    }
    const hasEdits = unit.edits.length > 0;
    const ruleEvidence: Labeled<VerificationEvidence> | undefined = !hasEdits
      ? undefined
      : passedAfter("run_tests")
        ? { confidence: 0.9, source: "rule", value: testFilesEdited ? "tests_added_and_pass" : "existing_tests_pass" }
        : passedAfter("run_build_lint_typecheck")
          ? { confidence: 0.9, source: "rule", value: "build_or_typecheck_only" }
          : passedAfter("run_app_or_script") || passedAfter("inspect_runtime")
            ? { confidence: 0.7, source: "rule", value: "ran_the_app" }
            : { confidence: 0.9, source: "rule", value: "nothing" };
    const lastTestRun = after.filter((check) => check.activity === "run_tests").at(-1);
    const ruleClaim: Labeled<CompletionClaim> | undefined = claim === undefined
      ? undefined
      : !claimsTestsPass(claim.text)
        ? undefined
        : lastTestRun?.result === "test_failure"
          ? { confidence: 0.9, source: "rule", value: "contradicted" }
          : hasEdits && lastTestRun === undefined
            ? { confidence: 0.85, source: "rule", value: "unverified_claim" }
            : undefined;

    let verificationEvidence = ruleEvidence;
    let completionClaim = ruleClaim;
    let testTargetsRequest: number | undefined;
    if (claim !== undefined && hasEdits) {
      const questions: QuestionSet = failToPassCheck
        ? workUnitQuestions
        : {
            completion_claim: workUnitQuestions.completion_claim,
            verification_evidence: workUnitQuestions.verification_evidence,
          };
      const answers = await ask(session, {
        agent_claim: clip(claim.text, 1_200, 400),
        checks: unit.checks.slice(-6).map((check) => ({
          command: check.command,
          excerpt: check.excerpt,
          result: check.result,
          step: check.step,
        })),
        files_changed: [...new Set(unit.edits.map((edit) => edit.path))].slice(0, 12),
        ...(failToPassCheck
          ? {
              fail_to_pass: {
                edited_between: [...new Set(unit.edits
                  .filter((edit) => !edit.test && edit.step > failToPassCheck.failing.step && edit.step < failToPassCheck.passing.step)
                  .map((edit) => edit.path))].slice(0, 6),
                failing_excerpt: failToPassCheck.failing.excerpt,
              },
            }
          : {}),
        tests_added: [...new Set(unit.edits.filter((edit) => edit.test).map((edit) => edit.path))].slice(0, 6),
        user_goal: unit.goal ?? "",
      }, questions);
      verificationEvidence = prefer(choice<VerificationEvidence>(answers.verification_evidence), ruleEvidence);
      // A rule that saw a failing test after a "tests pass" claim has harder evidence than any model.
      completionClaim = ruleClaim?.value === "contradicted"
        ? ruleClaim
        : prefer(choice<CompletionClaim>(answers.completion_claim), ruleClaim);
      testTargetsRequest = noul(answers.test_targets_request);
    }

    const labels: WorkUnitLabels = {
      ...(completionClaim ? { completionClaim } : {}),
      editedFiles: new Set(unit.edits.map((edit) => edit.path)).size,
      failToPass,
      failedChecks: unit.checks.filter((check) => failures.has(check.result)).length,
      testFilesEdited,
      testRuns: unit.checks.filter((check) => check.activity === "run_tests").length,
      ...(testTargetsRequest === undefined ? {} : { testTargetsRequest }),
      ...(verificationEvidence ? { verificationEvidence } : {}),
    };
    if (failToPass === "found") session.counts.failToPass += 1;
    if (failToPass === "flaky_or_test_edit") session.counts.flakyOrTestEdit += 1;
    const evidence = sure(verificationEvidence);
    if (evidence !== undefined && verified.has(evidence) && completionClaim?.value !== "contradicted") {
      session.counts.verifiedUnits += 1;
    }
    const claimValue = sure(completionClaim);
    if (claimValue === "contradicted") session.counts.contradictedClaims += 1;
    if (claimValue === "unverified_claim" || claimValue === "partially_supported") session.counts.unverifiedClaims += 1;
    session.workUnits += 1;
    // Session outcome follows the last unit that changed or checked something,
    // not a closing "glad it works" reply.
    if (hasEdits || unit.checks.length > 0) session.lastUnit = labels;
    return labels;
  };

  const settleVerdict = async (session: SessionState, reply?: string) => {
    const pending = session.pendingVerdict;
    if (!pending?.labels.workUnit) return;
    session.pendingVerdict = undefined;
    let unit: WorkUnitLabels = pending.labels.workUnit;
    if (reply === undefined) {
      unit = { ...unit, userVerdict: { confidence: 1, source: "rule", value: "no_reply" } };
    } else {
      const answers = await ask(session, {
        agent_claim: clip(pending.claim, 1_200, 400),
        files_changed: pending.files,
        original_request: pending.goal ?? "",
        user_reply: clip(reply, 1_500, 500),
      }, userVerdictQuestions);
      const userVerdict = choice<NonNullable<WorkUnitLabels["userVerdict"]>["value"]>(answers.user_verdict);
      const correctionReason = choice<NonNullable<WorkUnitLabels["correctionReason"]>["value"]>(answers.correction_reason);
      const missSeverity = score(answers.miss_severity);
      unit = {
        ...unit,
        ...(correctionReason ? { correctionReason } : {}),
        ...(missSeverity ? { missSeverity } : {}),
        ...(userVerdict ? { userVerdict } : {}),
      };
      const verdict = sure(userVerdict);
      const reason = sure(correctionReason);
      if (verdict === "accepted" || verdict === "accepted_with_follow_up") session.counts.acceptedUnits += 1;
      if (
        verdict === "rejected"
        || verdict === "partially_accepted"
        || (reason !== undefined && reason !== "not_a_correction")
      ) {
        session.counts.corrections += 1;
      }
    }
    const previous = pending.labels.workUnit;
    pending.labels = { ...pending.labels, workUnit: unit };
    if (session.lastUnit === previous) session.lastUnit = unit;
    options.sink.exchange({ labels: pending.labels, sessionKey: session.key, traceId: pending.traceId });
  };

  const testIntegrity = async (session: SessionState, steps: readonly StepView[]) => {
    const records: TestIntegrityLabels[] = [];
    let modelCalls = 0;
    const lastFailing = [...session.unit.checks].reverse().find((check) => failures.has(check.result));
    for (const step of steps) {
      if (step.activity !== "edit_code") continue;
      for (const hunk of editHunks(step.call)) {
        const fileRole = isTestPath(hunk.path) ? "test" : isCheckConfigPath(hunk.path) ? "check_config" : "source";
        const suppressionAdded = addsSuppression(hunk);
        const skipAdded = addsSkip(hunk);
        if (fileRole === "source" && !suppressionAdded && !skipAdded) continue;
        const rule: Labeled<NonNullable<TestIntegrityLabels["tampering"]>["value"]> | undefined = skipAdded
          ? { confidence: 0.9, source: "rule", value: "deleted_or_skipped_tests" }
          : suppressionAdded
            ? { confidence: 0.9, source: "rule", value: "suppressed_checks" }
            : undefined;
        let tampering = rule;
        let sanctionedByUser: number | undefined;
        if (modelCalls < 3) {
          modelCalls += 1;
          const answers = await ask(session, {
            diff: unifiedDiff(hunk),
            ...(lastFailing ? { failing_before: lastFailing.excerpt } : {}),
            file: hunk.path,
            file_role: fileRole,
            user_goal: session.unit.goal ?? "",
          }, testIntegrityQuestions);
          tampering = rule ?? choice(answers.test_tampering);
          sanctionedByUser = noul(answers.sanctioned_by_user);
        }
        if (suppressionAdded) session.counts.suppressionsAdded += 1;
        if (skipAdded) session.counts.skipsAdded += 1;
        const value = sure(tampering);
        if (value !== undefined && value !== "none" && (sanctionedByUser ?? 0) < 0.5) {
          session.counts.testTampering += 1;
        }
        records.push({
          fileRole,
          ...(sanctionedByUser === undefined ? {} : { sanctionedByUser }),
          skipAdded,
          suppressionAdded,
          ...(tampering ? { tampering } : {}),
        });
      }
    }
    return records;
  };

  const process = async (session: SessionState, view: ExchangeView) => {
    session.exchanges += 1;
    const steps = stepsOf(view.answeredCalls);
    const exchangeLanguages = new Map<Language, number>();
    for (const step of steps) {
      const index = session.unit.steps;
      session.unit.steps += 1;
      session.recentSteps = [...session.recentSteps, `${step.activity ?? "unknown"}: ${step.result}`].slice(-4);
      if (failures.has(step.result)) session.counts.failedChecks += 1;
      if (step.result === "permission_denied") session.counts.permissionDenied += 1;
      for (const path of touchedPaths(step.call)) {
        const language = languageOfPath(path);
        if (language) {
          const weight = step.activity === "edit_code" ? 3 : 1;
          increment(session.languageWeights, language, weight);
          increment(exchangeLanguages, language, weight);
        }
        if (step.activity === "edit_code") {
          session.unit.edits.push({ path, step: index, test: isTestPath(path) });
        }
      }
      if (step.activity !== undefined && checkActivities.has(step.activity)) {
        const check: Check = {
          activity: step.activity as CheckActivity,
          command: normaliseCommand(shellCommand(step.call) ?? step.call.name),
          excerpt: clip(step.call.response, 300, 600),
          result: step.result,
          step: index,
        };
        session.unit.checks.push(check);
        session.lastChecks = [...session.lastChecks, check].slice(-4);
      }
    }
    const integrity = await testIntegrity(session, steps);

    let request: RequestLabels | undefined;
    let stepModel: StepModelLabels | undefined;
    let kind: ExchangeLabels["kind"] = "other";
    if (view.humanText !== undefined) {
      kind = "user_request";
      await settleVerdict(session, view.humanText);
      await finishUnit(session);
      const answers = await ask(session, {
        client: view.client,
        earlier_requests: session.requests.slice(-3).map((item) => item.text),
        ...(session.lastAgentReply === undefined
          ? {}
          : { previous_agent_reply: clip(session.lastAgentReply, 600, 300) }),
        request: clip(view.humanText, 1_500, 900),
        turn: session.userRequests + 1,
      }, userRequestQuestions);
      const requestKind = choice<RequestKind>(answers.request_kind);
      const taskType = choice<TaskType>(answers.task_type);
      const domain = choice<NonNullable<RequestLabels["domain"]>["value"]>(answers.domain);
      const specificity = score(answers.specificity);
      const scope = score(answers.scope);
      const userMood = choice<NonNullable<RequestLabels["userMood"]>["value"]>(answers.user_mood);
      const pastesErrorOutput = noul(answers.pastes_error_output);
      request = {
        ...(domain ? { domain } : {}),
        ...(pastesErrorOutput === undefined ? {} : { pastesErrorOutput }),
        ...(requestKind ? { requestKind } : {}),
        ...(scope ? { scope } : {}),
        ...(specificity ? { specificity } : {}),
        ...(taskType ? { taskType } : {}),
        ...(userMood ? { userMood } : {}),
      };
      const confidentTask = sure(taskType);
      const confidentDomain = sure(domain);
      if (confidentTask !== undefined && confidentTask !== "other") increment(session.requestTasks, confidentTask);
      if (confidentDomain !== undefined && confidentDomain !== "other") increment(session.requestDomains, confidentDomain);
      const kindValue = sure(requestKind);
      session.requests = [
        ...session.requests,
        {
          ...(kindValue === undefined ? {} : { kind: kindValue }),
          ...(confidentTask === undefined ? {} : { taskType: confidentTask }),
          text: clip(view.humanText, 240, 0),
        },
      ].slice(-12);
      session.userRequests += 1;
      session.unit = newUnit(clip(view.humanText, 1_500, 500));
    } else if (steps.length > 0) {
      kind = "agent_step";
      const interesting = steps.some((step) => step.activity === undefined || failures.has(step.result));
      if (interesting) {
        const answers = await ask(session, {
          ...(view.assistantText ? { agent_reply: clip(view.assistantText, 600, 300) } : {}),
          next_tool_calls: view.outputCalls.slice(0, 4).map((call) => `${call.name} ${argumentSummary(call)}`.trim()),
          recent_steps: session.recentSteps.slice(0, -steps.length).slice(-4),
          step: session.unit.steps,
          tool_calls: steps.slice(0, 4).map((step) => ({ arguments: argumentSummary(step.call), name: step.call.name })),
          tool_results: steps.slice(0, 4).map((step) => ({ excerpt: clip(step.call.response, 400, 800) })),
          user_goal: session.unit.goal ?? "",
        }, agentStepQuestions);
        const trajectory = choice<NonNullable<StepModelLabels["trajectory"]>["value"]>(answers.trajectory);
        const riskyAction = noul(answers.risky_action);
        stepModel = {
          ...(riskyAction === undefined ? {} : { riskyAction }),
          ...(trajectory ? { trajectory } : {}),
        };
      }
    }
    if (view.assistantText) session.lastAgentReply = view.assistantText;

    let workUnit: WorkUnitLabels | undefined;
    const unitFiles = [...new Set(session.unit.edits.map((edit) => edit.path))];
    const unitGoal = session.unit.goal;
    if (view.doneClaim) {
      workUnit = await finishUnit(session, { text: view.assistantText });
      session.unit = newUnit(unitGoal);
    }
    const labels: ExchangeLabels = {
      doneClaim: view.doneClaim,
      kind,
      labelerVersion: LABELER_VERSION,
      languages: top(exchangeLanguages, 3),
      ...(request ? { request } : {}),
      schema: "traice.labels.exchange/1",
      ...(stepModel && Object.keys(stepModel).length > 0 ? { step: stepModel } : {}),
      steps: steps.map((step) => ({ activity: step.activity ?? null, result: step.result })),
      ...(integrity.length > 0 ? { testIntegrity: integrity } : {}),
      ...(workUnit ? { workUnit } : {}),
    };
    options.sink.exchange({ labels, sessionKey: session.key, traceId: view.traceId });
    if (workUnit) {
      session.pendingVerdict = {
        claim: view.assistantText,
        files: unitFiles.slice(0, 12),
        ...(unitGoal === undefined ? {} : { goal: unitGoal }),
        labels,
        traceId: view.traceId,
      };
    }
    session.lastSeen = now();
    publishSession(session, false);
  };

  const close = async (session: SessionState) => {
    sessions.delete(session.key);
    await session.chain;
    await settleVerdict(session);
    await finishUnit(session);
    if (session.workUnits > 0 || session.userRequests > 0) {
      const answers = await ask(session, {
        client: session.client,
        counts: {
          corrections: session.counts.corrections,
          failed_checks: session.counts.failedChecks,
          steps: session.exchanges,
        },
        ...(session.lastAgentReply === undefined
          ? {}
          : { final_agent_reply: clip(session.lastAgentReply, 1_000, 400) }),
        last_checks: session.lastChecks.map((check) => ({ command: check.command, result: check.result })),
        requests: session.requests.map((item) => ({
          ...(item.kind === undefined ? {} : { kind: item.kind }),
          ...(item.taskType === undefined ? {} : { task_type: item.taskType }),
          text: item.text,
        })),
      }, sessionOutcomeQuestions);
      const outcome = choice<Outcome>(answers.outcome);
      const primaryTaskType = choice<TaskType>(answers.primary_task_type);
      const primaryDomain = choice<SessionDomain>(answers.primary_domain);
      const difficulty = score(answers.difficulty);
      const humanSteering = score(answers.human_steering);
      session.model = {
        ...(difficulty ? { difficulty } : {}),
        ...(humanSteering ? { humanSteering } : {}),
        ...(outcome ? { outcome } : {}),
        ...(primaryDomain ? { primaryDomain } : {}),
        ...(primaryTaskType ? { primaryTaskType } : {}),
      };
    }
    publishSession(session, true);
  };

  const sessionFor = (view: ExchangeView): SessionState => {
    const existing = sessions.get(view.sessionKey);
    if (existing) return existing;
    if (sessions.size >= maxSessions) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) void close(oldest).catch(() => options.onError?.());
    }
    const saved = options.restore?.(view.sessionKey);
    const session: SessionState = {
      backlog: 0,
      chain: Promise.resolve(),
      client: view.client,
      counts: saved ? { ...saved.counts } : emptyCounts(),
      exchanges: saved?.exchanges ?? 0,
      key: view.sessionKey,
      lastChecks: [],
      lastSeen: now(),
      languageWeights: new Map(saved?.languages.map((language, index) => [language, 3 - index] as const) ?? []),
      model: {},
      ...(view.projectScopeId === undefined ? {} : { projectScopeId: view.projectScopeId }),
      recentSteps: [],
      requestDomains: new Map(),
      requests: [],
      requestTasks: new Map(),
      unit: newUnit(),
      userRequests: saved?.userRequests ?? 0,
      workUnits: saved?.workUnits ?? 0,
    };
    sessions.set(view.sessionKey, session);
    return session;
  };

  return {
    closeAll: async (): Promise<void> => {
      await Promise.all([...sessions.values()].map((session) => close(session).catch(() => options.onError?.())));
    },
    closeIdle: async (at = now()): Promise<number> => {
      const idle = [...sessions.values()].filter((session) => at - session.lastSeen >= idleMs);
      await Promise.all(idle.map((session) => close(session).catch(() => options.onError?.())));
      return idle.length;
    },
    ingest: (trace: CanonicalTrace, traceId?: string): Promise<void> => {
      const view = viewExchange(trace, traceId);
      const session = sessionFor(view);
      session.backlog += 1;
      session.lastSeen = now();
      session.chain = session.chain
        .then(() => process(session, view))
        .catch(() => options.onError?.())
        .finally(() => {
          session.backlog -= 1;
        });
      return session.chain;
    },
    openSessions: (): number => sessions.size,
  };
};
