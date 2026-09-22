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
 */
import { ITEMS } from "../../evals/triage/dataset.ts";
import type { CallResult, ModelSpec } from "../../evals/triage/providers.ts";

export class UnsupportedEffortError extends Error {}

export const MODELS: ModelSpec[] = [
  { id: "stub-model", label: "stub", provider: "openai", inPerMTok: 1, outPerMTok: 1, efforts: ["low", "high"] },
];

const gold = new Map(ITEMS.map((i) => [i.id, i.gold.route]));
const missed = ITEMS.find((i) => i.slice === "user")!.id;

export async function callWithRetry(
  _m: ModelSpec, effort: string | null, _system: string, user: string
): Promise<CallResult> {
  const scenario = process.env.TRIAGE_STUB ?? "pass";
  if (scenario === "no-data") throw new Error("stub: endpoint unreachable");
  if (scenario === "unsupported" && effort === "low") throw new UnsupportedEffortError("stub: effort rejected");
  const batch = JSON.parse(user) as { id: string }[];
  const rows = batch.map(({ id }) => ({
    id, stakes: 0, route: scenario === "fail" && id === missed ? "drop" : gold.get(id),
  }));
  return { text: JSON.stringify(rows), inTokens: 10, outTokens: 10, ms: 1 };
}
