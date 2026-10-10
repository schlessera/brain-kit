// The shipped hygiene `reconcile` path keeping an open conflict when its check
// failed, which the canonical-conflict eval first exercised (#1386 split it
// from the prototype tests in experiments/canonical-conflict-eval.test.ts).
// The eval's pair retrieval and scripted judgments only produce the entry.
import { expect, test } from "bun:test";
import { fixtures, prepare, DAY, YES, UNKNOWN } from "../scripts/evals/canonical-conflicts/fixtures";
import { pairs, inspect } from "../scripts/evals/canonical-conflicts/prototype";
import { reconcile, readHygieneLog } from "../packages/core/src/lib/hygiene";

const record = (p: ReturnType<typeof prepare>, result: Awaited<ReturnType<typeof inspect>>, incomplete = false) => {
  const r = reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: result ? [result.candidate] : [], failedChecks: incomplete ? ["canonical-conflicts"] : [] });
  return { r, entries: readHygieneLog(p.root).filter(e => e.id.startsWith("conflict-")) };
};

test("abstention retains an existing conflict through the real failed-check reconciliation path", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    expect(record(p, await inspect(p.root, p.taxonomy, pair, DAY, async () => YES)).entries).toHaveLength(1);
    const abstained = await inspect(p.root, p.taxonomy, pair, DAY, async () => UNKNOWN);
    expect(abstained).toBeNull();
    const retained = record(p, abstained, true);
    expect(retained.r.resolved).toBe(0);
    expect(retained.r.failedChecks).toEqual(["canonical-conflicts"]);
    expect(retained.entries).toHaveLength(1);
    expect(retained.entries[0]!.state).toBe("open");
    expect(retained.r.changedFiles).toEqual([]);
  } finally { p.close(); }
});
