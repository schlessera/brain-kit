/** Keyless report-only path through the actual extractor and hygiene writer. */
import { readHygieneLog, reconcile } from "../../../packages/core/src/lib/hygiene";
import { DAY, type Fixture } from "./fixtures";
import { inspect, pairs, type Judge } from "./prototype";
import { snapshot, assertRegularInputs, assertInspectionUnchanged, assertReconciliationEffects } from "./effects";

export async function collect(root: string, taxonomy: Parameters<typeof pairs>[1], judge: Judge, deadlineMs = 10_000) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw Error("Positive bounded inspection deadline required");
  const before = snapshot(root); assertRegularInputs(before);
  const candidates = pairs(root, taxonomy, DAY), findings = [], judgments: unknown[] = [];
  const status: { failure: string | null } = { failure: null };
  const boundedJudge: Judge = async (a, b) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([judge(a, b), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Inspection judgment deadline")), deadlineMs);
      })]);
      judgments.push(answer); return answer;
    } catch (error) { status.failure = String(error); throw error; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  for (const candidate of candidates) {
    const result = await inspect(root, taxonomy, candidate, DAY, boundedJudge);
    if (result) findings.push(result);
    if (status.failure) break;
  }
  const inspected = snapshot(root); assertInspectionUnchanged(before, inspected);
  // Narrow extraction is ALWAYS incomplete, not evidence that prior findings
  // disappeared. Reuse existing state/fingerprint primitives, never a new log.
  const reconciliation = reconcile(root, [], new Map(), { now: new Date(DAY),
    extra: findings.map(f => f.candidate), failedChecks: ["canonical-conflicts"] });
  const after = snapshot(root); assertReconciliationEffects(inspected, after);
  return { candidates, findings, judgments, failure: status.failure, before, inspected, after,
    reconciliation, entries: readHygieneLog(root), replacement: null,
    liveQuality: null, liveCost: null, actualProviderTransport: false };
}

/** Mechanical-only baseline: exact literal same-subject; semantic divergence abstains. */
export const deterministicJudge: Judge = async (a, b) => {
  const subject = (text: string) => text.includes(" | ") ? text.split(" | ")[0] : text.split(": ")[0];
  return { sameSubject: subject(a.span.text) === subject(b.span.text) ? "yes" : "no", contradiction: "unknown" };
};

export type ControlFixture = Fixture;
