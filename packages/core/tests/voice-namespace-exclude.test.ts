/**
 * Live-conversation personas (#3617, P5) are authored Markdown under
 * `_voice/personas/`. Their instructions only shape how a voice service
 * speaks, so no content scan indexes them: search and context assembly never
 * return them, and a forced rebuild leaves the files intact.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DEFAULT_EXCLUDE } from "../src/lib/config";
import { assembleContext } from "../src/lib/context-assembler";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { getMarkdownFiles } from "../src/lib/indexer/scan";
import { hybridSearch } from "../src/lib/search-engine";

const temps: string[] = [];
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const MARKER = "penelopeloom";
const PERSONA = `---\nschema: 1\nname: Ithaca steward\nvoices:\n  gemini-live: Kore\n---\nSpeak like a ship's steward reporting to Odysseus about the ${MARKER}.\n`;

test("_voice is a default exclusion", () => {
  expect(DEFAULT_EXCLUDE.dirs).toContain("_voice");
});

test("persona files under _voice/personas never reach the index, search or context assembly", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-voice-exclude-"));
  temps.push(root);
  mkdirSync(join(root, "_voice/personas"), { recursive: true });
  writeFileSync(join(root, "_voice/personas/ithaca-steward.md"), PERSONA);
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes/loom.md"), `---\ntitle: Loom\ntype: note\n---\n\nPenelope weaves at the ${MARKER} each day.\n`);
  // A sibling whose name only starts like the namespace stays ordinary content.
  mkdirSync(join(root, "_voice-notes"));
  writeFileSync(join(root, "_voice-notes/plan.md"), `---\ntitle: Plan\ntype: note\n---\n\nThe ${MARKER} plan.\n`);

  const ctx = await initContext({ root });
  expect(getMarkdownFiles(root, ctx.taxonomy)).toEqual(["_voice-notes/plan.md", "notes/loom.md"]);
  const db = openDatabase(ctx.dbPath);
  try {
    await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true, graph: false, force: true });
    const paths = (db.prepare("SELECT path FROM documents ORDER BY path").all() as { path: string }[]).map((r) => r.path);
    expect(paths).toEqual(["_voice-notes/plan.md", "notes/loom.md"]);

    const found = await hybridSearch(db, { query: MARKER, mode: "fts", rerank: "none", now: new Date("2026-07-12") });
    expect(found.results.map((r) => r.path).sort()).toEqual(["_voice-notes/plan.md", "notes/loom.md"]);

    const briefing = await assembleContext(db, ctx, { query: MARKER, maxTokens: 4000, now: new Date("2026-07-12") });
    expect(briefing).toContain("Penelope weaves");
    expect(briefing).not.toContain("ship's steward");
    expect(briefing).not.toContain("_voice/personas");
  } finally { db.close(); }
  expect(readFileSync(join(root, "_voice/personas/ithaca-steward.md"), "utf8")).toBe(PERSONA);
});
