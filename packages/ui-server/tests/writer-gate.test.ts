/**
 * #1648: the brain's writer gate. Turns and credential-free maintenance hold
 * it shared; credentialed maintenance holds it exclusively and waits until no
 * shared holder remains; a holder whose process died never blocks anyone.
 * The server and the cron runner are separate processes, so it lives in the
 * UI database: two handles on one file stand in for the two processes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkerSandbox, workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";
import { createUiDb } from "../src/db/client";
import { createWriterGate, HostFallbackRefusedError, markUnpinnedHostWriter, processAlive, processStart } from "../src/brain/writer-gate";

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
      expect(first.folderPaths).toEqual([".brain-index", "group/private"]);
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
        expect(second.folderPaths, "ACTIVE_PEER_FOLDER_PLAN_SURVIVES_POLICY_REMOVAL").toEqual([".brain-index", "group/private"]);
      } finally { second.release(); }
    } finally { first.release(); }
    const after = await w.cron.acquire("shared", "turn:circe");
    expect(after.folderPaths, "RETIRED_FOLDER_PLAN_EXPIRES_WITH_ITS_LAST_HOLDER").toEqual([]);
    after.release();
  } finally { w.close(); }
});


describe("a type selector's recorded translation across processes (#2836)", () => {
  const GATE_PROCESS = join(import.meta.dir, "helpers/gate-process.ts");
  const TYPE_POLICY = "---\nschema_version: 1\nproviders: [{ types: [identity], allow: [anthropic] }]\n---\nOnly Anthropic may read who Odysseus is.\n";
  function typeBrain(dir: string, policy = TYPE_POLICY) {
    mkdirSync(join(dir, "context/policies"), { recursive: true });
    mkdirSync(join(dir, "me"), { recursive: true });
    writeFileSync(join(dir, "context/policies/governance.md"), policy);
  }
  /** A writer in its own Bun process, with an empty module cache. */
  function gateProcess(db: string, brain: string, ...args: string[]) {
    return Bun.spawn([process.execPath, GATE_PROCESS, db, brain, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  }
  async function record(db: string, brain: string, folders: string[]) {
    const child = gateProcess(db, brain, "record", JSON.stringify(folders));
    child.stdin.end();
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, `TRANSLATING_PROCESS_EXITED: ${stderr}`).toBe(0);
  }
  /** The plan a new process's writer acquires; the process has exited when this returns. */
  async function planInNewProcess(db: string, brain: string): Promise<string[]> {
    const child = gateProcess(db, brain, "acquire");
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `WRITER_PROCESS_EXITED: ${stderr}`).toBe(0);
    return JSON.parse(stdout) as string[];
  }
  function typeWorld() {
    const dir = mkdtempSync(join(tmpdir(), "writer-gate-types-"));
    dirs.push(dir);
    typeBrain(dir);
    return { brain: realpathSync(dir), db: join(dir, "brain-ui.db") };
  }

  test("a new process plans the folders an exited process translated, under the same policy version", async () => {
    const w = typeWorld();
    await record(w.db, w.brain, ["me"]);
    expect(await planInNewProcess(w.db, w.brain), "RESTARTED_PROCESS_PLANS_THE_RECORDED_TYPE_FOLDERS").toEqual([".brain-index", "me"]);
  });

  test("a translation recorded under another policy version is not planned", async () => {
    const w = typeWorld();
    await record(w.db, w.brain, ["me"]);
    // The same selectors in another policy version: the taxonomy may differ too.
    writeFileSync(join(w.brain, "context/policies/governance.md"), TYPE_POLICY.replace("who Odysseus is", "who the king of Ithaca is"));
    expect(await planInNewProcess(w.db, w.brain), "OTHER_POLICY_VERSION_PLANS_NO_TYPE_FOLDER").toEqual([]);
  });

  test("a translation recorded for one brain is not planned for another under an identical policy", async () => {
    const w = typeWorld();
    const other = mkdtempSync(join(tmpdir(), "writer-gate-types-other-"));
    dirs.push(other);
    typeBrain(other);
    await record(w.db, w.brain, ["me"]);
    expect(await planInNewProcess(w.db, realpathSync(other)), "OTHER_BRAIN_PLANS_NO_TYPE_FOLDER").toEqual([]);
    expect(await planInNewProcess(w.db, w.brain), "RECORDING_BRAIN_STILL_PLANS_IT").toEqual([".brain-index", "me"]);
  });

  test("a recorded folder that is no longer a directory is not planned", async () => {
    const w = typeWorld();
    // The taxonomy moved a type under the same policy: the old folder is gone or aliased.
    symlinkSync(join(w.brain, "me"), join(w.brain, "alias"));
    await record(w.db, w.brain, ["alias", "ithaca", "me"]);
    expect(await planInNewProcess(w.db, w.brain), "ONLY_EXISTING_RECORDED_FOLDERS_PLANNED").toEqual([".brain-index", "me"]);
  });

  test("only the brain's latest translation is kept, and an unreadable one plans nothing", async () => {
    const w = typeWorld();
    const db = createUiDb(w.db);
    try {
      const gate = createWriterGate(db, w.brain, { pollMs: 10 });
      await record(w.db, w.brain, ["me"]);
      mkdirSync(join(w.brain, "ithaca"));
      await record(w.db, w.brain, ["ithaca"]);
      expect(db.query("SELECT folders FROM provider_type_folders").all(), "ONE_BOUNDED_RECORD_PER_BRAIN").toEqual([{ folders: JSON.stringify(["ithaca"]) }]);
      for (const folders of ["not json", JSON.stringify({ roots: ["me"] }), JSON.stringify(["../me"]), JSON.stringify([7])]) {
        db.query("UPDATE provider_type_folders SET folders = ?").run(folders);
        // Neither planned nor in the way: an unreadable record must not stop a writer.
        const hold = await gate.acquire("shared", "cron:odysseus-ledger").catch((error: Error) => error);
        expect(hold instanceof Error ? hold.message : hold.folderPaths, `UNREADABLE_RECORD_PLANS_NOTHING: ${folders}`).toEqual([]);
        if (!(hold instanceof Error)) hold.release();
      }
      db.exec("DROP TABLE provider_type_folders");
      const hold = await gate.acquire("shared", "cron:odysseus-ledger").catch((error: Error) => error);
      expect(hold instanceof Error ? hold.message : hold.folderPaths, "UNREADABLE_TABLE_PLANS_NOTHING").toEqual([]);
      if (!(hold instanceof Error)) hold.release();
    } finally { db.close(); }
  });
});

describe("provider folder admission beside earlier writers (#2832)", () => {
  // A writer admitted before any plan held the folders, as one started with
  // the server is before the first turn has translated a type selector.
  async function earlierWriter(host = false) {
    const w = world();
    const peer = await w.cron.acquire("shared", "brain CLI version");
    expect(peer.folderPaths, "EARLIER_WRITER_PLANS_NO_FOLDER").toEqual([]);
    if (host) markUnpinnedHostWriter(peer);
    mkdirSync(join(w.brain, "context/policies"), { recursive: true });
    mkdirSync(join(w.brain, "group/private"), { recursive: true });
    writeFileSync(join(w.brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena restricts a folder.\n");
    const turn = await w.server.acquire("shared", "turn:odysseus", { turn: true });
    expect(turn.folderPaths).toEqual([".brain-index", "group/private"]);
    return { w, peer, turn, close: () => { peer.release(); turn.release(); w.close(); } };
  }

  test("admission waits for a writer admitted before it retained its folders, then admits", async () => {
    const { w, peer, turn, close } = await earlierWriter();
    try {
      expect(() => turn.assertPeerFolderPlans!(turn.folderPaths!), "THE_EARLIER_WRITER_LACKS_THE_FOLDERS").toThrow("did not retain");
      let settled = false;
      const waiting = turn.waitForPeerFolderPlans!(turn.folderPaths!, { timeoutMs: 10_000 }).finally(() => { settled = true; });
      await settle();
      expect(settled, "ADMISSION_WAITS_WHILE_THE_EARLIER_WRITER_RUNS").toBe(false);
      // A writer admitted meanwhile merges the held folders, so it never extends the wait.
      const later = await w.cron.acquire("shared", "index refresh");
      try {
        expect(later.folderPaths, "A_LATER_WRITER_RETAINS_THE_HELD_FOLDERS").toEqual([".brain-index", "group/private"]);
        peer.release();
        await waiting;
        expect(settled, "ADMITTED_ONCE_THE_EARLIER_WRITER_FINISHED").toBe(true);
      } finally { later.release(); }
    } finally { close(); }
  });

  test("a writer still active at the bound refuses admission", async () => {
    const { turn, close } = await earlierWriter();
    try {
      const started = performance.now();
      await expect(turn.waitForPeerFolderPlans!(turn.folderPaths!, { timeoutMs: 150 }), "A_LASTING_NON_RETAINING_PEER_REFUSES")
        .rejects.toThrow("An active peer did not retain the requested provider folders; finish that peer and retry admission");
      expect(performance.now() - started, "REFUSED_AT_THE_BOUND").toBeGreaterThanOrEqual(140);
    } finally { close(); }
  });

  test("a peer that is unsafe whatever it does next refuses at once, and an aborted wait stops", async () => {
    const host = await earlierWriter(true);
    try {
      const started = performance.now();
      await expect(host.turn.waitForPeerFolderPlans!(host.turn.folderPaths!, { timeoutMs: 10_000 }), "AN_UNPINNED_HOST_PEER_IS_NOT_WAITED_FOR")
        .rejects.toThrow("unpinned host writer");
      expect(performance.now() - started, "REFUSED_WITHOUT_WAITING").toBeLessThan(1000);
    } finally { host.close(); }
    const { turn, close } = await earlierWriter();
    try {
      const abort = new AbortController(), reason = new Error("Odysseus stops the turn");
      setTimeout(() => abort.abort(reason), 50);
      await expect(turn.waitForPeerFolderPlans!(turn.folderPaths!, { signal: abort.signal, timeoutMs: 10_000 }), "AN_ABORTED_WAIT_STOPS").rejects.toBe(reason);
    } finally { close(); }
  });
});

describe("unpinned host writer provenance", () => {
  function protectedWorld() {
    const w = world();
    mkdirSync(join(w.brain, "context/policies"), { recursive: true });
    writeFileSync(join(w.brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena restricts a folder.\n");
    return w;
  }

  const writePolicy = (w: ReturnType<typeof world>, body: string) => {
    mkdirSync(join(w.brain, "context/policies"), { recursive: true });
    writeFileSync(join(w.brain, "context/policies/governance.md"), `---\nschema_version: 1\n${body}---\nAthena edits the policy.\n`);
  };

  test("known host writers remain concurrent while governed folder admission refuses them", async () => {
    const w = world();
    try {
      const first = await w.server.acquire("shared", "host:odysseus");
      markUnpinnedHostWriter(first);
      const second = await w.cron.acquire("shared", "host:athena");
      markUnpinnedHostWriter(second);
      expect(w.server.holders()).toHaveLength(2);
      // A folder policy written while the hosts run applies to later admissions.
      writePolicy(w, "providers: [{ paths: [group/private/**], allow: [anthropic] }]\n");
      const candidate = await w.server.acquire("shared", "turn:circe");
      expect(candidate.folderPaths).toEqual([".brain-index", "group/private"]);
      expect(() => candidate.assertPeerFolderPlans!(["group/private"]), "UNPINNED_HOST_PEERS_NEVER_AUTHORIZE_GOVERNED_ADMISSION").toThrow("unpinned host writer");
      first.release(); second.release();
      expect(() => candidate.assertPeerFolderPlans!(["group/private"])).not.toThrow();
      candidate.release();
    } finally { w.close(); }
  });

  test("an active provider folder policy refuses host classification before any negative record", async () => {
    const w = protectedWorld();
    try {
      const host = await w.server.acquire("shared", "host:odysseus");
      let refusal: unknown;
      try { markUnpinnedHostWriter(host); } catch (error) { refusal = error; }
      expect(refusal, "FOLDER_POLICY_REFUSES_HOST_CLASSIFICATION").toBeInstanceOf(HostFallbackRefusedError);
      expect(String(refusal)).toContain("group/private");
      expect(w.db.query("SELECT folder_topology FROM writer_gate WHERE id = ?").get(host.id), "REFUSED_HOST_KEEPS_ITS_PLAN")
        .toEqual({ folder_topology: JSON.stringify([".brain-index", "group/private"]) });
      host.release();
      const turn = await w.cron.acquire("shared", "turn:circe");
      expect(() => turn.assertPeerFolderPlans!(["group/private"])).not.toThrow();
      turn.release();
    } finally { w.close(); }
  });

  test("an invalid governance policy refuses host classification as unknown folder state", async () => {
    const w = world();
    try {
      writePolicy(w, "providers: [{ paths: [group/private/**] }]\n");
      const host = await w.server.acquire("shared", "host:odysseus");
      expect(() => markUnpinnedHostWriter(host), "INVALID_POLICY_REFUSES_HOST_CLASSIFICATION").toThrow(HostFallbackRefusedError);
      host.release();
      writePolicy(w, "");
      const valid = await w.server.acquire("shared", "host:athena");
      expect(() => markUnpinnedHostWriter(valid), "POLICY_WITHOUT_FOLDERS_KEEPS_HOST_CLASSIFICATION").not.toThrow();
      valid.release();
    } finally { w.close(); }
  });

  test("a peer's retained folders still refuse a late host after the policy is removed", async () => {
    const w = protectedWorld();
    try {
      const native = await w.server.acquire("shared", "turn:odysseus");
      native.assertPeerFolderPlans!(["group/private"]);
      rmSync(join(w.brain, "context/policies/governance.md"));
      const host = await w.cron.acquire("shared", "host:athena");
      expect(host.folderPaths, "REMOVED_POLICY_INHERITS_PEER_ROOTS").toEqual([".brain-index", "group/private"]);
      expect(() => markUnpinnedHostWriter(host), "INHERITED_ROOTS_REFUSE_LATE_HOST").toThrow("active peer");
      host.release(); native.release();
      const after = await w.cron.acquire("shared", "host:circe");
      expect(after.folderPaths).toEqual([]);
      expect(() => markUnpinnedHostWriter(after), "RELEASED_PEER_RESTORES_HOST_CLASSIFICATION").not.toThrow();
      after.release();
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

  test("a legacy host peer's recorded roots refuse a new host after the policy is removed", async () => {
    const w = world();
    try {
      // The peer's roots appear after this host's plan was taken, so only the
      // classification transaction can see them.
      const host = await w.cron.acquire("shared", "host:athena");
      const legacy = await w.server.acquire("shared", "host:odysseus-before-2284");
      w.db.query("UPDATE writer_gate SET folder_topology = ? WHERE id = ?").run(JSON.stringify({ kind: "unpinned_host", roots: ["group/private"] }), legacy.id);
      expect(host.folderPaths).toEqual([]);
      expect(() => markUnpinnedHostWriter(host), "LEGACY_HOST_PEER_ROOTS_REFUSE_HOST_CLASSIFICATION").toThrow(HostFallbackRefusedError);
      expect(() => w.cron.assertUngatedHostFallback(), "LEGACY_HOST_PEER_ROOTS_REFUSE_UNGATED_HOST").toThrow(HostFallbackRefusedError);
      host.release(); legacy.release();
      expect(() => w.cron.assertUngatedHostFallback()).not.toThrow();
    } finally { w.close(); }
  });

  test("an ungated host refuses beside unknown provenance and runs beside known plain plans", async () => {
    const w = world();
    try {
      const plain = await w.server.acquire("shared", "turn:odysseus");
      expect(() => w.cron.assertUngatedHostFallback(), "PLAIN_PEER_KEEPS_UNGATED_HOST").not.toThrow();
      w.db.query("UPDATE writer_gate SET folder_topology = NULL WHERE id = ?").run(plain.id);
      expect(() => w.cron.assertUngatedHostFallback(), "UNKNOWN_PEER_REFUSES_UNGATED_HOST").toThrow(HostFallbackRefusedError);
      plain.release();
    } finally { w.close(); }
  });

  test("negative provenance cannot be forged, upgraded, or retained after release", async () => {
    const w = world();
    try {
      const host = await w.server.acquire("shared", "host:odysseus");
      expect(() => markUnpinnedHostWriter({ ...host })).toThrow("cannot be recorded");
      markUnpinnedHostWriter(host);
      expect(() => host.retainFolders!(["group/private"])).toThrow("cannot upgrade");
      expect(() => host.assertPeerFolderPlans!(["group/private"])).toThrow("cannot qualify");
      expect(w.db.query("SELECT folder_topology FROM writer_gate WHERE id = ?").get(host.id)).toEqual({ folder_topology: JSON.stringify({ kind: "unpinned_host", roots: [] }) });
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
