/**
 * The #841 three-arm comparison, run directly. It reuses `live.ts`'s arms,
 * provider wrapper and spend guard unchanged, and skips only the native review
 * and paid-policy admission that `main()` requires before dispatch.
 *
 *   BRAIN_LIVE_EVAL=841 ANTHROPIC_API_KEY=... BRAIN_EVAL_REMAINING_USD=10 \
 *     bun scripts/evals/audit-capabilities/measure.ts <out-dir> <keyless-proof.json>
 *
 * The keyless proof (`bun scripts/evals/audit-capabilities/benchmark.ts`) must be
 * taken on the same day: every case's detection is checked against it before
 * its arms run. Writes observations.json, physical-calls.json, billing.json and
 * freeze.json; `analyze.ts` scores them once GPT-family annotations exist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cases, detect, prepareBenchmark } from "./benchmark";
import { protocol } from "./protocol";
import { runtimeFreeze } from "./freeze";
import { completion, currentProposalStats, observeArm, Spend, type PhysicalCall } from "./live";

if (process.env.BRAIN_LIVE_EVAL !== "841") throw Error("Refusing to run: set BRAIN_LIVE_EVAL=841 (calls the paid Anthropic API)");
const key = process.env.ANTHROPIC_API_KEY ?? "";
if (!key.trim()) throw Error("Refusing to run: ANTHROPIC_API_KEY is not set");
const [out, proofPath] = process.argv.slice(2);
if (!out || existsSync(out) || !proofPath) throw Error("Usage: measure.ts <fresh-out-dir> <keyless-proof.json>");
const proof = JSON.parse(readFileSync(proofPath, "utf8"));
const today = new Date().toISOString().slice(0, 10);
if (proof.detectionDay !== today || proof.allChecksPassed !== true) throw Error(`Keyless proof must pass and be taken today (${today}), got ${proof.detectionDay}`);

const frozen = runtimeFreeze();
const cap = Number(process.env.BRAIN_EVAL_REMAINING_USD);
mkdirSync(out, { mode: 0o700 });
const calls: PhysicalCall[] = [], observations: unknown[] = [];
const save = () => {
  writeFileSync(join(out, "physical-calls.json"), JSON.stringify(calls, null, 2), { mode: 0o600 });
  writeFileSync(join(out, "observations.json"), JSON.stringify(observations, null, 2), { mode: 0o600 });
};
const spend = new Spend(cap, calls, save);
writeFileSync(join(out, "freeze.json"), JSON.stringify(frozen, null, 2), { mode: 0o600 });
save();
try {
  for (const f of cases) for (let repetition = 0; repetition < protocol.repetitions; repetition++) for (const arm of protocol.arms) {
    const start = performance.now();
    const p = await prepareBenchmark(f);
    try {
      const detected = await detect(p);
      if (!isDeepStrictEqual(detected, proof.rows.find((r: any) => r.id === f.id)?.detected)) throw Error(`${f.id}: detection differs from today's keyless proof`);
      const armStart = performance.now(); const firstCall = calls.length;
      // Same runtime re-verification as live.ts before every paid dispatch.
      const verifyFreeze = () => { if (runtimeFreeze().freezeSha !== frozen.freezeSha) throw Error("Runtime changed after freeze before physical dispatch"); };
      const provider = arm === "actual-current-message-only" ? completion(spend, f.id, repetition, key, fetch, verifyFreeze) : undefined;
      const observed = await observeArm(p, f, arm, detected, provider).catch((error) => {
        observations.push({ fixture: f.id, repetition, arm, error: String(error), sourceEffects: error.sourceEffects ?? null, physicalCallIndices: calls.slice(firstCall).map((_, n) => firstCall + n) });
        save(); throw error;
      });
      // Arm timing starts after preparation and detection, as in live.ts; only the measured freeze checks are excluded.
      const excludedFreezeCheckMs = calls.slice(firstCall).reduce((sum, c) => sum + c.freezeCheckMs, 0);
      const durationMs = performance.now() - armStart - excludedFreezeCheckMs;
      const rawTaskDurationMs = performance.now() - start;
      observations.push({ fixture: f.id, split: f.split, repetition, arm, detected, durationMs, rawTaskDurationMs,
        taskDurationMs: rawTaskDurationMs - excludedFreezeCheckMs, excludedFreezeCheckMs,
        physicalCallIndices: calls.slice(firstCall).map((_, n) => firstCall + n), ...observed,
        projection: arm === "actual-current-message-only" ? currentProposalStats(observed.output, f) : null });
      save();
      console.error(`${f.id} rep ${repetition} ${arm}: ${calls.length - firstCall} call(s), known debit $${spend.knownChargeDebitUpperUsd.toFixed(4)}`);
      if (spend.stopped) throw Error("Stop after a failed or unknown-usage physical attempt");
      if (new Date().toISOString().slice(0, 10) !== today) throw Error("Detection day crossed the keyless proof's day");
    } finally { p.close(); }
  }
} finally {
  writeFileSync(join(out, "billing.json"), JSON.stringify({ reservationUsd: cap, usageDerivedStandardCostUpperUsd: spend.aggregateUpperUsd,
    knownUsageDerivedStandardCostUpperSubtotalUsd: spend.usedUpper, conservativeKnownChargeDebitUpperUsd: spend.knownChargeDebitUpperUsd,
    retainedReservationUpperUsd: spend.reservedUpperUsd, unknownCostAttempts: spend.unknownCostAttempts, missingUsageStop: spend.stopped,
    actualInvoiceUsd: null, physicalAttempts: calls.length, freezeSha: frozen.freezeSha, admission: "direct: no native review or paid-policy admission" }, null, 2), { mode: 0o600 });
  save();
}
