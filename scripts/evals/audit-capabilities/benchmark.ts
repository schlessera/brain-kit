/** Private #841 measured harness. No public repair command or contract changes. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";
import { openDatabase } from "../../../packages/core/src/lib/db";
import { indexAll } from "../../../packages/core/src/lib/indexer";
import { auditCommand } from "../../../packages/core/src/cli/commands/audit";
import { loadAuditDocs, auditTotals } from "../../../packages/core/src/lib/auditor";
import { validateDetailed } from "../../../packages/core/src/lib/validate";
import { capability, applyFixtureCandidate } from "./prototype";
import type { LoadedModule } from "../../../packages/core/src/lib/module-types";
import type { AuditIssue } from "../../../packages/core/src/lib/types";
import type { CompletionProvider } from "../../../packages/core/src/lib/seams";

export const WRITE_DAY = "2026-07-12";
export const DETECTION_DAY = "2026-10-07";
export interface BenchmarkCase {
  id: string; split: "tuning" | "held-out"; entity: string; template: string;
  files: Record<string, string>; authorization: boolean;
  moduleMode: null | "type" | "review" | "missing" | "boundary" | "throw";
  modulePath: string | null; expectedAvailablePaths: string[];
  expectedPreviewFiles: Record<string, string>; expectedEffectFiles: Record<string, string>;
  validationRules: string[]; note: string;
}
export const cases = JSON.parse(readFileSync(join(import.meta.dir, "benchmark.json"), "utf8")) as BenchmarkCase[];

function modulesFor(f: BenchmarkCase, root: string): LoadedModule[] {
  if (!f.moduleMode) return [];
  const path = f.modulePath ?? "notes/entry.md";
  const mod: LoadedModule = { key: "fixture-review", dir: root, config: { path }, manifest: { name: "fixture-review" } };
  if (f.moduleMode === "type") mod.manifest.taxonomy = { types: { "herd-record": { dir: "herd" } } };
  else mod.manifest.hygieneChecks = [ctx => {
    if (f.moduleMode === "throw") throw new Error("The fixture inspection could not run");
    if (f.moduleMode === "review") {
      // Real callback reads the source; it does not fabricate a core audit category.
      readFileSync(join(ctx.root, path), "utf8");
      return [{ category: "fixture-source-review", severity: "warning", path, message: "Review the source record before choosing a correction", suggestion: "Read this record and ask its owner to resolve the uncertain detail." }];
    }
    if (f.moduleMode === "missing") return [{ category: "fixture-required-record", severity: "warning", path, message: "A required review record is absent", suggestion: "Ask the owner for the missing record; do not invent its contents." }];
    // Config-shaped escaped path is deliberately reported without reading it.
    return [{ category: "fixture-boundary-review", severity: "warning", path, message: "A configured source path escapes the brain", suggestion: "Review the module configuration; do not access this path." }];
  }];
  return [mod];
}

export async function prepareBenchmark(f: BenchmarkCase) {
  const root = mkdtempSync(join(tmpdir(), "brain-audit-841-"));
  try {
    const config = brainConfigSchema.parse({ reranker: { enabled: false }, taxonomy: { types: { ritual: { dir: "rituals" } }, tags: { aliases: { seafaring: "voyage" }, inflection: "off" } } });
    const modules = modulesFor(f, root);
    const taxonomy = buildTaxonomy({ user: config, modules });
    for (const [path, raw] of Object.entries(f.files)) {
      if (path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p.startsWith("."))) throw new Error("Unsafe fixture path");
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), raw);
    }
    const dbPath = join(root, "brain.db"); const db = openDatabase(dbPath);
    try { await indexAll(db, { root, taxonomy, force: true, quiet: true }); } finally { db.close(); }
    const brain = { root, config, modules, taxonomy, dbPath, configPath: null };
    return { brain, root, config, taxonomy, modules, close: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

/** Serial callers only: preserve actual command parsing and provider fallback semantics. */
export async function commandOutput(p: Awaited<ReturnType<typeof prepareBenchmark>>, fix = false, completions?: CompletionProvider) {
  let output: unknown; const original = console.log;
  console.log = (...args: unknown[]) => { output = JSON.parse(String(args[0])); };
  try { await auditCommand.run(fix ? ["--fix"] : [], { json: true, brain: p.brain, completions }); }
  finally { console.log = original; }
  if (output === undefined) throw new Error("Actual audit command emitted no JSON");
  return output;
}
export function fileMap(p: Awaited<ReturnType<typeof prepareBenchmark>>, f: BenchmarkCase) {
  return Object.fromEntries(Object.keys(f.files).sort().map(path => [path, readFileSync(join(p.root, path), "utf8")]));
}
export async function detect(p: Awaited<ReturnType<typeof prepareBenchmark>>) {
  const report = await commandOutput(p) as ReturnType<typeof auditTotals> & { issues: AuditIssue[] };
  const db = openDatabase(p.brain.dbPath);
  try {
    const docs = new Map(loadAuditDocs(db).map(d => [d.path, d]));
    const findings = report.issues.map(issue => {
      const inspected = capability(p.root, p.taxonomy, issue, WRITE_DAY, docs);
      return { issue, id: inspected.id, evidence: inspected.evidence };
    });
    return { report, findings, validation: validateDetailed(p.root, p.taxonomy) };
  } finally { db.close(); }
}

export async function capabilityArm(p: Awaited<ReturnType<typeof prepareBenchmark>>, f: BenchmarkCase, issues: AuditIssue[]) {
  const db = openDatabase(p.brain.dbPath);
  let inspected;
  try {
    const docs = new Map(loadAuditDocs(db).map(d => [d.path, d]));
    inspected = issues.map(issue => ({ issue, capability: capability(p.root, p.taxonomy, issue, WRITE_DAY, docs) }));
  } finally { db.close(); }
  const previewFiles = { ...fileMap(p, f) };
  for (const row of inspected) for (const index of row.capability.plan?.indexes ?? []) if (index.next !== null) previewFiles[index.path] = index.next;
  const effects = inspected.map(row => ({ id: row.capability.id, ...applyFixtureCandidate(p.root, p.taxonomy, row.issue, WRITE_DAY, f.authorization) }));
  const effectFiles = fileMap(p, f);
  const nextDb = openDatabase(p.brain.dbPath);
  try { await indexAll(nextDb, { root: p.root, taxonomy: p.taxonomy, force: true, quiet: true }); } finally { nextDb.close(); }
  const after = await detect(p);
  const repeated = issues.map(issue => applyFixtureCandidate(p.root, p.taxonomy, issue, WRITE_DAY, f.authorization));
  return {
    suggestions: inspected.map(({ issue, capability: c }) => ({ id: c.id, path: issue.path, category: issue.category, issue: issue.message, suggestion: c.suggestion, canAutoFix: c.handlerAvailable, executionAuthorized: c.handlerAvailable && f.authorization, handler: c.handler, reason: c.reason })),
    previewFiles, effectFiles, effects, repeated, after,
  };
}

export async function keylessProof() {
  const rows = [];
  for (const f of cases) {
    const p = await prepareBenchmark(f);
    try {
      const detected = await detect(p);
      const manual = await commandOutput(p, true);
      if (!isDeepStrictEqual(fileMap(p, f), f.files)) throw new Error(`${f.id}: audit changed source bytes`);
      const start = performance.now(); const candidate = await capabilityArm(p, f, detected.report.issues);
      const available = candidate.suggestions.filter(s => s.canAutoFix).map(s => s.path).sort();
      const checks = {
        availability: isDeepStrictEqual(available, [...f.expectedAvailablePaths].sort()),
        preview: isDeepStrictEqual(candidate.previewFiles, f.expectedPreviewFiles),
        effect: isDeepStrictEqual(candidate.effectFiles, f.expectedEffectFiles),
        repeatedNoOp: candidate.repeated.every(r => r.written.length === 0),
        manualCount: Array.isArray(manual) && manual.length === detected.report.issues.length,
        authorizedFindingCleared: !f.authorization || available.every(path => !candidate.after.report.issues.some(i => i.path === path && i.category === "index-stale")),
        otherFindingsPreserved: isDeepStrictEqual(detected.report.issues.filter(i => !(f.authorization && available.includes(i.path) && i.category === "index-stale")), candidate.after.report.issues),
        validationBoundary: f.validationRules.every(rule => detected.validation.some(v => v.detail.rule === rule)),
      };
      rows.push({ id: f.id, split: f.split, detected, manual, candidate, durationMs: performance.now() - start, checks });
    } finally { p.close(); }
  }
  return { kind: "actual-command-keyless-proof", detectionDay: new Date().toISOString().slice(0, 10), writeDay: WRITE_DAY, rows, allChecksPassed: rows.every(r => Object.values(r.checks).every(Boolean)) };
}
if (import.meta.main) console.log(JSON.stringify(await keylessProof(), null, 2));
