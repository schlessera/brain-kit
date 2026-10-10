// The shipped hygiene `reconcile` path keeping an open conflict when its check
// failed, which the canonical-conflict eval first exercised (#1386 split it
// from the prototype tests). The fixture brain and its conflict candidate
// stand in for a canonical-conflict check that first reports the conflict and
// then abstains.
import { expect, test } from "bun:test";
import { conflict, prepare, DAY } from "./fixtures/canonical-conflicts/prepare";
import { reconcile, readHygieneLog, type HygieneCandidate } from "../packages/core/src/lib/hygiene";

const record = (root: string, extra: HygieneCandidate[], incomplete = false) => {
  const r = reconcile(root, [], new Map(), { now: new Date(DAY), extra, failedChecks: incomplete ? ["canonical-conflicts"] : [] });
  return { r, entries: readHygieneLog(root).filter(e => e.id.startsWith("conflict-")) };
};

test("abstention retains an existing conflict through the real failed-check reconciliation path", () => {
  const p = prepare();
  try {
    expect(record(p.root, [conflict]).entries).toHaveLength(1);
    const retained = record(p.root, [], true);
    expect(retained.r.resolved).toBe(0);
    expect(retained.r.failedChecks).toEqual(["canonical-conflicts"]);
    expect(retained.entries).toHaveLength(1);
    expect(retained.entries[0]!.state).toBe("open");
    expect(retained.r.changedFiles).toEqual([]);
  } finally { p.close(); }
});
