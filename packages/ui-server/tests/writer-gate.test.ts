/**
 * #1648: the brain's writer gate. Turns and credential-free maintenance hold
 * it shared; credentialed maintenance holds it exclusively and waits until no
 * shared holder remains; a holder whose process died never blocks anyone.
 * The server and the cron runner are separate processes, so it lives in the
 * UI database: two handles on one file stand in for the two processes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { createWriterGate, processAlive, processStart } from "../src/brain/writer-gate";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "writer-gate-"));
  dirs.push(dir);
  const path = join(dir, "brain-ui.db");
  const server = createUiDb(path), cron = createUiDb(path);
  return { server: createWriterGate(server, dir, { pollMs: 10 }), cron: createWriterGate(cron, dir, { pollMs: 10 }),
    db: server, brain: realpathSync(dir), close: () => { server.close(); cron.close(); } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

describe("writer gate", () => {
  test("shared holders run side by side; an exclusive one waits for every shared holder, across processes", async () => {
    const w = world();
    try {
      const turn = await w.server.acquire("shared", "governed turn");
      const index = await w.server.acquire("shared", "application index");
      let synced = false;
      const sync = w.cron.acquire("exclusive", "brain sync").then(hold => { synced = true; return hold; });
      await settle();
      expect(synced, "credentialed work is queued while a turn holds the gate").toBe(false);
      turn.release();
      await settle();
      expect(synced, "and while any shared holder remains").toBe(false);
      index.release();
      const hold = await sync;
      expect(synced).toBe(true);
      expect(w.server.holders()).toEqual([{ mode: "exclusive", purpose: "brain sync", pid: process.pid }]);
      hold.release();
      expect(w.server.holders()).toEqual([]);
    } finally { w.close(); }
  });

  test("no shared holder enters while an exclusive one runs", async () => {
    const w = world();
    try {
      const sync = await w.cron.acquire("exclusive", "brain sync");
      let entered = false;
      const turn = w.server.acquire("shared", "governed turn").then(hold => { entered = true; return hold; });
      await settle();
      expect(entered).toBe(false);
      sync.release();
      (await turn).release();
      expect(entered).toBe(true);
    } finally { w.close(); }
  });

  test("a waiting exclusive holder does not hold back new shared holders, so a turn's own maintenance never deadlocks", async () => {
    const w = world();
    try {
      const turn = await w.server.acquire("shared", "governed turn");
      const sync = w.cron.acquire("exclusive", "brain sync");
      // The turn applies a capture: its credential-free index needs the gate shared, now.
      const index = await w.server.acquire("shared", "application index");
      index.release();
      turn.release();
      (await sync).release();
    } finally { w.close(); }
  });

  test("a holder whose process is gone is removed by the next acquisition", async () => {
    const w = world();
    try {
      const gone = Bun.spawnSync(["/bin/true"]);
      w.db.query("INSERT INTO writer_gate (id, brain, mode, purpose, pid, pid_start, acquired_at) VALUES ('dead', ?, 'exclusive', 'crashed sync', ?, 'gone', 0)")
        .run(w.brain, gone.pid);
      expect(processAlive(gone.pid, "gone")).toBe(false);
      const hold = await w.server.acquire("shared", "governed turn");
      expect(w.server.holders().map(h => h.purpose)).toEqual(["governed turn"]);
      hold.release();
    } finally { w.close(); }
  });

  test("a pid reused by another process is not the holder that wrote the row", () => {
    expect(processStart(process.pid)).toMatch(/^\d+$/);
    expect(processAlive(process.pid, processStart(process.pid)!)).toBe(true);
    expect(processAlive(process.pid, "0")).toBe(false);
  });

  test("an aborted wait leaves no row behind", async () => {
    const w = world();
    try {
      const turn = await w.server.acquire("shared", "governed turn");
      const controller = new AbortController();
      const sync = w.cron.acquire("exclusive", "brain sync", { signal: controller.signal });
      await settle();
      controller.abort(new Error("cancelled"));
      await expect(sync).rejects.toThrow("cancelled");
      turn.release();
      expect(w.server.holders()).toEqual([]);
    } finally { w.close(); }
  });
});
