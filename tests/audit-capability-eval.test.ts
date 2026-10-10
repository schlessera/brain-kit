import { expect, spyOn, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures, prepare, DAY, document } from "../scripts/evals/audit-capabilities/fixtures";
import { capability, applyFixtureCandidate } from "../scripts/evals/audit-capabilities/prototype";
import { controlReport } from "../scripts/evals/audit-capabilities/run";
import { auditCommand } from "../packages/core/src/cli/commands/audit";
import { audit, auditTotals, auditWithModules } from "../packages/core/src/lib/auditor";
import { openDatabase } from "../packages/core/src/lib/db";
import { indexAll } from "../packages/core/src/lib/indexer";
import { parseFrontmatter } from "../packages/common/src/frontmatter-parse";
import { validate } from "../packages/core/src/lib/validate";
import { tagsCommand } from "../packages/core/src/cli/commands/tags";
import type { LoadedModule } from "../packages/core/src/lib/module-types";

test("draft document groups stay separate across tuning and held-out fixtures", () => {
  const tuning = new Set(fixtures.filter(f => f.split === "tuning").map(f => f.group));
  expect(tuning.size).toBeGreaterThan(0);
  expect(fixtures.filter(f => f.split === "held-out").length).toBeGreaterThan(0);
  for (const f of fixtures.filter(f => f.split === "held-out")) expect(tuning.has(f.group)).toBe(false);
});

for (const f of fixtures) test(`${f.id}: capability follows actual handlers, never the finding message`, () => {
  const p = prepare(f);
  try {
    const c = capability(p.root, p.taxonomy, f.finding, DAY);
    expect(c.handlerAvailable).toBe(f.available);
    expect(c.executionAuthorized).toBe(false);
    expect(c.suggestion.length).toBeGreaterThan(0);
    for (const [path, raw] of Object.entries(f.files)) expect(readFileSync(join(p.root, path), "utf8")).toBe(raw);
  } finally { p.close(); }
});

test("unsupported TODO cannot invoke a real registry writer even with fixture authorization", () => {
  const f = fixtures.find(f => f.id === "todo-tuning")!;
  const p = prepare(f);
  try {
    const r = applyFixtureCandidate(p.root, p.taxonomy, f.finding, DAY, true);
    expect(r.written).toEqual([]);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(f.files[f.finding.path]!);
  } finally { p.close(); }
});

test("real generated-region handler changes parseable bytes, preserves prose, clears its finding, and is idempotent", async () => {
  const f = fixtures[0]!; const p = prepare(f); const db = openDatabase(join(p.root, "brain.db"));
  try {
    await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true });
    const before = audit(db, p.taxonomy, { root: p.root, now: new Date(DAY) });
    expect(before.filter(i => i.category === "index-stale")).toHaveLength(1);
    expect(applyFixtureCandidate(p.root, p.taxonomy, f.finding, DAY, false).written).toEqual([]);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(f.files[f.finding.path]!);
    expect(applyFixtureCandidate(p.root, p.taxonomy, f.finding, DAY, true).written).toEqual([f.finding.path]);
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
    expect(applyFixtureCandidate(p.root, p.taxonomy, f.finding, DAY, true).written).toEqual([]);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(next);
  } finally { db.close(); p.close(); }
});

test("escaping symlinks never become available registry handlers", () => {
  const p = prepare(fixtures[0]!); const outside = prepare(fixtures[0]!);
  try {
    symlinkSync(outside.root, join(p.root, "linked"));
    const c = capability(p.root, p.taxonomy, { ...fixtures[0]!.finding, path: "linked/rituals/_index.md" }, DAY);
    expect(c.reason).toBe("unsafe or aggregate path");
    expect(c.handlerAvailable).toBe(false);
  } finally { p.close(); outside.close(); }
});

test("real audit --fix returns unverified provider claims without contents or writes and falls back without a provider", async () => {
  const f = fixtures.find(f => f.id === "broken-link")!; const p = prepare(f); const dbPath = join(p.root, "brain.db");
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
    expect(calls).toBe(1);
    expect(prompt).toContain("missing-harbor");
    expect(prompt).not.toContain("Odysseus links");
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(claims);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(f.files[f.finding.path]!);
    await auditCommand.run([], { json: true, brain });
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(plain);
  } finally { output.mockRestore(); p.close(); }
});

test("actual module hygiene contributes detections but no executable repair capability", async () => {
  const f = fixtures.find(f => f.id === "custom-module-check")!; const p = prepare(f); const db = openDatabase(join(p.root, "brain.db"));
  try {
    await indexAll(db, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true });
    const mod: LoadedModule = { key: "fixture-ritual", dir: p.root, config: {}, manifest: { name: "fixture-ritual", hygieneChecks: [() => [f.finding]] } };
    const issues = await auditWithModules(db, { root: p.root, taxonomy: p.taxonomy, modules: [mod] }, { now: new Date(DAY) });
    const actual = issues.find(i => i.category === f.finding.category)!;
    expect(actual).toEqual(f.finding);
    expect(capability(p.root, p.taxonomy, actual, DAY).handlerAvailable).toBe(false);
  } finally { db.close(); p.close(); }
});

test("actual tag migration fixes a configured alias while corpus tag-noise remains a separate manual finding", async () => {
  const f = fixtures.find(f => f.id === "aggregate-tag-noise")!; const p = prepare(f); const path = f.finding.path === "(corpus)" ? "notes/vocabulary.md" : f.finding.path;
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
    expect(capability(p.root, p.taxonomy, f.finding, DAY).handlerAvailable).toBe(false);
  } finally { output.mockRestore(); p.close(); }
});

test("offline controls do not manufacture live quality, savings or adoption measurements", () => {
  const r = controlReport(); expect(r.cases).toBe(14); expect(r.expectedHandlers).toBe(2);
  expect(r.results).toHaveLength(14); expect(r.results.every(row => row.correct)).toBe(true); expect(r.adoption).toBe("not measured");
  expect(Object.keys(r.live)).toHaveLength(9);
  for (const value of Object.values(r.live)) expect(value).toBeNull();
});
