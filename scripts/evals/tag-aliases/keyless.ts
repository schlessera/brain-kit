/** Keyless report: the lexical baseline, the code-owned candidate stage and candidate volume on the example corpus. Never model quality. */
import { performance } from "node:perf_hooks";
import { fixtures, prepare } from "./fixtures";
import { candidates, type Candidate } from "./prototype";
import { metrics, type Row } from "./metrics";
import { protocol } from "./protocol";
export const EXAMPLE_CORPUS = new URL("../../../packages/core/fixtures/corpus/", import.meta.url).pathname;
/** How many pairs the candidate stage emits on a real brain; every pair costs orientations × repetitions Jev calls. */
export async function corpusVolume(root = EXAMPLE_CORPUS) {
  const start = performance.now(), found = await candidates(root);
  const tags = new Set(found.pairs.flatMap(p => [p.left, p.right]));
  return { root: root === EXAMPLE_CORPUS ? "packages/core/fixtures/corpus" : root, pairs: found.pairs.length, omitted: found.omitted,
    byRule: { lexical: found.pairs.filter(p => p.lexical).length, cooccurring: found.pairs.filter(p => !p.lexical && p.cooccurs).length,
      overlapOnly: found.pairs.filter(p => !p.lexical && !p.cooccurs).length },
    lowestAdmittedOverlap: found.pairs.length ? Math.min(...found.pairs.map(p => p.overlap)) : null,
    tagsInPairs: tags.size, candidateMs: Math.round(performance.now() - start),
    jevCallsPerRun: found.pairs.length * 2 * protocol.repetitions, pairIds: found.pairs.map(p => p.id) };
}
export async function keyless() {
  const rows: Row[] = [];
  for (const f of fixtures) {
    const env = prepare(f);
    try {
      const start = performance.now(), found = await candidates(env.root);
      const pair: Candidate | undefined = found.pairs.find(p => [p.left, p.right].includes(f.left) && [p.left, p.right].includes(f.right));
      // The lexical arm is what ships today: a variant group is treated as an alias.
      rows.push({ id: f.id, split: f.split, same: f.same, arm: "lexical", repetition: 0,
        retrieved: Boolean(pair), proposed: Boolean(pair?.lexical), abstained: !pair?.lexical,
        failure: null, durationMs: performance.now() - start, modelQuality: false });
    } finally { env.close(); }
  }
  const byCategory = Object.fromEntries([...new Set(fixtures.map(f => f.category))].map(category => {
    const ids = fixtures.filter(f => f.category === category).map(f => f.id), selected = rows.filter(r => ids.includes(r.id));
    return [category, { cases: ids.length, retrieved: selected.filter(r => r.retrieved).length, lexicalProposals: selected.filter(r => r.proposed).length }];
  }));
  // Trivial floors a model arm must beat: accept every retrieved candidate, or accept none.
  const floors = (split: string) => ({
    proposeAllCandidates: metrics(rows.filter(r => r.split === split).map(r => ({ ...r, proposed: r.retrieved, abstained: !r.retrieved }))),
    proposeNothing: metrics(rows.filter(r => r.split === split).map(r => ({ ...r, proposed: false, abstained: true }))) });
  return { protocol, scriptedOnly: true, rows, byCategory, corpus: await corpusVolume(),
    summary: Object.fromEntries(["tuning", "held-out"].map(split => [`${split}/lexical`, metrics(rows.filter(r => r.split === split))])),
    floors: Object.fromEntries(["tuning", "held-out"].map(split => [split, floors(split)])) };
}
if (import.meta.main) console.log(JSON.stringify(await keyless(), null, 2));
