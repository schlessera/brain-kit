/**
 * #1648: the brain's writer gate. Turns and credential-free maintenance hold
 * it shared; credentialed maintenance holds it exclusively and waits until no
 * shared holder remains; a holder whose process died never blocks anyone.
 * The server and the cron runner are separate processes, so it lives in the
 * UI database: two handles on one file stand in for the two processes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkerSandbox, workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";
import { createUiDb } from "../src/db/client";
import { createWriterGate, markUnpinnedHostWriter, processAlive, processStart } from "../src/brain/writer-gate";

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


test("a peer inherits retired provider folders from the active cross-process gate and pins their topology", async () => {
  const w = world();
  mkdirSync(join(w.brain, "context/policies"), { recursive: true });
  mkdirSync(join(w.brain, "group/private"), { recursive: true });
  const policy = join(w.brain, "context/policies/governance.md");
  writeFileSync(policy, "---\nschema_version: 1\nproviders:\n  - paths: [group/private/**]\n    allow: [anthropic]\n---\nAthena restricts a whole folder.\n");
  try {
    const first = await w.server.acquire("shared", "turn:odysseus");
    try {
      expect(first.folderPaths).toEqual(["group/private"]);
      writeFileSync(policy, "---\nschema_version: 1\nproviders: []\n---\nAthena retires the restriction.\n");
      const second = await w.cron.acquire("shared", "turn:athena");
      try {
        const sandbox = prepareWorkerSandbox(w.brain, { profile: "governed", areas: [], folderPaths: second.folderPaths });
        expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
        const child = Bun.spawnSync(workerCommand({ brainPath: w.brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", `
          if mv group/private group/moved 2>/dev/null; then echo ROOT_RENAMED; exit 41; fi
          if mv group group-moved 2>/dev/null; then echo ANCESTOR_RENAMED; exit 42; fi
          printf Athena > group/private/new.md || exit 43
          printf Odysseus > group/public.md || exit 44
        `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
        expect(child.exitCode, `INHERITED_GATE_PLAN_REACHES_NATIVE_FOLDER_PINS: ${child.stdout.toString()} ${child.stderr.toString()}`).toBe(0);
        expect(second.folderPaths, "ACTIVE_PEER_FOLDER_PLAN_SURVIVES_POLICY_REMOVAL").toEqual(["group/private"]);
      } finally { second.release(); }
    } finally { first.release(); }
    const after = await w.cron.acquire("shared", "turn:circe");
    expect(after.folderPaths, "RETIRED_FOLDER_PLAN_EXPIRES_WITH_ITS_LAST_HOLDER").toEqual([]);
    after.release();
  } finally { w.close(); }
});


describe("unpinned host writer provenance", () => {
  function protectedWorld() {
    const w = world();
    mkdirSync(join(w.brain, "context/policies"), { recursive: true });
    writeFileSync(join(w.brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena restricts a folder.\n");
    return w;
  }

  test("known host writers remain concurrent while governed folder admission refuses their advisory roots", async () => {
    const w = protectedWorld();
    try {
      const first = await w.server.acquire("shared", "host:odysseus");
      markUnpinnedHostWriter(first);
      const second = await w.cron.acquire("shared", "host:athena");
      markUnpinnedHostWriter(second);
      expect(w.server.holders()).toHaveLength(2);
      const candidate = await w.server.acquire("shared", "turn:circe");
      expect(candidate.folderPaths).toEqual(["group/private"]);
      expect(() => candidate.assertPeerFolderPlans!(["group/private"]), "UNPINNED_HOST_ROOTS_NEVER_AUTHORIZE_GOVERNED_ADMISSION").toThrow("unpinned host writer");
      first.release(); second.release();
      expect(() => candidate.assertPeerFolderPlans!(["group/private"])).not.toThrow();
      candidate.release();
    } finally { w.close(); }
  });

  test("the inverse admission ordering refuses a late host before it can invalidate a native peer", async () => {
    const w = protectedWorld();
    try {
      const native = await w.server.acquire("shared", "turn:odysseus");
      native.assertPeerFolderPlans!(["group/private"]);
      const host = await w.cron.acquire("shared", "host:athena");
      expect(() => markUnpinnedHostWriter(host), "LATE_HOST_CANNOT_INVALIDATE_EXISTING_NATIVE_PINS").toThrow("active peer");
      host.release();
      const nativePeer = await w.cron.acquire("shared", "turn:circe");
      expect(() => nativePeer.assertPeerFolderPlans!(["group/private"])).not.toThrow();
      expect(w.server.holders()).toHaveLength(2);
      nativePeer.release(); native.release();
    } finally { w.close(); }
  });

  test("negative provenance cannot be forged, upgraded, or retained after release", async () => {
    const w = protectedWorld();
    try {
      const host = await w.server.acquire("shared", "host:odysseus");
      expect(() => markUnpinnedHostWriter({ ...host })).toThrow("cannot be recorded");
      markUnpinnedHostWriter(host);
      expect(() => host.retainFolders!(["group/private"])).toThrow("cannot upgrade");
      expect(() => host.assertPeerFolderPlans!(["group/private"])).toThrow("cannot qualify");
      expect(w.db.query("SELECT folder_topology FROM writer_gate WHERE id = ?").get(host.id)).toEqual({ folder_topology: JSON.stringify({ kind: "unpinned_host", roots: ["group/private"] }) });
      host.release(); host.release();
      expect(() => markUnpinnedHostWriter(host)).toThrow("cannot be recorded");
      expect(w.server.holders()).toEqual([]);
    } finally { w.close(); }
  });

  test("unknown legacy peers refuse both host classification and protected admission", async () => {
    const w = protectedWorld();
    try {
      const legacy = await w.server.acquire("shared", "legacy:odysseus");
      w.db.query("UPDATE writer_gate SET folder_topology = NULL WHERE id = ?").run(legacy.id);
      const candidate = await w.cron.acquire("shared", "candidate:athena");
      expect(() => markUnpinnedHostWriter(candidate)).toThrow("unknown folder provenance");
      expect(() => candidate.assertPeerFolderPlans!(["group/private"])).toThrow("unaccounted");
      candidate.release(); legacy.release();
    } finally { w.close(); }
  });
});
