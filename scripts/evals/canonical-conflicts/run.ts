import { createHash } from "node:crypto";
import { fixtures, prepare, DAY } from "./fixtures";
import { pairs, inspect } from "./prototype";
import { semanticCases, prepareSemantic } from "./workload";
import { collect, deterministicJudge } from "./collector";
import { quality, type QualityRow } from "./metrics";

export async function controlReport() {
  const results = [];
  for (const f of fixtures) {
    const p = prepare(f); let calls = 0;
    try {
      const retrieved = pairs(p.root, p.taxonomy, DAY); const emitted = [];
      for (const pair of retrieved) {
        const result = await inspect(p.root, p.taxonomy, pair, DAY, async () => f.answers[Math.min(calls++, f.answers.length - 1)]);
        if (result) emitted.push(result);
      }
      results.push({ id: f.id, split: f.split, retrieved: retrieved.length > 0, emitted: emitted.length,
        correct: (retrieved.length > 0) === f.retrieval && (emitted.length > 0) === f.expected,
        draftConflict: f.semanticConflict ?? f.expected, scriptedCalls: calls });
    } finally { p.close(); }
  }
  return { fixtureSha256: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"), cases: results.length, results,
    draftCandidateRecall: { positives: results.filter(r => r.draftConflict).length, retrieved: results.filter(r => r.draftConflict && r.retrieved).length },
    live: { currentAgentQuality: null, conflictPrecisionRecall: null, abstentionCoverage: null, subgroupErrors: null,
      callsTokensCost: null, p50p95: null, calibratedThresholds: null }, adoption: "not measured", replacement: "not proposed" };
}

/** The one arm that runs keyless: literal same subject plus exact Count/Date comparison, scored on the authored cases.
 * Its result is the floor every paid arm has to beat; it is deterministic, so one repetition is complete.
 */
export async function deterministicArm(): Promise<QualityRow[]> {
  const rows: QualityRow[] = [];
  for (const c of semanticCases) {
    const p = prepareSemantic(c); const started = performance.now();
    try {
      const r = await collect(p.root, p.taxonomy, deterministicJudge);
      rows.push({ id: c.id, split: c.split, arm: "deterministic", repetition: 0, conflict: c.golden.conflict,
        retrieved: r.candidates.length > 0, reported: r.findings.length > 0,
        abstained: r.candidates.length > 0 ? r.findings.length === 0 : null, failure: r.failure,
        destructiveEffects: 0, // collect() throws on any effect outside the six existing hygiene paths.
        durationMs: performance.now() - started, calls: r.judgments.length, inputTokens: 0, outputTokens: 0,
        apiEquivalentUsd: 0, additionalBilledUsd: 0 });
    } finally { p.close(); }
  }
  return rows;
}
export async function deterministicReport() {
  const rows = await deterministicArm();
  return { rows: rows.map(({ id, split, conflict, retrieved, reported, abstained, failure }) => ({ id, split, conflict, retrieved, reported, abstained, failure })),
    all: quality(rows), tuning: quality(rows.filter(r => r.split === "tuning")), heldOut: quality(rows.filter(r => r.split === "held-out")) };
}
if (import.meta.main) console.log(JSON.stringify({ controls: await controlReport(), deterministicArm: await deterministicReport() }, null, 2));
