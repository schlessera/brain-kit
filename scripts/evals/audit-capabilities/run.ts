import { createHash } from "node:crypto";
import { fixtures, prepare, DAY } from "./fixtures";
import { capability } from "./prototype";

export function controlReport() {
  const results = fixtures.map(f => {
    const p = prepare(f);
    try {
      const c = capability(p.root, p.taxonomy, f.finding, DAY);
      return { id: f.id, split: f.split, correct: c.handlerAvailable === f.available, handler: c.handler, reason: c.reason };
    } finally { p.close(); }
  });
  return {
    fixtureSha256: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"), cases: fixtures.length,
    expectedHandlers: fixtures.filter(f => f.available).length, results,
    live: { suggestionCorrectness: null, falseAutoFixClaims: null, noOpRate: null, invalidProposals: null, callsSaved: null, tokensSaved: null, billedCostUsd: null, p50Ms: null, p95Ms: null },
    adoption: "not measured",
  };
}
if (import.meta.main) console.log(JSON.stringify(controlReport(), null, 2));
