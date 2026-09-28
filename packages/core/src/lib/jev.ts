/**
 * Core's own transport to Jev, TypeSafe AI's typed classifier (D42): one
 * request, one budget, and never a throw.
 *
 * A self-contained twin of ui-server's client
 * (`createJevClient`, `packages/ui-server/src/classification/jev-client.ts:94-209`),
 * because core imports neither ui-server nor ui-sdk. Two differences follow
 * from `brain sync` being a one-shot CLI rather than a server answering turns:
 * there is no breaker, since there is no next turn to protect, and the default
 * budget is 10 s, since nothing renders while the sync waits.
 *
 * The whole call — one attempt plus one retry on 429/529 — lives inside that
 * single deadline, and the deadline is enforced here rather than trusted to the
 * fetch: an attempt that has not settled when it passes is abandoned. A
 * timeout, a non-2xx status, a body that is not the documented shape, or a
 * missing key all resolve to `answers: null` with an outcome the caller
 * counts.
 *
 * Wire shape, verified 2026-09-28 against https://docs.typesafe.ai/api.md:
 * `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer`,
 * body `{ model, state, questions }`; the response is `{ model, answers,
 * usage }`, one answer per question under the id it was asked with. A
 * `choice` answer carries `choice`, `probabilities` over every option (summing
 * to 1) and a 0–1 `confidence`; a `noul` answer carries `noul` in 0–1.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * The model alias. It moves when TypeSafe ships a release; the response's
 * `model` names the versioned model that answered, which `JevResult.model`
 * keeps so a measurement can say what it measured.
 */
export const JEV_MODEL = "jev-latest";

/** The budget one call gets, retry included. */
export const JEV_TIMEOUT_MS = 10_000;

/**
 * The wait before the one retry when a 429/529 carries no `retry-after`.
 * TypeSafe asks for a short delay rather than an immediate retry
 * (https://docs.typesafe.ai/api.md, "Handling rate limits"), and a 10 s
 * budget has room for one.
 */
export const JEV_RETRY_DELAY_MS = 500;

export type JevOutcome =
  | "answered"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "network_error"
  | "bad_response"
  | "no_key";

/** A `choice` question: pick one option; each option name maps to its description. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

/** A `noul` question: how likely the statement is true, 0–1. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevRequest {
  model: string;
  /** What the questions are about. Text only; keyed by item id so a question can name its item. */
  state: string | Record<string, unknown> | unknown[];
  /** Keyed by question id; each answer comes back under the same id. */
  questions: Record<string, JevQuestion>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

/** Answers keyed by question id. */
export type JevAnswers = Record<string, JevAnswer>;

export interface JevResult {
  outcome: JevOutcome;
  /** Every asked question's answer when `outcome` is `answered`, else null. */
  answers: JevAnswers | null;
  /** Wall time the call took, retry and wait included. */
  durationMs: number;
  /** The HTTP status of the last attempt, when there was one. */
  status?: number;
  /** The versioned model that answered, e.g. `jev-1.13.0`. */
  model?: string;
  /** Input tokens the answered request was billed for, when the response said. */
  inputTokens?: number;
}

/** The slice of `fetch` the client uses, so a test can hand in one that never resolves. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JevClientOptions {
  apiKey: string | null | undefined;
  fetch?: FetchLike;
  endpoint?: string;
  timeoutMs?: number;
  /** Wait before the retry when the response names none. */
  retryDelayMs?: number;
  /** Injected clock, for deterministic latency in tests. */
  now?: () => number;
}

export interface JevClient {
  /** A key is configured. Without one `ask` answers `no_key` and sends nothing. */
  readonly enabled: boolean;
  ask(request: JevRequest): Promise<JevResult>;
}

const RETRY_STATUSES = new Set([429, 529]);

/** How far the probabilities of one choice may sum from 1 before the answer is not believed. */
const PROBABILITY_SUM_TOLERANCE = 0.05;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The answer to one question, rebuilt from only the fields this client reads,
 * or null when it is not the documented shape for THAT question: a choice
 * must pick one of the question's own options and give a probability for
 * each of them, and nothing else.
 */
function readAnswer(question: JevQuestion, raw: unknown): JevAnswer | null {
  if (!isRecord(raw) || raw.type !== question.type) return null;
  if (question.type === "noul") return isUnit(raw.noul) ? { type: "noul", noul: raw.noul } : null;
  const options = Object.keys(question.criteria);
  const { choice, probabilities, confidence } = raw;
  if (typeof choice !== "string" || !options.includes(choice)) return null;
  if (!isUnit(confidence) || !isRecord(probabilities)) return null;
  const keys = Object.keys(probabilities);
  if (keys.length !== options.length || !options.every((option) => Object.hasOwn(probabilities, option))) {
    return null;
  }
  const read: Record<string, number> = {};
  let sum = 0;
  for (const option of options) {
    const p = probabilities[option];
    if (!isUnit(p)) return null;
    read[option] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;
  return { type: "choice", choice, probabilities: read, confidence };
}

interface ReadResponse {
  answers: JevAnswers;
  model: string;
  inputTokens?: number;
}

/**
 * The response, or null unless every asked question has a well-formed answer.
 * Answers to questions nobody asked are ignored rather than trusted: the
 * asked questions are the list walked, never the answer map.
 */
function readResponse(json: unknown, questions: Record<string, JevQuestion>): ReadResponse | null {
  if (!isRecord(json) || typeof json.model !== "string" || !isRecord(json.answers)) return null;
  const raw = json.answers;
  const answers: JevAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(raw, id)) return null;
    const answer = readAnswer(question, raw[id]);
    if (!answer) return null;
    answers[id] = answer;
  }
  const read: ReadResponse = { answers, model: json.model };
  const usage = json.usage;
  if (isRecord(usage) && typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)) {
    read.inputTokens = usage.input_tokens;
  }
  return read;
}

/** `retry-after` in milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const DEADLINE = Symbol("deadline");

/**
 * `promise`, unless the deadline passes first. The fetch is handed the same
 * signal, but a fetch that ignores it must not be able to hold the sync past
 * its budget, so the deadline is enforced here as well.
 */
function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(DEADLINE);
      return;
    }
    const onAbort = () => reject(DEADLINE);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return beforeDeadline(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

type Attempt =
  | { kind: "ok"; read: ReadResponse; status: number }
  | { kind: "bad"; status: number }
  | { kind: "status"; status: number; retryAfterMs?: number };

export function createJevClient(options: JevClientOptions): JevClient {
  const apiKey = options.apiKey?.trim() || null;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? JEV_RETRY_DELAY_MS;
  const now = options.now ?? (() => Date.now());

  async function attempt(request: JevRequest, body: string, signal: AbortSignal): Promise<Attempt> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body,
      signal,
    });
    if (!response.ok) {
      const wait = retryAfterMs(response.headers.get("retry-after"), Date.now());
      return wait === undefined
        ? { kind: "status", status: response.status }
        : { kind: "status", status: response.status, retryAfterMs: wait };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      // A body cut off by the deadline is a timeout, not a malformed answer.
      if (signal.aborted) throw err;
      return { kind: "bad", status: response.status };
    }
    const read = readResponse(json, request.questions);
    return read ? { kind: "ok", read, status: response.status } : { kind: "bad", status: response.status };
  }

  return {
    enabled: apiKey !== null,
    async ask(request) {
      const startedAt = now();
      const done = (outcome: JevOutcome, extra: Partial<JevResult> = {}): JevResult => ({
        outcome,
        answers: null,
        durationMs: now() - startedAt,
        ...extra,
      });
      if (!apiKey) return done("no_key");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = controller.signal;
      let lastStatus: number | undefined;
      try {
        const body = JSON.stringify(request);
        for (let tries = 0; tries < 2; tries++) {
          let result: Attempt;
          try {
            result = await beforeDeadline(attempt(request, body, signal), signal);
          } catch {
            return done(signal.aborted ? "timeout" : "network_error", lastStatus === undefined ? {} : { status: lastStatus });
          }
          if (result.kind === "ok") {
            const { answers, model, inputTokens } = result.read;
            return {
              ...done("answered", { status: result.status, model }),
              answers,
              ...(inputTokens === undefined ? {} : { inputTokens }),
            };
          }
          if (result.kind === "bad") return done("bad_response", { status: result.status });
          lastStatus = result.status;
          if (!RETRY_STATUSES.has(result.status)) return done("http_error", { status: result.status });
          if (tries === 1) break;
          // One retry, and only if it can start inside the budget: a wait
          // the deadline would cut short is time the sync spends for nothing.
          const wait = result.retryAfterMs ?? retryDelayMs;
          if (now() - startedAt + wait >= timeoutMs) break;
          try {
            await sleep(wait, signal);
          } catch {
            break;
          }
        }
        return done("rate_limited", { status: lastStatus });
      } catch {
        // Only reachable if the request itself cannot be serialised; nothing
        // was sent, and the caller treats it like any other failed call.
        return done("network_error");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
