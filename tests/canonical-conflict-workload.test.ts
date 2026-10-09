import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, utimesSync, lutimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { semanticCases, prepareSemantic } from "../scripts/evals/canonical-conflicts/workload";
import { collect, deterministicJudge } from "../scripts/evals/canonical-conflicts/collector";
import { snapshot, changed, assertInspectionUnchanged } from "../scripts/evals/canonical-conflicts/effects";
import { DAY, fixtures, prepare, YES, UNKNOWN } from "../scripts/evals/canonical-conflicts/fixtures";
import { inspect, pairs } from "../scripts/evals/canonical-conflicts/prototype";
import { reconcile, readHygieneLog } from "../packages/core/src/lib/hygiene";
import { deterministicArm } from "../scripts/evals/canonical-conflicts/run";
import { quality } from "../scripts/evals/canonical-conflicts/metrics";

test("keyless deterministic arm reports exactly the explicit single-valued Count/Date positives and no negative", async () => {
  const rows = await deterministicArm();
  expect(rows).toHaveLength(semanticCases.length);
  expect(rows.filter(r => r.reported).map(r => r.id).sort()).toEqual(["h-date-conflict", "h-numeric-conflict", "t-count-conflict"]);
  const q = quality(rows);
  expect(q.semanticPositives).toBe(7); expect(q.retrievedPositives).toBe(6);
  expect(q.truePositive).toBe(3); expect(q.falsePositive).toBe(0); expect(q.falseNegative).toBe(4);
  expect(q.byGolden.no.reported).toBe(0); expect(q.byGolden.unknown.reported).toBe(0);
  expect(q.completeComparison).toBe(true); expect(q.destructiveEffects).toBe(0);
  expect(quality(rows.filter(r => r.split === "held-out")).recall).toBe(0.4);
});

test("authored semantic corpus separates entities, documents and grammar families from controls", () => {
  expect(semanticCases).toHaveLength(24);
  const tuning = semanticCases.filter(c => c.split === "tuning"), held = semanticCases.filter(c => c.split === "held-out");
  expect(tuning).toHaveLength(8); expect(held).toHaveLength(16);
  for (const key of ["entity", "documentFamily", "templateFamily"] as const) {
    const values = new Set(tuning.map(c => c[key]));
    for (const c of held) expect(values.has(c[key])).toBe(false);
  }
  expect(new Set(semanticCases.map(c => c.id)).size).toBe(24);
  for (const c of semanticCases) { expect(c.golden.reason.length).toBeGreaterThan(20); expect(c.input.answers).toEqual([UNKNOWN]); }
  expect(tuning.some(c => c.golden.conflict === "unknown")).toBe(true);
  expect(held.some(c => c.golden.conflict === "yes" && !c.golden.retrieval)).toBe(true);
});

for (const c of semanticCases) test(`${c.id}: complete source preparation retains independent authored retrieval expectation`, async () => {
  const p = prepareSemantic(c);
  try {
    const result = await collect(p.root, p.taxonomy, deterministicJudge);
    expect(result.candidates.length > 0).toBe(c.golden.retrieval);
    expect(result.replacement).toBeNull(); expect(result.liveQuality).toBeNull(); expect(result.liveCost).toBeNull();
    for (const [path, raw] of Object.entries(p.files)) expect(readFileSync(join(p.root, path), "utf8")).toBe(raw);
    expect(result.reconciliation.failedChecks).toEqual(["canonical-conflicts"]);
  } finally { p.close(); }
});

test("complete observer catches binary content and unexpected membership", () => {
  const root = mkdtempSync(join(tmpdir(), "canonical-effects-"));
  try {
    writeFileSync(join(root, "voyage.bin"), Buffer.from([0, 255, 1]));
    const before = snapshot(root); expect(before["voyage.bin"]!.sha).not.toBeNull(); expect(before["voyage.bin"]!.text).toBeNull();
    writeFileSync(join(root, "voyage.bin"), Buffer.from([0, 255, 2]));
    const after = snapshot(root); expect(() => assertInspectionUnchanged(before, after)).toThrow("voyage.bin");
    writeFileSync(join(root, "unexpected.dat"), "new member"); expect(changed(after, snapshot(root))).toContain("unexpected.dat");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complete observer catches same-length symlink retargeting and same-byte touch", () => {
  const root = mkdtempSync(join(tmpdir(), "canonical-effects-"));
  try {
    writeFileSync(join(root, "raft-a"), "retained"); writeFileSync(join(root, "raft-b"), "retained");
    symlinkSync("raft-a", join(root, "link")); lutimesSync(join(root, "link"), new Date(DAY), new Date(DAY)); const before = snapshot(root);
    unlinkSync(join(root, "link")); symlinkSync("raft-b", join(root, "link"));
    lutimesSync(join(root, "link"), new Date(DAY), new Date(DAY));
    expect(snapshot(root)["link"]!.size).toBe(before["link"]!.size);
    expect(snapshot(root)["link"]!.mtimeNs).toBe(before["link"]!.mtimeNs);
    expect(() => assertInspectionUnchanged(before, snapshot(root))).toThrow("link");
    expect(before["link"]!.linkTarget).toBe("raft-a"); expect(snapshot(root)["link"]!.linkTarget).toBe("raft-b");
    const untouched = snapshot(root); utimesSync(join(root, "raft-a"), new Date("2026-07-12"), new Date("2026-07-12"));
    const touched = snapshot(root); expect(touched["raft-a"]!.sha).toBe(untouched["raft-a"]!.sha);
    expect(() => assertInspectionUnchanged(untouched, touched)).toThrow("raft-a");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual collector detects a judge's binary edit before reconciliation", async () => {
  const p = prepare(fixtures[0]!);
  try {
    writeFileSync(join(p.root, "voyage.bin"), Buffer.from([0, 255, 1]));
    await expect(collect(p.root, p.taxonomy, async () => {
      writeFileSync(join(p.root, "voyage.bin"), Buffer.from([0, 255, 2])); return YES;
    })).rejects.toThrow("Unexpected inspection effects: voyage.bin");
    expect(readHygieneLog(p.root)).toEqual([]);
  } finally { p.close(); }
});

test("actual incomplete collector preserves previous findings and does not churn replayed files", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const result = await inspect(p.root, p.taxonomy, pairs(p.root, p.taxonomy, DAY)[0]!, DAY, async () => YES);
    expect(result).not.toBeNull(); reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: [result!.candidate] });
    const before = snapshot(p.root), abstained = await collect(p.root, p.taxonomy, async () => UNKNOWN);
    expect(abstained.reconciliation.resolved).toBe(0); expect(abstained.entries[0]!.state).toBe("open");
    expect(changed(before, abstained.after)).toEqual([]);
    const timed = await collect(p.root, p.taxonomy, async () => new Promise(() => {}), 10);
    expect(timed.failure).toContain("deadline"); expect(timed.entries[0]!.state).toBe("open");
    expect(changed(before, timed.after)).toEqual([]);
  } finally { p.close(); }
});
