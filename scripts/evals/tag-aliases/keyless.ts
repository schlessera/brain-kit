/** Candidate/lexical/scripted plumbing only. Never model quality or live admission. */
import { performance } from "node:perf_hooks";
import { fixtures, prepare } from "./fixtures";
import { candidates, proposal, type Candidate } from "./prototype";
import { metrics, type Row } from "./metrics";
import { protocol } from "./protocol";
import type { JevChoiceAnswer } from "../../../packages/core/src/lib/jev";
export async function keyless() {
  const rows: Row[] = [];
  for (const f of fixtures) {
    const env = prepare(f);
    try {
      const start = performance.now(), found = await candidates(env.root);
      const pair: Candidate | undefined = found.pairs.find(p => [p.left,p.right].includes(f.left) && [p.left,p.right].includes(f.right));
      for (let repetition = 0; repetition < 3; repetition++) {
        rows.push({ id: f.id, split: f.split, same: f.same, arm: "lexical", repetition,
          retrieved: Boolean(pair?.lexical), proposed: Boolean(pair?.lexical), abstained: !pair?.lexical,
          failure: null, durationMs: performance.now() - start, modelQuality: false });
        const answer: JevChoiceAnswer = { type: "choice", choice: f.same === true ? "same" : f.same === false ? "different" : "uncertain",
          probabilities: { same: f.same === true ? .99 : .005, different: f.same === false ? .99 : .005, uncertain: f.same === null ? .99 : .005 }, confidence: .99 };
        rows.push({ id: f.id, split: f.split, same: f.same, arm: "hybrid", repetition, retrieved: Boolean(pair),
          proposed: Boolean(pair && proposal(pair, answer, .9, found.brain.taxonomy.tags!.vocabulary!)), abstained: !pair || f.same === null,
          failure: null, durationMs: performance.now() - start, modelQuality: false });
      }
    } finally { env.close(); }
  }
  return { protocol, scriptedOnly: true, rows, summary: Object.fromEntries(["tuning","held-out"].flatMap(split =>
    ["lexical","hybrid"].map(arm => [`${split}/${arm}`, metrics(rows.filter(r => r.split === split && r.arm === arm))]))) };
}
if (import.meta.main) console.log(JSON.stringify(await keyless(), null, 2));
