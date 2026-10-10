import { expect, spyOn, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cases, prepareBenchmark, WRITE_DAY } from "../scripts/evals/audit-capabilities/benchmark";
import { sourceSnapshot } from "../scripts/evals/audit-capabilities/effects";
import { fixtures, prepare, DAY } from "../scripts/evals/audit-capabilities/fixtures";
import { auditCommand } from "../packages/core/src/cli/commands/audit";
import { auditTotals } from "../packages/core/src/lib/auditor";
import { suggestAuditFix, type AuditFixResult } from "../packages/core/src/lib/audit-repair";
import { applyRegistry, planRegistry } from "../packages/core/src/lib/index-registry";
import type { CoreCommand } from "../packages/core/src/cli/types";
import type { AuditIssue } from "../packages/core/src/lib/types";

async function output(args: string[], cli: Parameters<CoreCommand["run"]>[1]) {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await auditCommand.run(args, cli);
    expect(log.mock.calls).toHaveLength(1);
    return JSON.parse(String(log.mock.calls[0]![0]));
  } finally { log.mockRestore(); }
}

test("authored benchmark has nine non-empty repairable cases across both splits", () => {
  const authored = JSON.parse(readFileSync(join(import.meta.dir, "../scripts/evals/audit-capabilities/benchmark.json"), "utf8"));
  const available = cases.filter(f => f.expectedAvailablePaths.length > 0);
  expect(available.length).toBeGreaterThan(0);
  expect(available).toHaveLength(9);
  expect(available.map(f => [f.id, f.expectedAvailablePaths])).toEqual(
    authored.filter((f: { expectedAvailablePaths: string[] }) => f.expectedAvailablePaths.length > 0)
      .map((f: { id: string; expectedAvailablePaths: string[] }) => [f.id, f.expectedAvailablePaths]),
  );
  expect(new Set(available.map(f => f.split))).toEqual(new Set(["tuning", "held-out"]));
  expect(available.reduce((n, f) => n + f.expectedAvailablePaths.length, 0)).toBe(9);
});

for (const f of cases) test(`${f.id}: real audit --fix reports only available repairs and writes nothing`, async () => {
  const p = await prepareBenchmark(f);
  try {
    const cli = { json: true, brain: p.brain };
    const plain = await output([], cli) as ReturnType<typeof auditTotals> & { issues: AuditIssue[] };
    if (f.expectedAvailablePaths.length > 0) expect(plain.issues.length).toBeGreaterThan(0);
    expect(plain).toMatchObject(auditTotals(plain.issues));
    const before = sourceSnapshot(p.root);
    const fixes = await output(["--fix"], cli) as AuditFixResult[];
    expect(fixes).toHaveLength(plain.issues.length);
    expect(fixes.filter(r => r.canAutoFix).map(r => r.path).sort()).toEqual([...f.expectedAvailablePaths].sort());
    for (const [n, finding] of plain.issues.entries()) {
      const result = fixes[n]!;
      const available = finding.category === "index-stale" && f.expectedAvailablePaths.includes(finding.path);
      expect(result.path).toBe(finding.path);
      expect(result.issue).toBe(finding.message);
      expect(result.canAutoFix, `${f.id}: ${finding.category} ${finding.path} repairable/manual`).toBe(available);
      expect(Object.hasOwn(result, "fix")).toBe(false);
      if (available) {
        expect(result.repair).toEqual({ capability: "registry", path: finding.path });
        expect(result.suggestion).toBe(finding.suggestion || "Manual review needed.");
        expect(result.suggestion).toContain("brain registry");
      } else {
        expect(Object.hasOwn(result, "repair")).toBe(false);
        if (finding.category === "index-stale") {
          expect(result.suggestion).toMatch(/^Read the index, its children, and the taxonomy; resolve .+ before considering registry regeneration\.$/);
        } else expect(result.suggestion).toBe(finding.suggestion || "Manual review needed.");
      }
    }
    if (f.id === "nestor-preview-only") {
      expect(f.authorization).toBe(false);
      expect(fixes.some(r => r.repair?.capability === "registry")).toBe(true);
    }
    expect(sourceSnapshot(p.root)).toEqual(before);
    let calls = 0;
    const claims = [{ path: "../outside.md", issue: "invented", suggestion: "replace all content", canAutoFix: true, fix: "invented replacement" }];
    const supplied = await output(["--fix"], { ...cli, completions: {
      id: "scripted", capabilities: { vision: false },
      async complete() { calls++; return JSON.stringify(claims); },
    } });
    expect(calls, `${f.id}: completion provider must never be called`).toBe(0);
    expect(supplied).toEqual(fixes);
    expect(sourceSnapshot(p.root)).toEqual(before);
    expect(await output([], cli)).toEqual(plain);
  } finally { p.close(); }
});

test("production gate names unavailable premises, rejects escaping paths, and reports a current registry as no-op", () => {
  const f = fixtures[0]!;
  const p = prepare(f); const outside = prepare(f);
  try {
    for (const path of ["/outside.md", "../outside.md", "(corpus)", "rituals\\_index.md", "rituals//_index.md", ".hidden/_index.md"]) {
      const result = suggestAuditFix(p.root, p.taxonomy, { ...f.finding, path }, DAY);
      expect(result.canAutoFix).toBe(false);
      expect(result.repair).toBeUndefined();
      expect(result.suggestion).toContain(path === "(corpus)" ? "registry absent or invalid" : "unsafe or aggregate path");
    }
    symlinkSync(outside.root, join(p.root, "linked"));
    expect(suggestAuditFix(p.root, p.taxonomy, { ...f.finding, path: "linked/rituals/_index.md" }, DAY).suggestion).toContain("unsafe or aggregate path");
    expect(suggestAuditFix(p.root, p.taxonomy, { ...f.finding, category: "todo", suggestion: undefined }, DAY)).toEqual({
      path: f.finding.path, issue: f.finding.message, suggestion: "Manual review needed.", canAutoFix: false,
    });
    expect(suggestAuditFix(p.root, p.taxonomy, f.finding, WRITE_DAY).canAutoFix).toBe(true);
    expect(applyRegistry(p.root, planRegistry(p.root, p.taxonomy, WRITE_DAY), {}).written).toEqual([f.finding.path]);
    expect(suggestAuditFix(p.root, p.taxonomy, f.finding, WRITE_DAY)).toEqual({
      path: f.finding.path, issue: f.finding.message,
      suggestion: "No registry content change is required; leave files unchanged.", canAutoFix: false,
    });
  } finally { p.close(); outside.close(); }
});

test("human audit --fix retains labels and prints the available capability; help describes a report", async () => {
  const p = await prepareBenchmark(cases.find(f => f.id === "nestor-preview-only")!);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await auditCommand.run(["--fix"], { json: false, brain: p.brain });
    const printed = log.mock.calls.map(args => args.join(" ")).join("\n");
    expect(printed).toContain("[auto-fixable]");
    expect(printed).toContain("Repair capability: registry (");
    expect(auditCommand.helpBlock).toContain("no provider call; applies nothing");
  } finally { log.mockRestore(); p.close(); }
  const manual = await prepareBenchmark(cases.find(f => f.id === "menelaus-quoted-order")!);
  const manualLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    await auditCommand.run(["--fix"], { json: false, brain: manual.brain });
    expect(manualLog.mock.calls.map(args => args.join(" ")).join("\n")).toContain("[manual]");
  } finally { manualLog.mockRestore(); manual.close(); }
});
