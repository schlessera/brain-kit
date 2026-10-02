import { createHash } from "node:crypto";
import { fixtures, prepare, DAY } from "./fixtures";
import { pairs, inspect } from "./prototype";

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
if (import.meta.main) console.log(JSON.stringify(await controlReport(), null, 2));
