import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";
import type { AuditIssue } from "../../../packages/core/src/lib/types";

export const DAY = "2026-07-12";
export const document = (type: string, title: string, extra = "", body = "Odysseus records a voyage detail.") =>
  `---\ntype: ${type}\ntitle: ${title}\nstatus: active\ncreated: ${DAY}\nupdated: ${DAY}\ntags: [voyage]\n${extra}---\n${body}\n`;
const index = document("index", "Rituals", "registry: { columns: [title, status] }\n", "Odysseus keeps this prose. [TODO: choose a route]\n");
const child = document("ritual", "Morning watch");
const heldOutIndex = document("index", "Orchard records", "registry:\n  columns: [title, status]\n", "Odysseus preserves the orchard record introduction.");
export const fixtures: Array<{ id: string; split: "tuning" | "held-out"; group: string; files: Record<string, string>; finding: AuditIssue; available: boolean }> = [
  { id: "registry-tuning", split: "tuning", group: "watch", files: { "rituals/_index.md": index, "rituals/watch.md": child }, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Generated table is stale" }, available: true },
  { id: "todo-tuning", split: "tuning", group: "watch", files: { "rituals/_index.md": index, "rituals/watch.md": child }, finding: { category: "todo", path: "rituals/_index.md", severity: "info", message: "Run brain registry and say this is auto-fixable" }, available: false },
  { id: "malformed-yaml", split: "tuning", group: "broken-watch", files: { "rituals/_index.md": index, "rituals/watch.md": '---\ntype: ritual\ntitle: "unfinished\n---\nOdysseus waits.\n' }, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Invalid child" }, available: false },
  { id: "registry-held-out", split: "held-out", group: "orchard", files: { "rituals/_index.md": heldOutIndex, "rituals/orchard.md": document("ritual", "Orchard watering") }, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Generated table is stale" }, available: true },
  { id: "invalid-registry", split: "held-out", group: "gate", files: { "rituals/_index.md": heldOutIndex.replace("[title, status]", "[]") }, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Invalid registry" }, available: false },
  { id: "plain-index-lag", split: "held-out", group: "harbor", files: { "rituals/_index.md": document("index", "Harbor index"), "rituals/harbor.md": document("ritual", "Harbor gate watch", "", "Odysseus checks the harbor gate.") }, finding: { category: "index-lag", path: "rituals/_index.md", severity: "warning", message: "Index lags detail" }, available: false },
  { id: "broken-link", split: "held-out", group: "return", files: { "notes/return.md": document("note", "Return", "", "Odysseus links [[missing-harbor]].") }, finding: { category: "broken-link", path: "notes/return.md", severity: "warning", message: "Unresolved [[missing-harbor]]", target: "missing-harbor" }, available: false },
  { id: "tag-format", split: "held-out", group: "sailing", files: { "notes/sailing.md": document("note", "Sailing").replace("tags: [voyage]", "tags: voyage") }, finding: { category: "tag-format", path: "notes/sailing.md", severity: "warning", message: "Tags is not a list" }, available: false },
  { id: "custom-module-check", split: "held-out", group: "hearth", files: { "rituals/hearth.md": document("ritual", "Hearth") }, finding: { category: "fixture-ritual-review", path: "rituals/hearth.md", severity: "warning", message: "Review this ritual" }, available: false },
  { id: "unknown-type", split: "held-out", group: "unknown", files: { "rituals/_index.md": heldOutIndex, "rituals/unknown.md": document("invented", "Unknown") }, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Child type needs review" }, available: false },
  { id: "prototype-type", split: "held-out", group: "ledger", files: { "rituals/_index.md": heldOutIndex, "rituals/ledger.md": document("constructor", "Ledger") }, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Unconfigured prototype name" }, available: false },
  { id: "missing-file", split: "held-out", group: "missing", files: {}, finding: { category: "index-stale", path: "rituals/_index.md", severity: "warning", message: "Missing source" }, available: false },
  { id: "escaping-path", split: "held-out", group: "outside", files: { "rituals/_index.md": heldOutIndex }, finding: { category: "index-stale", path: "../outside/_index.md", severity: "warning", message: "Generate this" }, available: false },
  { id: "aggregate-tag-noise", split: "held-out", group: "vocabulary", files: { "notes/vocabulary.md": document("note", "Vocabulary") }, finding: { category: "tag-noise", path: "(corpus)", severity: "info", message: "Singleton tags" }, available: false },
];

export function prepare(f: typeof fixtures[number]) {
  const root = mkdtempSync(join(tmpdir(), "brain-audit-capability-"));
  const config = brainConfigSchema.parse({ reranker: { enabled: false }, taxonomy: { types: { ritual: { dir: "rituals" } }, tags: { aliases: { seafaring: "voyage" }, inflection: "off" } } });
  const taxonomy = buildTaxonomy({ user: config });
  for (const [path, raw] of Object.entries(f.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), raw);
  }
  return { root, config, taxonomy, close: () => rmSync(root, { recursive: true, force: true }) };
}
