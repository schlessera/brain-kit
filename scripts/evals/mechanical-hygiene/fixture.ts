import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";
import { openDatabase } from "../../../packages/core/src/lib/db";
import { indexAll, getMarkdownFiles } from "../../../packages/core/src/lib/indexer";
import { detectCandidates, reconcile } from "../../../packages/core/src/lib/hygiene";
import { loadAuditDocs } from "../../../packages/core/src/lib/auditor";
import { apply, capture, plan } from "./prototype";

export const NOW = new Date("2026-07-12T12:00:00Z");
export const TODAY = "2026-07-12";
const MTIME = new Date("2026-07-11T23:30:00Z");
export function document(title: string, created: string, updated: string, body: string, extra = "", type = "context") {
  return `---\ntype: ${type}\ntitle: '${title}'\nstatus: active\ncreated: ${created} # keep this comment\nupdated: '${updated}'\ntags: [voyage]\n${extra}---\n\n${body}\n`;
}
const note = (created: string, updated: string, extra = "") => document("Odysseus prepares the raft", created, updated, "The mast stays tied.\n\n[VERIFY: inspect the rope]", extra);
const old = note("2026-07-10", "2026-07-09");
const fixed = note("2026-07-11", "2026-07-11");
const table = "| Link | Status | Updated | Title |\n| --- | --- | --- | --- |\n| [Raft](raft.md) | draft | 2026-07-01 | Raft |";
const correctedTable = "| Link | Status | Updated | Title |\n| --- | --- | --- | --- |\n| [Raft](raft.md) | active | 2026-07-10 | Raft |";
const index = (body = table, extra = "") => document("Voyage registry", "2026-07-01", "2026-07-01", body, extra, "index");
const detail = document("Raft", "2026-07-01", "2026-07-10", "Odysseus checks the sail.");
const fixedIndex = document("Voyage registry", "2026-07-01", TODAY, correctedTable, "", "index");
export interface Fixture { id: string; split: "tuning" | "held-out"; files: Record<string, string>; expected: Record<string, string>; inbox?: string; mtime?: string }
const noWrite = (id: string, files: Record<string, string>, split: Fixture["split"] = "held-out", inbox?: string): Fixture => ({ id, split, files, expected: files, inbox });
export const fixtures: Fixture[] = [
  { id: "date-mtime-later", split: "tuning", files: { "context/raft.md": old }, expected: { "context/raft.md": fixed } },
  { id: "date-created-later", split: "held-out", mtime: "2026-07-08T12:00:00Z", files: { "context/mast.md": old }, expected: { "context/mast.md": note("2026-07-10", "2026-07-10") } },
  noWrite("equal-dates", { "context/sail.md": note("2026-07-10", "2026-07-10") }, "tuning"),
  noWrite("invalid-date", { "context/sail.md": note("2026-02-30", "2026-02-01") }),
  noWrite("timestamp-not-date", { "context/sail.md": note("2026-07-10T23:30:00-10:00", "2026-07-09") }),
  noWrite("inbox", { "notes/raft.md": old }, "tuning"),
  noWrite("configured-inbox", { "capture/raft.md": old }, "held-out", "capture"),
  noWrite("archived-directory", { "context/archived/raft.md": old }),
  noWrite("archived-status", { "context/raft.md": old.replace("status: active", "status: archived") }),
  noWrite("hygiene-log", { "context/hygiene/observation.md": old }),
  { id: "single-status-column", split: "tuning", files: { "context/_index.md": index(), "context/raft.md": detail }, expected: { "context/_index.md": fixedIndex, "context/raft.md": detail } },
  noWrite("multiple-columns", { "context/_index.md": index(table.replace("| Raft |", "| Old raft |")), "context/raft.md": detail }),
  noWrite("unknown-column", { "context/_index.md": index(table.replace("Title", "Owner")), "context/raft.md": detail }),
  noWrite("updated-only", { "context/_index.md": index(table.replace("| draft |", "| active |")), "context/raft.md": detail }),
  noWrite("duplicate-target", { "context/_index.md": index(table + "\n| [Second raft](raft.md) | draft | 2026-07-01 | Raft |"), "context/raft.md": detail }),
  noWrite("generated-markers", { "context/_index.md": index(`<!-- brain:generated:registry -->\n${table}\n<!-- /brain:generated:registry -->`), "context/raft.md": detail }),
  noWrite("registry-metadata", { "context/_index.md": index(table, "registry:\n  columns: [link, status, updated]\n"), "context/raft.md": detail }),
  noWrite("excluded-detail", { "context/_index.md": index(), "context/raft.md": detail.replace("status: active", "status: archived") }),
  noWrite("code-fence-table", { "context/_index.md": index("```md\n" + table + "\n```"), "context/raft.md": detail }),
  noWrite("duplicate-column", { "context/_index.md": index(table.replace("Title", "Status")), "context/raft.md": detail }),
  noWrite("invalid-detail-status", { "context/_index.md": index(), "context/raft.md": detail.replace("status: active", "status: unknown") }),
  noWrite("ambiguous-wiki-link", { "context/_index.md": index(table.replace("[Raft](raft.md)", "[[raft]]")), "context/raft.md": detail }),
  noWrite("mixed-safe-and-ambiguous-rows", { "context/_index.md": index(table + "\n| [Mast](mast.md) | draft | 2026-07-01 | Wrong mast title |"), "context/raft.md": detail, "context/mast.md": document("Mast", "2026-07-01", "2026-07-10", "Odysseus ties the mast.") }),
  { id: "crlf-date", split: "held-out", files: { "context/rigging.md": old.replaceAll("\n", "\r\n") }, expected: { "context/rigging.md": fixed.replaceAll("\n", "\r\n") } },
];
export const fixtureSha256 = createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");

export function prepare(fixture: Fixture, filler = 0) {
  const root = mkdtempSync(join(tmpdir(), "brain-mechanical-hygiene-"));
  const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: { types: { note: { dir: fixture.inbox ?? "notes", inbox: true } } } }) });
  const brain = { root, taxonomy, modules: [] };
  for (const [path, raw] of Object.entries(fixture.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), raw);
    utimesSync(join(root, path), new Date(fixture.mtime ?? MTIME), new Date(fixture.mtime ?? MTIME));
  }
  for (let i = 0; i < filler; i++) {
    const path = join(root, "context", `unchanged-${i}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, document(`Sail inspection ${i}`, TODAY, TODAY, `Odysseus checks rope ${i}.`));
    utimesSync(path, MTIME, MTIME);
  }
  const db = openDatabase(":memory:");
  const detect = async () => {
    await indexAll(db, { root, taxonomy, quiet: true, embeddings: false });
    return detectCandidates(db, brain, NOW);
  };
  return { root, brain, db, detect, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

export function snapshot(root: string, taxonomy: ReturnType<typeof buildTaxonomy>) {
  return Object.fromEntries(getMarkdownFiles(root, taxonomy).map(path => [path, { raw: readFileSync(join(root, path), "utf8"), mtimeMs: statSync(join(root, path)).mtimeMs }]));
}

/** Real index/detection, private planning/application, then the existing log reconciler. */
export async function cycle(env: ReturnType<typeof prepare>, dryRun = false) {
  const inputs = capture(env.root, env.brain.taxonomy);
  const detection = await env.detect();
  const proposal = plan(inputs, env.brain.taxonomy, detection, TODAY);
  const applied = apply(env.root, proposal, dryRun);
  const after = await env.detect();
  const docs = new Map(loadAuditDocs(env.db).map(d => [d.path, d]));
  const log = reconcile(env.root, after.candidates, docs, {
    now: NOW, dryRun, failedChecks: after.failedChecks,
    fixed: applied.written.map(path => ({ path, fix: "Mechanical prototype repair" })),
  });
  return { detection, proposal, applied, after, log };
}

export async function existingCycle(env: ReturnType<typeof prepare>) {
  const detection = await env.detect();
  const docs = new Map(loadAuditDocs(env.db).map(d => [d.path, d]));
  return reconcile(env.root, detection.candidates, docs, { now: NOW, failedChecks: detection.failedChecks });
}
