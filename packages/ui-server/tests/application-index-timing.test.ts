import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyedLock, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createBrainApplication, inProcessPlanner, type ApplicationPlanner } from "../src/brain/application.js";

// #2835: twenty host writes must not each wait for an index update. Only
// modules that predate the fix are imported, so this fails on the old route
// for the measured reason: each apply waited for the slow index.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "application-index-timing-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test("twenty writes return without waiting for the index; one targeted update covers them all", async () => {
  await inProcessPlanner.index(root, undefined);
  const runs: (readonly string[] | undefined)[] = [];
  // Each update is slow, as a maintenance worker over a large brain is.
  const planner: ApplicationPlanner = { planAdd: inProcessPlanner.planAdd, async index(target, signal, paths) {
    runs.push(paths); await Bun.sleep(1500); return inProcessPlanner.index(target, signal, paths);
  } };
  const receipts: BrainApplicationResult[] = [];
  const apply = createBrainApplication({ root, planner, principalId: "odysseus", turnId: "turn-scheria", signal: new AbortController().signal,
    isAuthorized: () => true, policy: { autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() },
    approve: async () => true, record: result => { receipts.push(result); } });
  const paths = Array.from({ length: 20 }, (_, i) => `notes/scheria-${String(i).padStart(2, "0")}.md`);
  const elapsed: number[] = [];
  for (const path of paths) {
    const started = performance.now();
    const result = await apply({ principalId: "odysseus", turnId: "turn-scheria",
      input: { operation: "write", path, content: `---\ntitle: Scheria ${path}\ntype: note\n---\nNausicaa finds Odysseus ${path}.\n`, expectedBaseHash: null } });
    elapsed.push(performance.now() - started);
    expect(result.ok, result.message).toBe(true);
  }
  expect(median(elapsed), `APPLY_MEDIAN_MS ${JSON.stringify(elapsed.map(ms => Math.round(ms)))}`).toBeLessThan(300);
  expect(runs).toEqual([]);
  for (const result of receipts) {
    expect(result).toMatchObject({ ok: true, indexed: false, indexStatus: "pending" });
    expect(result).not.toHaveProperty("outcome.indexError");
  }
  await (apply as unknown as { indexBatch: { barrier(): Promise<void> } }).indexBatch.barrier();
  expect(runs).toEqual([paths]);
  const core = await import("@schlessera/brain/internal");
  const db = core.openDatabase((await core.initContext({ root })).dbPath);
  try {
    const found = (db.query("SELECT d.path FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH 'Nausicaa' ORDER BY d.path").all() as { path: string }[]).map(row => row.path);
    expect(found).toEqual(paths);
  } finally { db.close(); }
}, 90_000);
