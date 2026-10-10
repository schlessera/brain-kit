// Shipped audit, auditor, tag-migration and generated-region behaviour that
// the audit-capability eval first exercised (#1386 split it from the harness
// tests). The fixture brains in tests/fixtures/audit-fix/ and the local
// `applyRegistryRepair` driver are drivers only; every assertion here is about
// a real command or library.
import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findingFixtures, prepare, registryFixture, DAY, document } from "./fixtures/audit-fix/prepare";
import { auditCommand } from "../packages/core/src/cli/commands/audit";
import { suggestAuditFix } from "../packages/core/src/lib/audit-repair";
import { applyRegistry, planRegistry } from "../packages/core/src/lib/index-registry";
import { audit, auditTotals, auditWithModules } from "../packages/core/src/lib/auditor";
import { openDatabase } from "../packages/core/src/lib/db";
import { indexAll } from "../packages/core/src/lib/indexer";
import { parseFrontmatter } from "../packages/common/src/frontmatter-parse";
import { validate } from "../packages/core/src/lib/validate";
import { tagsCommand } from "../packages/core/src/cli/commands/tags";
import type { LoadedModule } from "../packages/core/src/lib/module-types";
import type { AuditIssue } from "../packages/core/src/lib/types";
import type { Taxonomy } from "../packages/core/src/lib/taxonomy";

/** Apply the shipped registry writer to one finding, only when the shipped gate reports it available. */
function applyRegistryRepair(root: string, taxonomy: Taxonomy, finding: AuditIssue, asOf: string): string[] {
  if (!suggestAuditFix(root, taxonomy, finding, asOf).canAutoFix) return [];
  const plan = planRegistry(root, taxonomy, asOf);
  return applyRegistry(root, { indexes: plan.indexes.filter(i => i.path === finding.path), problems: [] }, {}).written;
}

test("real generated-region handler changes parseable bytes, preserves prose, clears its finding, and is idempotent", async () => {
  const f = registryFixture; const p = prepare(f.files); const db = openDatabase(join(p.root, "brain.db"));
  try {
    await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true });
    const before = audit(db, p.taxonomy, { root: p.root, now: new Date(DAY) });
    expect(before.filter(i => i.category === "index-stale")).toHaveLength(1);
    expect(suggestAuditFix(p.root, p.taxonomy, f.finding, DAY).canAutoFix).toBe(true);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(f.files[f.finding.path]!);
    expect(applyRegistryRepair(p.root, p.taxonomy, f.finding, DAY)).toEqual([f.finding.path]);
    const next = readFileSync(join(p.root, f.finding.path), "utf8");
    expect(next).not.toBe(f.files[f.finding.path]!);
    expect(next).toContain("Odysseus keeps this prose. [TODO: choose a route]");
    expect(next).toContain("Morning watch");
    expect(parseFrontmatter(next).data.type).toBe("index");
    expect(validate(p.root, p.taxonomy).filter(i => i.level === "error")).toEqual([]);
    await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true });
    const after = audit(db, p.taxonomy, { root: p.root, now: new Date(DAY) });
    expect(after.filter(i => i.category === "index-stale")).toEqual([]);
    expect(after.filter(i => i.category === "todo")).toHaveLength(1);
    expect(applyRegistryRepair(p.root, p.taxonomy, f.finding, DAY)).toEqual([]);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(next);
  } finally { db.close(); p.close(); }
});

test("real audit --fix ignores unverified provider claims and preserves manual findings without writes", async () => {
  const f = findingFixtures.brokenLink; const p = prepare(f.files); const dbPath = join(p.root, "brain.db");
  const db = openDatabase(dbPath); await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true }); db.close();
  const output = spyOn(console, "log").mockImplementation(() => {});
  const brain = { root: p.root, dbPath, config: p.config, configPath: null, modules: [], taxonomy: p.taxonomy };
  let prompt = ""; let calls = 0;
  try {
    await auditCommand.run([], { json: true, brain });
    const plain = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(plain.issues.length).toBeGreaterThan(0);
    expect(plain).toMatchObject(auditTotals(plain.issues));
    await auditCommand.run(["--fix"], { json: true, brain });
    const manual = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(manual.length).toBe(plain.issues.length);
    expect(manual.every((i: { canAutoFix: boolean }) => i.canAutoFix === false)).toBe(true);
    const claims = [{ path: "../outside.md", issue: "invented", suggestion: "replace all content", canAutoFix: true, fix: "invented replacement" }];
    await auditCommand.run(["--fix"], { json: true, brain, completions: { id: "scripted", capabilities: { vision: false }, async complete(input) { prompt = input.prompt; calls++; return JSON.stringify(claims); } } });
    expect(calls).toBe(0);
    expect(prompt).toBe("");
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(manual);
    expect(manual.every((i: object) => !Object.hasOwn(i, "fix") && !Object.hasOwn(i, "repair"))).toBe(true);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(f.files[f.finding.path]!);
    await auditCommand.run([], { json: true, brain });
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(plain);
  } finally { output.mockRestore(); p.close(); }
});

test("actual module hygiene contributes detections but no executable repair capability", async () => {
  const f = findingFixtures.moduleCheck; const p = prepare(f.files); const db = openDatabase(join(p.root, "brain.db"));
  try {
    await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true });
    const mod: LoadedModule = { key: "fixture-ritual", dir: p.root, config: {}, manifest: { name: "fixture-ritual", hygieneChecks: [() => [f.finding]] } };
    const issues = await auditWithModules(db, { root: p.root, taxonomy: p.taxonomy, modules: [mod] }, { now: new Date(DAY) });
    const actual = issues.find(i => i.category === f.finding.category)!;
    expect(actual).toEqual(f.finding);
    expect(suggestAuditFix(p.root, p.taxonomy, actual, DAY).canAutoFix).toBe(false);
  } finally { db.close(); p.close(); }
});

test("actual tag migration fixes a configured alias while corpus tag-noise remains a separate manual finding", async () => {
  const f = findingFixtures.tagNoise; const p = prepare(f.files); const path = f.finding.path === "(corpus)" ? "notes/vocabulary.md" : f.finding.path;
  const raw = document("note", "Vocabulary").replace("[voyage]", "[seafaring]"); writeFileSync(join(p.root, path), raw);
  const dbPath = join(p.root, "brain.db"); const db = openDatabase(dbPath); await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true }); db.close();
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const brain = { root: p.root, dbPath, config: p.config, configPath: null, modules: [], taxonomy: p.taxonomy };
    expect(await tagsCommand.run(["--apply", "--only", "seafaring"], { json: true, brain })).toBe(0);
    const report = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(report.files).toEqual([{ path, from: ["seafaring"], to: ["voyage"] }]);
    expect(readFileSync(join(p.root, path), "utf8")).toBe(raw.replace("[seafaring]", "[voyage]"));
    const afterDb = openDatabase(dbPath);
    try { expect(audit(afterDb, p.taxonomy, { root: p.root, now: new Date(DAY) }).filter(i => i.category === "tag-noise")).toHaveLength(1); }
    finally { afterDb.close(); }
    expect(suggestAuditFix(p.root, p.taxonomy, f.finding, DAY).canAutoFix).toBe(false);
  } finally { output.mockRestore(); p.close(); }
});
