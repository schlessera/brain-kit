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
 */
import type { Counter, Meter } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { createHash } from "node:crypto";

import { normaliseLabel } from "./normalise.js";

/**
 * The part of core's `CompletionProvider` (`packages/core/src/lib/seams.ts`)
 * the labeller calls. A core provider value satisfies it as it is.
 */
export interface LabelCompletionProvider {
  id: string;
  complete(req: { system?: string; prompt: string; maxTokens?: number }): Promise<string>;
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
}

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
   */
  label(item: string, text: string): Promise<string | null>;
}

export interface CreateLabellerDeps {
  options?: LabellerOptions | null;
  log?: Logger;
  meter?: Meter;
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
    description: "Pill label calls to the host's label model, by outcome. The provider reports no usage, so their cost is not known.",
  });
  // Answers by text hash, oldest first; a re-read moves an entry to the end.
  const cache = new Map<string, string | null>();
  const inFlight = new Map<string, Promise<string | null>>();
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

  /**
   * Ask the provider once. The caller hears back at the deadline at the
   * latest, waiting for a slot included, and a call whose caller has already
   * given up is never started. A started call keeps its slot until the
   * provider settles: a
   * provider that stalls cannot be handed more calls than the limit, and an
   * answer that arrives late is still kept for the next ask.
   */
  function call(text: string, hash: string): Promise<CallResult> {
    return new Promise<CallResult>((resolve) => {
      let answered = false;
      const answer = (result: CallResult) => {
        if (answered) return;
        answered = true;
        resolve(result);
      };
      // The deadline covers the wait for a slot as well as the call.
      const timer = setTimeout(() => answer({ outcome: "timeout", label: null }), timeoutMs);
      void slot(async () => {
        // Nobody is waiting for a call that timed out before it got a slot.
        if (answered) return;
        let result: CallResult;
        try {
          const raw = await provider.complete({
            system: LABEL_SYSTEM_PROMPT,
            prompt: text.trim().slice(0, LABEL_PROMPT_CHARS),
            maxTokens: 24,
          });
          const label = typeof raw === "string" ? normaliseLabel(raw) : null;
          result = { outcome: label ? "labelled" : "empty", label };
        } catch (err) {
          result = { outcome: "error", label: null, err };
        } finally {
          clearTimeout(timer);
        }
        if (answered && result.label) remember(hash, result.label);
        answer(result);
      });
    });
  }

  return {
    enabled: true,
    async label(item, text) {
      if (!text.trim()) return null;
      const hash = labelSourceHash(text);
      if (cache.has(hash)) {
        const label = cache.get(hash)!;
        remember(hash, label);
        return label;
      }
      const shared = inFlight.get(hash);
      if (shared) return shared;
      if (waiting.length >= LABEL_MAX_WAITING) {
        calls?.add(1, { outcome: "skipped_busy", provider: provider.id });
        reportOnce(item, "skipped_busy");
        return null;
      }
      const work = call(text, hash).then(({ outcome, label, err }) => {
        calls?.add(1, { outcome, provider: provider.id });
        // A timeout or an error may pass; only an answer is kept.
        if (outcome === "labelled" || outcome === "empty") remember(hash, label);
        if (!label) reportOnce(item, outcome, err);
        return label;
      });
      inFlight.set(hash, work);
      void work.finally(() => inFlight.delete(hash));
      return work;
    },
  };
}
