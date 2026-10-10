/**
 * Fixture brains and drivers for the `tests/audit-*` product tests (#1408). The
 * cases were authored for the #841 audit-capability spike
 * (docs/decisions/audit-repair-suggestions.md); only the data and the setup the
 * product tests need are kept here, and every driver calls shipped code.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";
import { openDatabase } from "../../../packages/core/src/lib/db";
import { indexAll } from "../../../packages/core/src/lib/indexer";
import { auditCommand } from "../../../packages/core/src/cli/commands/audit";
import type { auditTotals } from "../../../packages/core/src/lib/auditor";
import type { LoadedModule } from "../../../packages/core/src/lib/module-types";
import type { CompletionProvider } from "../../../packages/core/src/lib/seams";
import type { AuditIssue } from "../../../packages/core/src/lib/types";

export const DAY = "2026-07-12";
export const WRITE_DAY = DAY;

export interface BenchmarkCase {
  id: string; split: "tuning" | "held-out"; entity: string; template: string;
  files: Record<string, string>; authorization: boolean;
  moduleMode: null | "type" | "review" | "missing" | "boundary" | "throw";
  modulePath: string | null; expectedAvailablePaths: string[];
  expectedPreviewFiles: Record<string, string>; expectedEffectFiles: Record<string, string>;
  validationRules: string[]; note: string;
}
export const BENCHMARK_PATH = join(import.meta.dir, "benchmark.json");
export const cases = JSON.parse(readFileSync(BENCHMARK_PATH, "utf8")) as BenchmarkCase[];

const config = () => brainConfigSchema.parse({ reranker: { enabled: false }, taxonomy: { types: { ritual: { dir: "rituals" } }, tags: { aliases: { seafaring: "voyage" }, inflection: "off" } } });

function modulesFor(f: BenchmarkCase, root: string): LoadedModule[] {
  if (!f.moduleMode) return [];
  const path = f.modulePath ?? "notes/entry.md";
  const mod: LoadedModule = { key: "fixture-review", dir: root, config: { path }, manifest: { name: "fixture-review" } };
  if (f.moduleMode === "type") mod.manifest.taxonomy = { types: { "herd-record": { dir: "herd" } } };
  else mod.manifest.hygieneChecks = [ctx => {
    if (f.moduleMode === "throw") throw new Error("The fixture inspection could not run");
    if (f.moduleMode === "review") {
      readFileSync(join(ctx.root, path), "utf8");
      return [{ category: "fixture-source-review", severity: "warning", path, message: "Review the source record before choosing a correction", suggestion: "Read this record and ask its owner to resolve the uncertain detail." }];
    }
    if (f.moduleMode === "missing") return [{ category: "fixture-required-record", severity: "warning", path, message: "A required review record is absent", suggestion: "Ask the owner for the missing record; do not invent its contents." }];
    // Config-shaped escaped path is deliberately reported without reading it.
    return [{ category: "fixture-boundary-review", severity: "warning", path, message: "A configured source path escapes the brain", suggestion: "Review the module configuration; do not access this path." }];
  }];
  return [mod];
}

function write(root: string, files: Record<string, string>) {
  for (const [path, raw] of Object.entries(files)) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p.startsWith("."))) throw new Error("Unsafe fixture path");
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), raw);
  }
}

/** An indexed temporary brain holding one authored case. */
export async function prepareBenchmark(f: BenchmarkCase) {
  const root = mkdtempSync(join(tmpdir(), "brain-audit-fix-"));
  try {
    const parsed = config();
    const modules = modulesFor(f, root);
    const taxonomy = buildTaxonomy({ user: parsed, modules });
    write(root, f.files);
    const dbPath = join(root, "brain.db"); const db = openDatabase(dbPath);
    try { await indexAll(db, { root, taxonomy, force: true, quiet: true }); } finally { db.close(); }
    const brain = { root, config: parsed, modules, taxonomy, dbPath, configPath: null };
    return { brain, root, close: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export const document = (type: string, title: string, extra = "", body = "Odysseus records a voyage detail.") =>
  `---\ntype: ${type}\ntitle: ${title}\nstatus: active\ncreated: ${DAY}\nupdated: ${DAY}\ntags: [voyage]\n${extra}---\n${body}\n`;

/** A stale registry index with one child, and the finding the auditor reports for it. */
export const registryFixture: { files: Record<string, string>; finding: AuditIssue } = {
  files: {
    "rituals/_index.md": document("index", "Rituals", "registry: { columns: [title, status] }\n", "Odysseus keeps this prose. [TODO: choose a route]\n"),
    "rituals/watch.md": document("ritual", "Morning watch"),
  },
  finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Generated table is stale" },
};

/** Single-finding brains for the shipped auditor, module hygiene and tag migration. */
export const findingFixtures: Record<"brokenLink" | "moduleCheck" | "tagNoise", { files: Record<string, string>; finding: AuditIssue }> = {
  brokenLink: {
    files: { "notes/return.md": document("note", "Return", "", "Odysseus links [[missing-harbor]].") },
    finding: { category: "broken-link", path: "notes/return.md", severity: "warning", message: "Unresolved [[missing-harbor]]", target: "missing-harbor" },
  },
  moduleCheck: {
    files: { "rituals/hearth.md": document("ritual", "Hearth") },
    finding: { category: "fixture-ritual-review", path: "rituals/hearth.md", severity: "warning", message: "Review this ritual" },
  },
  tagNoise: {
    files: { "notes/vocabulary.md": document("note", "Vocabulary") },
    finding: { category: "tag-noise", path: "(corpus)", severity: "info", message: "Singleton tags" },
  },
};

/** An unindexed temporary brain holding `files`. */
export function prepare(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "brain-audit-fix-"));
  const parsed = config();
  const taxonomy = buildTaxonomy({ user: parsed });
  write(root, files);
  return { root, config: parsed, taxonomy, close: () => rmSync(root, { recursive: true, force: true }) };
}

type Prepared = Awaited<ReturnType<typeof prepareBenchmark>>;

/** The real `audit [--fix] --json` output for a prepared brain. Serial callers only. */
export async function commandOutput(p: Prepared, fix = false, completions?: CompletionProvider): Promise<unknown> {
  let output: unknown; const original = console.log;
  console.log = (...args: unknown[]) => { output = JSON.parse(String(args[0])); };
  try { await auditCommand.run(fix ? ["--fix"] : [], { json: true, brain: p.brain, completions }); }
  finally { console.log = original; }
  if (output === undefined) throw new Error("Actual audit command emitted no JSON");
  return output;
}

/** The plain audit report for a prepared brain. */
export const detect = async (p: Prepared) =>
  await commandOutput(p) as ReturnType<typeof auditTotals> & { issues: AuditIssue[] };

/** Every source file's text; the disposable SQLite cache is skipped. */
export function fileMap(root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceSnapshot(root)).filter(([, entry]) => entry.kind === "file")
    .map(([path, entry]) => [path, Buffer.from(entry.bytes!, "base64").toString("utf8")]));
}

type SourceEntry = { kind: "file" | "directory" | "symlink" | "other"; mode: number; mtimeNs: string; bytes?: string; target?: string };

/** Every source member's kind, mode, timestamp and bytes; the disposable SQLite cache is skipped. */
export function sourceSnapshot(root: string): Record<string, SourceEntry> {
  const result: Record<string, SourceEntry> = {};
  const disposable = new Set(["brain.db", "brain.db-wal", "brain.db-shm"]);
  function walk(path: string) {
    const full = path ? join(root, path) : root;
    const stat = lstatSync(full, { bigint: true });
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    if (disposable.has(path) && kind === "file") return;
    result[path] = { kind, mode: Number(stat.mode), mtimeNs: String(stat.mtimeNs),
      ...(kind === "file" ? { bytes: readFileSync(full).toString("base64") } : {}),
      ...(kind === "symlink" ? { target: readlinkSync(full) } : {}),
    };
    if (kind === "directory") for (const entry of readdirSync(full).sort()) walk(path ? `${path}/${entry}` : entry);
  }
  walk("");
  return result;
}
