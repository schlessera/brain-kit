/** The writer gate's transactions commit on the write worker (#2850). */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createWriterGate, HostFallbackRefusedError, markUnpinnedHostWriter } from "../src/brain/writer-gate.js";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { expectRejection } from "./helpers/expect-rejection.js";
import { watchWriteSites } from "./helpers/write-sites.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "writer-gate-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(brain);
  const db = createUiDb(path), writer = openSqliteWriter(db);
  return { root, brain, path, db, writer, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const GATE_TABLES = ["writer_gate", "writer_gate_turn_waiters", "provider_type_folders"];
const row = (f: ReturnType<typeof fixture>, id: string) => f.db.query("SELECT folder_topology FROM writer_gate WHERE id = ?").get(id) as { folder_topology: string } | null;
/** A worker commit held for `ms`, as a slow fsync would; call `hold` to queue one ahead of what follows. */
const slowCommits = async (f: ReturnType<typeof fixture>) => {
  const channel = f.writer.channel(probe, { table: "odysseus_log" }); await channel.ready;
  return { hold: (ms: number) => channel.call("slow", "Calypso", ms) };
};

test("the gate's transactions commit on the write worker at FULL, never on the app connection", async () => {
  const f = fixture();
  try {
    expect(f.writer.offloop).toBe(true);
    const sites = await watchWriteSites(f.db, f.writer, GATE_TABLES);
    const gate = createWriterGate(f.db, f.brain, { writer: f.writer, pollMs: 5 });
    const turn = await gate.acquire("shared", "turn:voyage", { turn: true });
    await gate.rememberTypeFolders("policy-hash", ["notes"]);
    expect(await turn.retainFolders!([]), "GATE_RETAIN_COMMITS_ON_WORKER").toEqual([]);
    await turn.assertPeerFolderPlans!([]);
    await turn.release();
    const revert = await gate.acquire("exclusive", "revert:ithaca", { queueTurns: true });
    await revert.release();
    const host = await gate.acquire("shared", "host:odysseus");
    await markUnpinnedHostWriter(host);
    expect(JSON.parse(row(f, host.id)!.folder_topology), "GATE_UNPINNED_COMMITS_ON_WORKER").toEqual({ kind: "unpinned_host", roots: [] });
    await host.release();
    await gate.assertUngatedHostFallback();
    await gate.settled();
    const log = await sites.log();
    expect(new Set(log), "GATE_TABLES_WRITTEN_ON_WORKER").toEqual(new Set(GATE_TABLES));
    expect(gate.holders(), "GATE_RELEASES_COMMITTED").toEqual([]);
  } finally { await f.close(); }
});

test("a release counts for this process's next acquisition at once, and settles once it has committed", async () => {
  const f = fixture();
  try {
    // A poll this long would time the test out: the next acquisition must not need one.
    const gate = createWriterGate(f.db, f.brain, { writer: f.writer, pollMs: 60_000 });
    const first = await gate.acquire("exclusive", "storage:odysseus");
    const commits = await slowCommits(f);
    const slow = commits.hold(300);
    const released = first.release();
    expect(row(f, first.id), "GATE_RELEASE_NOT_COMMITTED_ON_LOOP").not.toBeNull();
    let settled = false;
    void released.then(() => { settled = true; });
    const next = gate.acquire("exclusive", "revert:ithaca");
    await Bun.sleep(50);
    expect(settled, "GATE_RELEASE_SETTLES_AFTER_ITS_COMMIT").toBe(false);
    await slow;
    await released;
    expect(row(f, first.id), "GATE_RELEASE_COMMITTED").toBeNull();
    // Without seeing the release it would wait a whole poll.
    expect(await Promise.race([next.then(() => "acquired"), Bun.sleep(5_000).then(() => "polled")]), "GATE_NEXT_ACQUISITION_SEES_EARLIER_RELEASE").toBe("acquired");
    await (await next).release();
  } finally { await f.close(); }
});

test("a host writer runs only after its downgrade commits, and not if the boundary changed meanwhile", async () => {
  const f = fixture();
  try {
    const gate = createWriterGate(f.db, f.brain, { writer: f.writer, pollMs: 5 });
    // Downgrade order: the promise settles only after the row says unpinned.
    const hold = await gate.acquire("shared", "host:odysseus");
    const commits = await slowCommits(f);
    let slow = commits.hold(300);
    const marked = markUnpinnedHostWriter(hold);
    expect(JSON.parse(row(f, hold.id)!.folder_topology), "GATE_UNPINNED_NOT_YET_COMMITTED").toEqual([]);
    await marked;
    expect(JSON.parse(row(f, hold.id)!.folder_topology), "GATE_UNPINNED_COMMITTED_BEFORE_SETTLING").toEqual({ kind: "unpinned_host", roots: [] });
    await slow;
    await hold.release();
    // The boundary turns isolated while the downgrade waits behind a slow
    // commit, queued just before it: nothing spawns, on either host path.
    for (const method of ["run", "launch"] as const) {
      let history = false;
      const ran = join(f.root, `ran-${method}`);
      // Once the hold is granted, a slow commit queues ahead of the downgrade
      // and the boundary turns isolated while it waits.
      const racing = { ...gate, async acquire(...args: Parameters<typeof gate.acquire>) {
        const granted = await gate.acquire(...args);
        slow = commits.hold(300); setTimeout(() => { history = true; }, 50);
        return granted;
      } };
      const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.path, requireGate: true, gate: () => racing, history: () => history,
        workerHost: () => ({ ok: false, requirement: "fictional never-governed fixture" }) });
      expect(boundary.isolated()).toBe(false);
      const execution = { argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran")`],
        env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared" as const, purpose: "Odysseus host writer" };
      await expectRejection(boundary[method](execution), "worker boundary changed", `GATE_HOST_REFUSED_WHEN_BOUNDARY_CHANGED_DURING_ADMISSION_${method}`);
      expect(existsSync(ran), `GATE_HOST_CHILD_NEVER_SPAWNED_${method}`).toBe(false);
      await slow;
      await gate.settled();
      expect(gate.holders(), `GATE_REFUSED_HOST_RELEASED_${method}`).toEqual([]);
    }
  } finally { await f.close(); }
});

test("a policy refusal keeps its class across the worker", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.brain, "context/policies"), { recursive: true });
    await Bun.write(join(f.brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [\n---\n");
    const gate = createWriterGate(f.db, f.brain, { writer: f.writer, pollMs: 5 });
    const host = await gate.acquire("shared", "host:odysseus");
    await expectRejection(markUnpinnedHostWriter(host), HostFallbackRefusedError, "GATE_REFUSAL_CLASS_KEPT_ACROSS_WORKER");
    await expectRejection(gate.assertUngatedHostFallback(), HostFallbackRefusedError, "GATE_UNGATED_REFUSAL_CLASS_KEPT_ACROSS_WORKER");
    await host.release();
  } finally { await f.close(); }
});
