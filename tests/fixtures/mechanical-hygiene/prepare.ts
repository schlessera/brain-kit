/**
 * Fixture brains for `tests/hygiene-reconcile-shipped.test.ts`. The cases were
 * authored for the #842 mechanical-hygiene spike; only the data and the setup
 * the product test needs are kept here, and `reconcileOnce` is the shipped
 * index, detect and reconcile sequence that `brain hygiene reconcile` runs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy, type Taxonomy } from "../../../packages/core/src/lib/taxonomy";
import { openDatabase } from "../../../packages/core/src/lib/db";
import { indexAll, getMarkdownFiles } from "../../../packages/core/src/lib/indexer";
import { detectCandidates, reconcile, type HygieneFix } from "../../../packages/core/src/lib/hygiene";
import { loadAuditDocs } from "../../../packages/core/src/lib/auditor";

export const NOW = new Date("2026-07-12T12:00:00Z");
export const TODAY = "2026-07-12";
const MTIME = new Date("2026-07-11T23:30:00Z");
function document(title: string, created: string, updated: string, body: string, extra = "", type = "context") {
  return `---\ntype: ${type}\ntitle: '${title}'\nstatus: active\ncreated: ${created} # keep this comment\nupdated: '${updated}'\ntags: [voyage]\n${extra}---\n\n${body}\n`;
}
const note = (created: string, updated: string) => document("Odysseus prepares the raft", created, updated, "The mast stays tied.\n\n[VERIFY: inspect the rope]");
const table = "| Link | Status | Updated | Title |\n| --- | --- | --- | --- |\n| [Raft](raft.md) | draft | 2026-07-01 | Raft |";

export interface Fixture { id: string; files: Record<string, string>; repaired: Record<string, string> }
export const fixtures = {
  /** `updated` precedes `created`; the mechanical repair moves both to the later day. */
  datesInverted: { id: "date-mtime-later", files: { "context/raft.md": note("2026-07-10", "2026-07-09") }, repaired: { "context/raft.md": note("2026-07-11", "2026-07-11") } },
  /** A registry row whose Status and Updated cells lag the detail document. */
  singleStatusColumn: { id: "single-status-column", files: { "context/_index.md": document("Voyage registry", "2026-07-01", "2026-07-01", table, "", "index"), "context/raft.md": document("Raft", "2026-07-01", "2026-07-10", "Odysseus checks the sail.") }, repaired: {} },
} satisfies Record<string, Fixture>;

export function prepare(fixture: Fixture) {
  const root = mkdtempSync(join(tmpdir(), "brain-mechanical-hygiene-"));
  const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: { types: { note: { dir: "notes", inbox: true } } } }) });
  const brain = { root, taxonomy, modules: [] };
  for (const [path, raw] of Object.entries(fixture.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), raw);
    utimesSync(join(root, path), MTIME, MTIME);
  }
  const db = openDatabase(":memory:");
  /** One shipped reconciliation: index, detect, then reconcile the log with any applied fixes. */
  const reconcileOnce = async (fixed: HygieneFix[] = []) => {
    await indexAll(db, { root, taxonomy, quiet: true, embeddings: false });
    const detection = await detectCandidates(db, brain, NOW);
    const docs = new Map(loadAuditDocs(db).map(d => [d.path, d]));
    return reconcile(root, detection.candidates, docs, { now: NOW, failedChecks: detection.failedChecks, fixed });
  };
  return { root, brain, reconcileOnce, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

export function snapshot(root: string, taxonomy: Taxonomy) {
  return Object.fromEntries(getMarkdownFiles(root, taxonomy).map(path => [path, { raw: readFileSync(join(root, path), "utf8"), mtimeMs: statSync(join(root, path)).mtimeMs }]));
}
