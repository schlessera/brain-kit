/**
 * Stand-in for evals/triage/providers.ts, swapped in under run.ts by the
 * preload beside this file. The roster is one model with two efforts, and
 * every batch is answered from the dataset's gold labels so the real scorer
 * produces the verdict. TRIAGE_STUB scripts a scenario on top:
 *
 *   pass         every configuration meets the gate
 *   fail         one needs_user item is filed as drop — a missed escalation,
 *                the hard fail
 *   no-data      every call throws: zero successful calls, NO DATA
 *   unsupported  effort "low" is rejected the way an endpoint rejects it;
 *                "high" answers from gold
 *   Other scenarios vary a repetition, transport coverage or incremental writes.
 */
import { ITEMS } from "../../evals/triage/dataset.ts";
import type { CallResult, ModelSpec } from "../../evals/triage/providers.ts";

export class UnsupportedEffortError extends Error {}

export const MODELS: ModelSpec[] = [
  { id: "stub-model", label: "stub", provider: "openai", inPerMTok: 1, outPerMTok: 1, efforts: ["low", "high"] },
];

const gold = new Map(ITEMS.map((i) => [i.id, i.gold.route]));
const missed = ITEMS.find((i) => i.slice === "user")!.id;
const calls = new Map<string | null, number>();
const batchArg = process.argv.indexOf("--batch");
const batchSize = Number(batchArg < 0 ? 5 : process.argv[batchArg + 1]);
const batchesPerRep = Math.ceil(ITEMS.length / batchSize);

export async function callWithRetry(
  _m: ModelSpec, effort: string | null, _system: string, user: string
): Promise<CallResult> {
  const scenario = process.env.TRIAGE_STUB ?? "pass";
  const ordinal = calls.get(effort) ?? 0;
  calls.set(effort, ordinal + 1);
  const repetition = Math.floor(ordinal / batchesPerRep);
  if (scenario === "incremental" && effort === "high" && ordinal === 0) {
    const path = process.env.EVAL_BENCHMARKS;
    if (!path) throw new Error("stub requires disposable benchmark path");
    const written = await Bun.file(path).json();
    if (!written.results?.some((row: { modelId: string; effort: string }) =>
      row.modelId === "stub-model" && row.effort === "low")) {
      throw new Error("previous selected configuration was not persisted incrementally");
    }
  }
  if (scenario === "no-data") throw new Error("stub: endpoint unreachable");
  if (scenario === "unsupported" && effort === "low") throw new UnsupportedEffortError("stub: effort rejected");
  const batch = JSON.parse(user) as { id: string }[];
  if (!batch.length) throw new Error("stub requires nonempty real items");
  if (["partial", "partial-fail", "partial-malformed"].includes(scenario) && ordinal === 0) {
    throw new Error("stub: first batch unavailable");
  }
  if (scenario.startsWith("unsupported-after-") && ordinal === 1) {
    throw new UnsupportedEffortError("stub: effort rejected after observed response");
  }
  if ((scenario === "filing-unavailable" && batch.some(({ id }) => ["drop", "rule"].includes(gold.get(id)!))) ||
      (scenario === "agent-unavailable" && batch.some(({ id }) => gold.get(id) === "needs_agent"))) {
    throw new Error("stub: category unavailable");
  }
  const rows = batch.filter(({ id }) => !(scenario === "lost-first" && repetition === 0 && id === missed))
    .map(({ id }) => ({
      id, stakes: 0, route:
        ((scenario === "fail" || scenario === "missed-first" && repetition === 0 || scenario === "unsupported-after-fail") && id === missed) ||
        ((scenario === "filing-average" && repetition === 0 || scenario === "partial-fail") && id === "h8a") ||
        (scenario === "agent-average" && repetition === 0 && id === "h11") ||
        (scenario === "injection-first" && repetition === 0 && id === "h12") ? "drop" : gold.get(id),
    }));
  return { text: scenario === "partial-malformed" && ordinal === 1 ? "invalid response" : JSON.stringify(rows),
    inTokens: 10, outTokens: 10, ms: 1, servedBy: "keyless-stub" };
}
