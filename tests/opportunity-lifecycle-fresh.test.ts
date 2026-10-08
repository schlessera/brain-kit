import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshCases, referenceFiles } from "../scripts/evals/opportunity-lifecycle/fresh-corpus";
import { runFresh } from "../scripts/evals/opportunity-lifecycle/fresh-run";
import { createConfiguredLab, inspect, apply } from "../scripts/evals/opportunity-lifecycle/prototype";
import { observe, differences } from "../scripts/evals/opportunity-lifecycle/observation";

test("fresh authored reference files are complete inputs and distinct semantic trajectories", () => {
  expect(freshCases).toHaveLength(16);
  expect(freshCases.filter(c => c.split === "tuning")).toHaveLength(4);
  expect(freshCases.filter(c => c.split === "held-out")).toHaveLength(12);
  const signatures = freshCases.map(c => JSON.stringify(c.checkpoints.map(p => ({ kind: p.input.kind, calls: p.calls.length, clarify: p.clarify }))));
  expect(new Set(signatures).size).toBe(16);
  for (const fixture of freshCases) for (const checkpoint of fixture.checkpoints) {
    const files = referenceFiles(fixture, checkpoint);
    expect(files["brain.config.json"]).toBe(fixture.files["brain.config.json"]);
    expect(files[`${fixture.directory}/${fixture.target}/status.md`]!.length).toBeGreaterThan(300);
    expect(files["notes/unrelated.md"]).toBe(fixture.files["notes/unrelated.md"]);
    expect(files["notes/quoted.md"]).toBe(fixture.files["notes/quoted.md"]);
    expect(files["attachments/manifest.txt"]).toBe(fixture.files["attachments/manifest.txt"]);
    if (!checkpoint.clarify) for (const [path,raw] of Object.entries(fixture.files).filter(([path]) => path.endsWith(".md"))) {
      expect(files[path]!.match(/^title: (.+)$/m)?.[1]).toBe(raw.match(/^title: (.+)$/m)?.[1]);
      if ((checkpoint.stage === "closed" || checkpoint.stage === "offer") && path.startsWith(`${fixture.directory}/${fixture.target}/`)) {
        const previous = raw.match(/^deadline: (.+)$/m)?.[1];
        if (previous) expect(files[path]).toContain(previous);
      }
    }
  }
});

test("fresh 24 checkpoints execute complete effects, real CLI deadlines and byte/metadata-idempotent replays", async () => {
  const result = await runFresh();
  expect(result.checkpoints).toBe(24);
  expect(result.rows.filter(row => row.replay === "applied")).toHaveLength(16);
  expect(result.rows.filter(row => row.outcome === "clarify")).toHaveLength(8);
  expect(result.measured).toBe(false);
  expect(result.currentSkill).toBe("unmeasured");
}, 120000);

test("explicit closure after known cancelled focus leaves complete unrelated focus bytes and metadata intact", async () => {
  const fixture = freshCases.find(c => c.id === "cancel-close-history")!;
  const lab = await createConfiguredLab(fixture.files);
  try {
    for (const expected of fixture.checkpoints.slice(0, 2)) {
      const focus = readFileSync(join(lab.root, fixture.focusPath), "utf8").split("\n").find(row => row.includes(`[[${fixture.directory}/${fixture.target}/status]]`))!;
      const inspection = inspect(lab, expected.input, focus);
      if (inspection.outcome !== "planned") throw new Error(inspection.reason);
      expect(apply(lab, inspection.plan, true).outcome).toBe("applied");
    }
    const retired = readFileSync(join(lab.root, fixture.focusPath), "utf8");
    writeFileSync(join(lab.root, fixture.focusPath), fixture.files[fixture.focusPath]!);
    const edited = observe(lab.root);
    const ambiguous = inspect(lab, fixture.checkpoints[2]!.input, "");
    if (ambiguous.outcome === "planned") apply(lab, ambiguous.plan, true);
    expect(readFileSync(join(lab.root, `${fixture.directory}/${fixture.target}/status.md`), "utf8")).toContain("stage: researching\n");
    expect(differences(edited, observe(lab.root))).toEqual([]);
    expect(ambiguous.outcome).toBe("clarify");
    writeFileSync(join(lab.root, fixture.focusPath), retired);
    const before = observe(lab.root);
    const closure = inspect(lab, fixture.checkpoints[2]!.input, "");
    if (closure.outcome === "planned") apply(lab, closure.plan, true);
    expect(readFileSync(join(lab.root, `${fixture.directory}/${fixture.target}/status.md`), "utf8")).toContain("stage: closed\n");
    expect(differences(before, observe(lab.root)).filter(row => row.path === fixture.focusPath)).toEqual([]);
  } finally { lab.close(); }
});
