import type {
  agentStepQuestions,
  sessionOutcomeQuestions,
  testIntegrityQuestions,
  userRequestQuestions,
  userVerdictQuestions,
  workUnitQuestions,
} from "./questions";
import type { Language, LastResult, StepActivity } from "./rules";

// Label records hold enum values, numbers and booleans only. No trace text
// (prompts, commands, paths, test names) is ever stored in a label, so labels
// can sit in operational state and feed inventory rollups safely.

export const LABELER_VERSION = "session-labels/1" as const;

type ChoiceOf<Q> = Q extends { readonly criteria: infer C; readonly type: "choice" } ? keyof C & string : never;

export type RequestKind = ChoiceOf<typeof userRequestQuestions.request_kind>;
export type TaskType = ChoiceOf<typeof userRequestQuestions.task_type>;
export type Domain = ChoiceOf<typeof userRequestQuestions.domain>;
export type UserMood = ChoiceOf<typeof userRequestQuestions.user_mood>;
export type Trajectory = ChoiceOf<typeof agentStepQuestions.trajectory>;
export type VerificationEvidence = ChoiceOf<typeof workUnitQuestions.verification_evidence>;
export type CompletionClaim = ChoiceOf<typeof workUnitQuestions.completion_claim>;
export type UserVerdict = ChoiceOf<typeof userVerdictQuestions.user_verdict> | "no_reply";
export type CorrectionReason = ChoiceOf<typeof userVerdictQuestions.correction_reason>;
export type TestTampering = ChoiceOf<typeof testIntegrityQuestions.test_tampering>;
export type Outcome = ChoiceOf<typeof sessionOutcomeQuestions.outcome>;
export type SessionDomain = ChoiceOf<typeof sessionOutcomeQuestions.primary_domain>;

export interface Labeled<T extends string> {
  readonly confidence: number;
  readonly source: "model" | "rule";
  readonly value: T;
}

export interface ScoreLabel {
  readonly confidence: number;
  readonly score: number;
}

export interface RequestLabels {
  readonly domain?: Labeled<Domain>;
  readonly pastesErrorOutput?: number;
  readonly requestKind?: Labeled<RequestKind>;
  readonly scope?: ScoreLabel;
  readonly specificity?: ScoreLabel;
  readonly taskType?: Labeled<TaskType>;
  readonly userMood?: Labeled<UserMood>;
}

export interface StepLabels {
  readonly activity: StepActivity | null;
  readonly result: LastResult;
}

export interface StepModelLabels {
  readonly riskyAction?: number;
  readonly trajectory?: Labeled<Trajectory>;
}

export interface TestIntegrityLabels {
  readonly fileRole: "check_config" | "source" | "test";
  readonly sanctionedByUser?: number;
  readonly skipAdded: boolean;
  readonly suppressionAdded: boolean;
  readonly tampering?: Labeled<TestTampering>;
}

export interface WorkUnitLabels {
  readonly completionClaim?: Labeled<CompletionClaim>;
  readonly correctionReason?: Labeled<CorrectionReason>;
  readonly editedFiles: number;
  readonly failToPass: "flaky_or_test_edit" | "found" | "none";
  readonly failedChecks: number;
  readonly missSeverity?: ScoreLabel;
  readonly testFilesEdited: boolean;
  readonly testRuns: number;
  readonly testTargetsRequest?: number;
  readonly userVerdict?: Labeled<UserVerdict>;
  readonly verificationEvidence?: Labeled<VerificationEvidence>;
}

export interface ExchangeLabels {
  readonly doneClaim: boolean;
  readonly kind: "agent_step" | "other" | "user_request";
  readonly labelerVersion: typeof LABELER_VERSION;
  readonly languages: readonly Language[];
  readonly request?: RequestLabels;
  readonly schema: "traice.labels.exchange/1";
  readonly step?: StepModelLabels;
  readonly steps: readonly StepLabels[];
  readonly testIntegrity?: readonly TestIntegrityLabels[];
  readonly workUnit?: WorkUnitLabels;
}

export interface SessionCounts {
  readonly acceptedUnits: number;
  readonly contradictedClaims: number;
  readonly corrections: number;
  readonly failToPass: number;
  readonly failedChecks: number;
  readonly flakyOrTestEdit: number;
  readonly permissionDenied: number;
  readonly skipsAdded: number;
  readonly suppressionsAdded: number;
  readonly testTampering: number;
  readonly unverifiedClaims: number;
  readonly verifiedUnits: number;
}

export interface SessionLabels {
  readonly closed: boolean;
  readonly counts: SessionCounts;
  readonly difficulty?: ScoreLabel;
  readonly exchanges: number;
  readonly humanSteering?: ScoreLabel;
  readonly labelerVersion: typeof LABELER_VERSION;
  readonly languages: readonly Language[];
  readonly outcome: Labeled<Outcome>;
  readonly primaryDomain?: Labeled<SessionDomain>;
  readonly primaryTaskType?: Labeled<TaskType>;
  readonly schema: "traice.labels.session/1";
  readonly userRequests: number;
  readonly workUnits: number;
}

export interface SessionInventoryRow {
  readonly labels: SessionLabels;
  readonly manifestCount: number;
}

export interface InventoryDimensionOptions {
  readonly minConfidence?: number;
  readonly minManifests?: number;
  readonly minSessions?: number;
}

// A filter value is published only when enough distinct sessions and enough
// committed manifests carry it, so no combination of filters can describe one
// seller's single session (ADR 0008 applies the same idea to whole segments).
export const inventoryDimensions = (
  rows: readonly SessionInventoryRow[],
  options: InventoryDimensionOptions = {}
): Readonly<Record<string, readonly string[]>> => {
  const minConfidence = options.minConfidence ?? 0.8;
  const minManifests = options.minManifests ?? 10;
  const minSessions = options.minSessions ?? 3;
  const tally = new Map<string, Map<string, { manifests: number; sessions: number }>>();
  const add = (dimension: string, value: string, manifests: number) => {
    const values = tally.get(dimension) ?? new Map<string, { manifests: number; sessions: number }>();
    const current = values.get(value) ?? { manifests: 0, sessions: 0 };
    values.set(value, { manifests: current.manifests + manifests, sessions: current.sessions + 1 });
    tally.set(dimension, values);
  };
  const confident = <T extends string>(label: Labeled<T> | undefined) =>
    label !== undefined && label.confidence >= minConfidence ? label.value : undefined;
  for (const { labels, manifestCount } of rows) {
    if (manifestCount <= 0) continue;
    for (const language of labels.languages) add("language", language, manifestCount);
    const task = confident(labels.primaryTaskType);
    if (task) add("task", task, manifestCount);
    const domain = confident(labels.primaryDomain);
    if (domain) add("domain", domain, manifestCount);
    const outcome = confident(labels.outcome);
    if (outcome && outcome !== "unclear") add("outcome", outcome, manifestCount);
    const signals: string[] = [];
    if (labels.counts.failToPass > 0) signals.push("fail_to_pass");
    if (labels.counts.verifiedUnits > 0) signals.push("verified_completion");
    if (labels.counts.corrections > 0) signals.push("human_correction");
    if (labels.counts.testTampering > 0) signals.push("test_tampering");
    if (labels.counts.suppressionsAdded > 0) signals.push("suppressed_checks");
    if (labels.counts.contradictedClaims + labels.counts.unverifiedClaims > 0) signals.push("unsupported_claim");
    for (const signal of signals) add("signals", signal, manifestCount);
  }
  const dimensions: Record<string, readonly string[]> = {};
  for (const [dimension, values] of tally) {
    const kept = [...values.entries()]
      .filter(([, count]) => count.sessions >= minSessions && count.manifests >= minManifests)
      .map(([value]) => value)
      .sort();
    if (kept.length > 0) dimensions[dimension] = kept;
  }
  return dimensions;
};
