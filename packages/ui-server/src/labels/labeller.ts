/**
 * The pill labeller (#1004): a few words saying what a queued follow-up or a
 * working session is about, from a small, fast model the host configures.
 *
 * It is progressive enhancement and nothing else. A pill renders at once with
 * its fallback (the session title, or the start of the prompt) and only gains
 * a label when one arrives; nothing awaits this on a path that renders or
 * runs a turn. Off unless the host passes a provider, it then makes at most
 * one call per distinct text: answers are cached by a hash of the text, a
 * text already being labelled shares that call, and a failure is logged once
 * per item and answered with null.
 *
 * The model client is core's `CompletionProvider` seam (ruling L2 on #1004),
 * taken structurally so this package never imports core: a host passes a
 * provider value it built with `@schlessera/brain`, or any object of the same
 * shape. The text it is given leaves the host for that provider.
 *
 * Every call that reaches the provider is also an Activity run named
 * `pill label` on the session whose pill it labels (#1083). It is priced only
 * when the provider reports usage and a model through `completeWithUsage` and
 * the host declared the billing mode; any other call is an unpriced run, so
 * its cost stays unknown rather than reading as $0.
 */
import type { Counter, Meter } from "@opentelemetry/api";
import type { BillingMode } from "@schlessera/brain-ui-sdk/protocol";
import type { Logger } from "@opentelemetry/api-logs";
import { createHash } from "node:crypto";

import type { ActivityStore, SpanOutcome, SpanUsage } from "../activity/store.js";
import { normaliseLabel } from "./normalise.js";

/** What the labeller sends for one label. */
export interface LabelCompletionRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

/** The tokens one label call used, as the provider reports them. */
export interface LabelCompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** A label answer with what it cost, from `completeWithUsage`. */
export interface LabelCompletion {
  text: string;
  usage?: LabelCompletionUsage;
  /** The model id that answered, as the pricing catalog names it. */
  model?: string;
}

/**
 * The part of core's `CompletionProvider` (`packages/core/src/lib/seams.ts`)
 * the labeller calls. A core provider value satisfies it as it is.
 */
export interface LabelCompletionProvider {
  id: string;
  complete(req: LabelCompletionRequest): Promise<string>;
  /**
   * The same call, answered with the usage and model behind it (#1083). The
   * labeller calls this instead of `complete()` when it is present, so the
   * call's Activity run can be priced.
   */
  completeWithUsage?(req: LabelCompletionRequest): Promise<LabelCompletion>;
}

/** `CreateAppOptions.labeller`: off when absent. */
export interface LabellerOptions {
  /**
   * The small, fast model that writes labels, separate from any session's
   * chat model. Every labelled prompt's text is sent to it, which may be a
   * different vendor from the session's backend.
   */
  provider: LabelCompletionProvider;
  /** How long one call may take before the pill keeps its fallback. Default 10 s. */
  timeoutMs?: number;
  /**
   * How the provider's calls are billed, as the host knows it. Unset means
   * unknown: every `pill label` run is then unpriced, never $0.
   */
  billing?: BillingMode;
}

/** The Activity run name of one label call. */
export const LABEL_RUN_NAME = "pill label";

export const LABEL_TIMEOUT_MS = 10_000;
/** Calls in flight at once; the rest wait their turn. */
export const LABEL_CONCURRENCY = 2;
/** Texts waiting for a call; past this a new one keeps its fallback. */
export const LABEL_MAX_WAITING = 100;
/** Distinct texts whose answer is kept in memory. */
export const LABEL_CACHE_ENTRIES = 500;
/** The most of a prompt the model is shown. */
export const LABEL_PROMPT_CHARS = 2_000;

export const LABEL_SYSTEM_PROMPT =
  "You label chat messages for a small pill in a user interface. " +
  "Reply with two to four plain words saying what the message is about. " +
  "No quotes, no trailing punctuation, no preamble, nothing else.";

export type LabelOutcome = "labelled" | "empty" | "timeout" | "error" | "skipped_busy";

export interface Labeller {
  /** False without a provider: every call answers null without work. */
  readonly enabled: boolean;
  /**
   * The label for `text`, or null when there is none (disabled, no words,
   * failed, timed out, too busy). `item` names what the label is for, so a
   * failure is logged once per item rather than once per attempt.
   * `sessionId` is the session whose pill it labels: the call's Activity run
   * is attributed to it. Asks that share one call share its run, which goes
   * to the session of the ask that started it.
   */
  label(item: string, text: string, sessionId?: string): Promise<string | null>;
}

export interface CreateLabellerDeps {
  options?: LabellerOptions | null;
  log?: Logger;
  meter?: Meter;
  /** Where each provider call is recorded as a `pill label` run. Absent records none. */
  activity?: {
    store: Pick<ActivityStore, "startSpan" | "endSpan" | "rollupRun">;
    /** Called after each write so the live Activity stream can pump. */
    onWrite?: () => void;
  };
}

/** The cache key of a text: its trimmed words, hashed, so prompts are not held twice. */
export function labelSourceHash(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32);
}

const DISABLED: Labeller = { enabled: false, label: async () => null };

export function createLabeller(deps: CreateLabellerDeps): Labeller {
  const options = deps.options;
  if (!options) return DISABLED;
  const { provider } = options;
  const timeoutMs = options.timeoutMs ?? LABEL_TIMEOUT_MS;
  const calls: Counter | undefined = deps.meter?.createCounter("brain.labeller.calls", {
    description:
      "Calls made to the host's label model, by outcome. Each is also a `pill label` Activity run, priced when the provider reports usage and the host declares billing.",
  });
  const fallbacks: Counter | undefined = deps.meter?.createCounter("brain.labeller.fallbacks", {
    description: "Label asks that kept their fallback without an answer: timed out, or skipped while the labeller was busy.",
  });
  // Answers by text hash, oldest first; a re-read moves an entry to the end.
  const cache = new Map<string, string | null>();
  const failedItems = new Set<string>();
  const waiting: Array<() => void> = [];
  let running = 0;

  const remember = (hash: string, label: string | null) => {
    cache.delete(hash);
    cache.set(hash, label);
    while (cache.size > LABEL_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  };

  const reportOnce = (item: string, outcome: LabelOutcome, err?: unknown) => {
    if (failedItems.has(item)) return;
    failedItems.add(item);
    // Bounded like the cache: a long-lived host forgets old items.
    if (failedItems.size > LABEL_CACHE_ENTRIES) failedItems.delete(failedItems.values().next().value!);
    deps.log?.emit({
      severityText: "WARN",
      body: "pill label unavailable; the pill keeps its fallback",
      attributes: {
        "label.item": item,
        "label.outcome": outcome,
        "label.provider": provider.id,
        ...(err ? { error: err instanceof Error ? err.message : String(err) } : {}),
      },
    });
  };

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    // A finished call hands its slot straight to the next waiter, so a new
    // caller can never slip in between and run a third.
    if (running >= LABEL_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }

  type CallResult = { outcome: LabelOutcome; label: string | null; err?: unknown };

  const guardActivity = (write: () => void) => {
    if (!deps.activity) return;
    try {
      write();
      deps.activity.onWrite?.();
    } catch (err) {
      // Recording never costs the pill its label.
      deps.log?.emit({
        severityText: "WARN",
        body: "pill label run not recorded",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  /** Open the call's run as it reaches the provider. */
  const startRun = (sessionId: string | undefined): string => {
    const runId = `label-${crypto.randomUUID()}`;
    guardActivity(() => {
      deps.activity!.store.startSpan({
        spanId: `${runId}:root`,
        runId,
        name: LABEL_RUN_NAME,
        kind: "turn",
        origin: "session",
        sessionId,
        attrs: { "gen_ai.operation.name": "chat", "brain.labeller.provider": provider.id },
      });
    });
    return runId;
  };

  /**
   * Close the run with what the provider reported. Billing rides the root
   * only beside usage and a model: the rollup prices a subscription run at
   * $0 whatever its tokens, so a call that reported nothing would otherwise
   * read as free rather than unknown.
   */
  const endRun = (runId: string, outcome: SpanOutcome, completion?: Omit<LabelCompletion, "text">) => {
    guardActivity(() => {
      const usage = reportedUsage(completion?.usage);
      const model = typeof completion?.model === "string" && completion.model ? completion.model : undefined;
      const spanUsage: SpanUsage | undefined = usage ? { ...usage, ...(model ? { model } : {}) } : undefined;
      const { store } = deps.activity!;
      store.endSpan(`${runId}:root`, {
        outcome,
        ...(spanUsage ? { usage: spanUsage } : {}),
        attrs: {
          ...(usage && model ? { "gen_ai.usage.per_model": { [model]: usage } } : {}),
          ...(usage && model && options.billing ? { "brain.billing_mode": options.billing } : {}),
        },
      });
      store.rollupRun(runId);
    });
  };

  /** One provider call: `completeWithUsage` when the provider has it. */
  const ask = async (req: LabelCompletionRequest): Promise<{ raw: unknown; completion?: Omit<LabelCompletion, "text"> }> => {
    if (typeof provider.completeWithUsage === "function") {
      const answer = await provider.completeWithUsage(req);
      return { raw: answer?.text, completion: { usage: answer?.usage, model: answer?.model } };
    }
    return { raw: await provider.complete(req) };
  };

  /**
   * One provider call for one text, shared by everyone who asks for that text
   * while it is pending. It holds its slot until the provider settles, so a
   * provider that stalls is never handed more calls than the limit, and it
   * stays registered until then, so asking again for the same text joins it
   * rather than paying for a second call. An answer that arrives after every
   * asker gave up is still kept for the next ask. A call that gets its slot
   * after every asker gave up is not started.
   */
  interface Flight {
    askers: number;
    done: Promise<CallResult>;
  }
  const inFlight = new Map<string, Flight>();

  function fly(hash: string, text: string, sessionId: string | undefined): Flight {
    // Its first asker counts before the call can start, so it does start.
    const flight: Flight = { askers: 1, done: Promise.resolve({ outcome: "timeout", label: null }) };
    inFlight.set(hash, flight);
    flight.done = slot(async (): Promise<CallResult> => {
      let runId: string | undefined;
      try {
        if (flight.askers === 0) return { outcome: "timeout", label: null };
        runId = startRun(sessionId);
        const { raw, completion } = await ask({
          system: LABEL_SYSTEM_PROMPT,
          prompt: text.trim().slice(0, LABEL_PROMPT_CHARS),
          maxTokens: 24,
        });
        const label = typeof raw === "string" ? normaliseLabel(raw) : null;
        const outcome: LabelOutcome = label ? "labelled" : "empty";
        calls?.add(1, { outcome, provider: provider.id });
        endRun(runId, "success", completion);
        // A text with no usable answer is not asked again either.
        remember(hash, label);
        return { outcome, label };
      } catch (err) {
        // An error may pass: it is not kept.
        calls?.add(1, { outcome: "error", provider: provider.id });
        if (runId) endRun(runId, "error");
        return { outcome: "error", label: null, err };
      } finally {
        inFlight.delete(hash);
      }
    });
    return flight;
  }

  return {
    enabled: true,
    async label(item, text, sessionId) {
      if (!text.trim()) return null;
      const hash = labelSourceHash(text);
      if (cache.has(hash)) {
        const label = cache.get(hash)!;
        remember(hash, label);
        return label;
      }
      let flight = inFlight.get(hash);
      if (!flight) {
        if (waiting.length >= LABEL_MAX_WAITING) {
          fallbacks?.add(1, { outcome: "skipped_busy", provider: provider.id });
          reportOnce(item, "skipped_busy");
          return null;
        }
        flight = fly(hash, text, sessionId);
      } else {
        flight.askers++;
      }
      // The deadline covers waiting for a slot as well as the call.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        flight.done,
        new Promise<CallResult>((resolve) => {
          timer = setTimeout(() => resolve({ outcome: "timeout", label: null }), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      flight.askers--;
      if (result.outcome === "timeout") fallbacks?.add(1, { outcome: "timeout", provider: provider.id });
      if (!result.label) reportOnce(item, result.outcome, result.err);
      return result.label;
    },
  };
}

/**
 * The provider's usage when it is a usable count, else none: a provider is
 * foreign code, and a malformed number must leave the run unpriced rather
 * than price it wrong.
 */
function reportedUsage(usage: LabelCompletionUsage | undefined): LabelCompletionUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!count(usage.inputTokens) || !count(usage.outputTokens)) return undefined;
  for (const key of ["cacheReadTokens", "cacheCreationTokens"] as const) {
    if (usage[key] !== undefined && !count(usage[key])) return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
  };
}
