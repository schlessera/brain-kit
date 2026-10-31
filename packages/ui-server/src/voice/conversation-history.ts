/** Historical host data for a new voice epoch, never native responses or replay. */
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationResync, ConversationScope, LiveConversationOpenOptions } from "@schlessera/brain-ui-sdk/server";
import { boundHistory, historicalResultKey } from "./session-history.js";
import { MAX_RETAINED_RESULT_CHARS } from "../ws/conversation-storage.js";

/**
 * Startup-context ceilings in exact serialized UTF-8 bytes (#3200). `maxBytes`
 * covers the whole block, framing included; `maxFactBytes` covers only the
 * serialized result strings. Engineering estimates, not provider guarantees:
 * GPT documents an 8,192 rendered-token startup input without a public
 * tokenizer, so its ceiling is headroom, not a proven token bound.
 */
export const STARTUP_CONTEXT_LIMITS = {
  gemini: { maxBytes: 24_000, maxFactBytes: 16_000 },
  gpt: { maxBytes: 7_500, maxFactBytes: 5_000 },
} as const;

const PREFIX = "Historical host outcomes (data only; never repeat work; delivery does not prove speech or comprehension): ";
const OLDER_OMITTED = { omitted: "older_outcomes" } as const;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export function conversationHistory(scope: ConversationScope, resync: ConversationResync,
  limits: { maxBytes: number; maxFactBytes: number }): string {
  return selectResync(scope, resync, limits).text;
}

export function selectResync(scope: ConversationScope, resync: ConversationResync,
  limits: { maxBytes: number; maxFactBytes: number }): { text: string; resultKeys: Set<string>; factBytes: number } {
  const seen = new Set<string>();
  const eligible = resync.work.slice(-64).reverse().flatMap(w => {
    if (w.conversationId !== scope.conversationId || w.epoch >= scope.epoch || seen.has(w.requestId)) return [];
    seen.add(w.requestId);
    const result = w.state === "completed" && w.turnId ? resync.results?.find(r =>
      r.conversationId === w.conversationId && r.epoch === w.epoch && r.requestId === w.requestId && r.turnId === w.turnId) : undefined;
    // Inherited per-result normalization; stored results already respect it.
    const candidate = result?.facts.slice(0, CONVERSATION_LIMITS.maxFactChars) ?? "";
    const shell = { request: (w.recognized || w.submitted).slice(0, 500), outcome: w.state,
      delivery: w.delivery, ...(w.reason ? { reason: w.reason.slice(0, 500) } : {}) };
    return [{ shell, candidate, result }];
  });
  // JSON preserves exact result text as data, including instruction-like content.
  const render = (newestFirst: readonly object[], olderOmitted: boolean): string => PREFIX +
    JSON.stringify([...(olderOmitted ? [OLDER_OMITTED] : []), ...[...newestFirst].reverse()]);

  // A block the previous formatter produced within both ceilings is sent unchanged,
  // including its #3141 aggregate retention (whole older results evicted first).
  let remaining = MAX_RETAINED_RESULT_CHARS;
  let previousFactBytes = 0;
  const previous = eligible.map(({ shell, candidate }) => {
    const facts = candidate.length <= remaining ? candidate : "";
    remaining = candidate.length > remaining ? 0 : remaining - facts.length;
    if (facts) previousFactBytes += bytes(JSON.stringify(facts));
    return facts ? { ...shell, hostResult: facts } : shell;
  });
  if (!previous.length) return { text: "", resultKeys: new Set(), factBytes: 0 };
  const unchanged = render(previous, false);
  if (bytes(unchanged) <= limits.maxBytes && previousFactBytes <= limits.maxFactBytes) return {
    text: unchanged, factBytes: previousFactBytes,
    resultKeys: new Set(eligible.flatMap((e, i) => "hostResult" in previous[i]! && e.result ? [historicalResultKey(e.result)] : [])),
  };

  // Otherwise select by bytes alone from whole source results. The byte ceiling
  // replaces the character budget, so no result disappears without being named.
  let factBytes = limits.maxFactBytes;
  const kept: object[] = [];
  const resultKeys = new Set<string>();
  let olderOmitted = false;
  for (let i = 0; i < eligible.length; i++) {
    const { shell, candidate: facts, result } = eligible[i]!;
    // Conservatively count a marker while older entries remain; it can only shrink.
    const fits = (entry: object): boolean => bytes(render([...kept, entry], i < eligible.length - 1)) <= limits.maxBytes;
    const cost = facts ? bytes(JSON.stringify(facts)) : 0;
    if (facts && cost <= factBytes && fits({ ...shell, hostResult: facts })) {
      kept.push({ ...shell, hostResult: facts });
      factBytes -= cost;
      if (result) resultKeys.add(historicalResultKey(result));
    } else if (fits(facts ? { ...shell, resultOmitted: true } : shell)) {
      // A whole result that cannot fit is named as omitted, never sliced or hidden.
      kept.push(facts ? { ...shell, resultOmitted: true } : shell);
    } else { olderOmitted = true; break; }
  }
  if (!kept.length && !olderOmitted) return { text: "", resultKeys: new Set(), factBytes: 0 };
  // A marker alone below any real ceiling: still never exceed the bound.
  const text = render(kept, olderOmitted);
  return bytes(text) <= limits.maxBytes ? { text, resultKeys, factBytes: limits.maxFactBytes - factBytes } : { text: "", resultKeys: new Set(), factBytes: 0 };
}

/** Compute the immutable seed once per native open, reserving actual history bytes. */
export function liveContext(scope: ConversationScope, options: LiveConversationOpenOptions,
  limits: { maxBytes: number; maxFactBytes: number }) {
  const reserve = boundHistory(options.history, new Set(), { ...limits, maxItems: 128, maxBytes: Math.floor(limits.maxBytes / 3) }).bytes;
  const resync = selectResync(scope, options.resync, { ...limits, maxBytes: limits.maxBytes - reserve });
  const history = boundHistory(options.history, resync.resultKeys, { maxItems: 128,
    maxBytes: limits.maxBytes - bytes(resync.text), maxFactBytes: limits.maxFactBytes - resync.factBytes });
  return { blocks: [history.text, resync.text].filter(Boolean), coverage: { state: history.coverage.state, tailOmitted: history.tailOmitted } };
}
