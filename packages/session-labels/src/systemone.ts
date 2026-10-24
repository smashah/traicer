// The `/v1/systemone` wire format shared by TypeSafe Jev and the open-source
// local servers (Von, Kev, Rizzo Flow, laya-serve). Traicer only ever sends
// trace-derived state to a classifier on this machine, so the client refuses
// any endpoint that is not a loopback address.

export type Criterion =
  | string
  | {
      readonly examples?: readonly string[];
      readonly not_for?: string;
      readonly what: string;
    };

export interface ChoiceQuestion {
  readonly criteria: Readonly<Record<string, Criterion | null>>;
  readonly instructions: string;
  readonly type: "choice";
}

export interface ScoreQuestion {
  readonly criteria: readonly string[];
  readonly instructions: string;
  readonly type: "score";
}

export interface NoulQuestion {
  readonly instructions: string;
  readonly type: "noul";
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type QuestionSet = Readonly<Record<string, Question>>;

export interface SystemOneRequest {
  readonly model: string;
  readonly questions: QuestionSet;
  readonly state: unknown;
}

export interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly type: "choice";
}

export interface ScoreAnswer {
  readonly confidence: number;
  readonly score: number;
  readonly type: "score";
}

export interface NoulAnswer {
  readonly noul: number;
  readonly type: "noul";
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface SystemOneClient {
  readonly decide: (request: SystemOneRequest) => Promise<Readonly<Record<string, Answer>>>;
}

export type SystemOneFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface SystemOneClientOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly fetch?: SystemOneFetch;
  readonly timeoutMs?: number;
}

export class ClassifierEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierEndpointError";
  }
}

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

export const classifierEndpoint = (baseUrl: string): string => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ClassifierEndpointError("The classifier URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ClassifierEndpointError("The classifier URL must use http or https");
  }
  if (!loopbackHosts.has(url.hostname)) {
    throw new ClassifierEndpointError(
      "The classifier must run on this machine: use 127.0.0.1, localhost or [::1]"
    );
  }
  if (url.username || url.password) {
    throw new ClassifierEndpointError("Put classifier credentials in the API key, not the URL");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/v1/systemone")) {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/systemone`;
  }
  return url.toString();
};

const unit = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;

const answerFor = (question: Question, raw: unknown): Answer | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Readonly<Record<string, unknown>>;
  if (question.type === "choice") {
    const confidence = unit(value.confidence);
    if (typeof value.choice !== "string" || !(value.choice in question.criteria) || confidence === undefined) {
      return undefined;
    }
    return { choice: value.choice, confidence, type: "choice" };
  }
  if (question.type === "score") {
    const confidence = unit(value.confidence);
    const top = question.criteria.length - 1;
    if (
      typeof value.score !== "number"
      || !Number.isFinite(value.score)
      || value.score < 0
      || value.score > top
      || confidence === undefined
    ) {
      return undefined;
    }
    return { confidence, score: value.score, type: "score" };
  }
  const noul = unit(value.noul);
  return noul === undefined ? undefined : { noul, type: "noul" };
};

export const createSystemOneClient = (options: SystemOneClientOptions): SystemOneClient => {
  const endpoint = classifierEndpoint(options.baseUrl);
  const fetcher = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    decide: async (request) => {
      const response = await fetcher(endpoint, {
        body: JSON.stringify(request),
        headers: {
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          "content-type": "application/json",
        },
        method: "POST",
        // A redirect could move trace-derived state off this machine.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Classifier returned HTTP ${response.status}`);
      const body = (await response.json()) as { readonly answers?: unknown };
      const answers = body.answers && typeof body.answers === "object"
        ? body.answers as Readonly<Record<string, unknown>>
        : {};
      const valid: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = answerFor(question, answers[id]);
        if (answer) valid[id] = answer;
      }
      return valid;
    },
  };
};
