import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { audit } from "../../packages/core/src/lib/auditor";
import { brainConfigSchema } from "../../packages/core/src/lib/config";
import { openDatabase } from "../../packages/core/src/lib/db";
import { editFrontmatter } from "../../packages/core/src/lib/frontmatter-edit";
import { indexAll } from "../../packages/core/src/lib/indexer";
import { buildTaxonomy } from "../../packages/core/src/lib/taxonomy";
import type { Label } from "./score";

export interface Case {
  id: string;
  split: "tuning" | "held-out";
  scope: string | null;
  sources: { path: string; before: string | null; current: string }[];
  derivative: { path: string; text: string };
  gold: Label;
  reason: string;
}

/** This prototype permits exactly one unquoted updated line; anything else refuses. */
export function preserved(before: string, after: string, day: string): boolean {
  const matches = [...before.matchAll(/^updated: \d{4}-\d{2}-\d{2}$/gm)];
  if (matches.length !== 1) return false;
  const m = matches[0]!;
  return after === before.slice(0, m.index) + `updated: ${day}` + before.slice(m.index + m[0].length);
}

/** Real files, disposable index, shipped editor/indexer/audit. No semantic inference here. */
export async function mechanics(c: Case, day: string) {
  const root = mkdtempSync(join(tmpdir(), "brain-propagation-"));
  const db = openDatabase(":memory:");
  const originals = Object.fromEntries([...c.sources.map(s => [s.path, s.current]), [c.derivative.path, c.derivative.text]]) as Record<string, string>;
  const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: {
    types: { note: { dir: "notes" } },
    propagation: c.sources.map(s => ({ source: s.path, derivatives: c.derivative.path })),
  } }) });
  try {
    for (const [path, raw] of Object.entries(originals)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), raw);
    }
    const inspect = async () => {
      await indexAll(db, { root, taxonomy, quiet: true, embeddings: false, force: true });
      return audit(db, taxonomy, { root, now: new Date(`${day}T12:00:00Z`) });
    };
    const before = await inspect();
    const edited = editFrontmatter(c.derivative.text, { updated: day });
    if (!edited || !preserved(c.derivative.text, edited, day)) throw new Error(`Non-surgical edit: ${c.id}`);
    writeFileSync(join(root, c.derivative.path), edited);
    const after = await inspect();
    const changedPaths = Object.keys(originals).filter(path => readFileSync(join(root, path), "utf8") !== originals[path]);
    const readback = readFileSync(join(root, c.derivative.path), "utf8");
    const fieldsBefore = parseFrontmatter(c.derivative.text).data;
    const fieldsAfter = parseFrontmatter(readback).data;
    const changedFields = [...new Set([...Object.keys(fieldsBefore), ...Object.keys(fieldsAfter)])]
      .filter(key => JSON.stringify(fieldsBefore[key]) !== JSON.stringify(fieldsAfter[key]));
    const otherFieldsBefore = { ...fieldsBefore }; delete otherFieldsBefore.updated;
    const otherFieldsAfter = { ...fieldsAfter }; delete otherFieldsAfter.updated;
    return { id: c.id, propagationBefore: before.filter(i => i.category === "propagation").length,
      propagationAfter: after.filter(i => i.category === "propagation").length,
      otherFindingsBefore: before.filter(i => i.category !== "propagation").map(i => ({ category: i.category, path: i.path, message: i.message })),
      otherFindingsAfter: after.filter(i => i.category !== "propagation").map(i => ({ category: i.category, path: i.path, message: i.message })),
      changedPaths, changedFields, bodyAndOtherBytesPreserved: preserved(c.derivative.text, readback, day),
      otherFieldsPreserved: JSON.stringify(otherFieldsBefore) === JSON.stringify(otherFieldsAfter) };
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
