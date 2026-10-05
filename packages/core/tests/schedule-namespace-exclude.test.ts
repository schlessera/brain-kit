/**
 * Scheduled-task definitions are host-managed content (#914): Git carries
 * them, but no ordinary content scan treats them as documents, and rebuilding
 * the disposable index never touches them.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { getMarkdownFiles } from "../src/lib/indexer/scan";
import { buildTaxonomy } from "../src/lib/taxonomy";

const temps: string[] = [];
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const DEFINITION = '---\nschedule_schema: 1\nid: "task_ithaca_review"\n---\nRead notes/ithaca.md and report outstanding checks.';

test("the reserved schedule namespace is excluded from indexing, and a forced rebuild leaves it intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-schedule-exclude-"));
  temps.push(root);
  mkdirSync(join(root, "context/scheduled-tasks/definitions"), { recursive: true });
  mkdirSync(join(root, "context/scheduled-tasks/retired"), { recursive: true });
  writeFileSync(join(root, "context/scheduled-tasks/definitions/task_ithaca_review.md"), DEFINITION);
  writeFileSync(join(root, "context/scheduled-tasks/retired/task_old.md"), DEFINITION);
  writeFileSync(join(root, "context/ithaca.md"), "---\ntitle: Ithaca\ntype: context\n---\n\nThe harbor at Ithaca.\n");
  // A sibling whose name only starts like the namespace stays ordinary content.
  mkdirSync(join(root, "context/scheduled-tasks-notes"));
  writeFileSync(join(root, "context/scheduled-tasks-notes/plan.md"), "---\ntitle: Plan\ntype: context\n---\n\nPlan.\n");
  const taxonomy = buildTaxonomy({});
  expect(getMarkdownFiles(root, taxonomy)).toEqual(["context/ithaca.md", "context/scheduled-tasks-notes/plan.md"]);
  const db = openDatabase(join(root, "brain.db"));
  try {
    await indexAll(db, { root, taxonomy, quiet: true, graph: false, force: true });
    const paths = (db.prepare("SELECT path FROM documents ORDER BY path").all() as { path: string }[]).map((r) => r.path);
    expect(paths).toEqual(["context/ithaca.md", "context/scheduled-tasks-notes/plan.md"]);
  } finally { db.close(); }
  expect(readFileSync(join(root, "context/scheduled-tasks/definitions/task_ithaca_review.md"), "utf8")).toBe(DEFINITION);
});
