import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { connectedSafetySession } from "./helpers/connected-safety.js";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { expectRejection } from "./helpers/expect-rejection.js";
import { closeSync, fstatSync, mkdtempSync, mkdirSync, openSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityStore } from "../src/activity/store.js";
import { createUiDb } from "../src/db/client.js";
import { createNativeJournalCapture } from "../src/brain/native-journal-capture.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { journalStatement } from "../src/brain/journal-store.js";
import { configurationSet } from "../src/brain/journal-configuration-sets.js";
import { recordGovernanceEvent, queryGovernanceEvents } from "../src/governance/events.js";
import { createStatusRoutes } from "../src/routes/health.js";
import { createJournalRoutes } from "../src/routes/journal.js";
import { exportInboxSnapshot } from "../src/inbox/snapshot.js";

function fixture(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "turn-journal-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(brain, "notes", "odysseus.md"), "# Ithaca\r\n");
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  return { root, brain, db, journal, native, begin, async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("reconstructed copied fixtures keep separate inode reservation lifetimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal-restart-odysseus-")), brain = join(root, "brain");
  mkdirSync(brain); writeFileSync(join(brain, "note.md"), "Odysseus returns to Ithaca.");
  const first = createNativeJournalFixture(brain, root);
  let second: ReturnType<typeof createNativeJournalFixture> | undefined;
  const descriptors: number[] = [];
  try {
    const before = await first.manager.checkpoint("before-restart");
    descriptors.push(openSync(join(before.path, "note.md"), "r"));
    await first.manager.release(before.id);
    expect(() => { second = createNativeJournalFixture(brain, root); }, "RESTART_FIXTURE_HAS_OWN_RESERVATIONS").not.toThrow();
    const after = await second!.manager.checkpoint("after-restart");
    descriptors.push(openSync(join(after.path, "note.md"), "r"));
    await second!.manager.release(after.id);
    expect(fstatSync(descriptors[0]!).nlink, "PREDECESSOR_RESERVATION_SURVIVES_RECONSTRUCTION").toBeGreaterThan(0);
    await first.close();
    expect(fstatSync(descriptors[0]!).nlink, "PREDECESSOR_CLOSE_RELEASES_OWN_RESERVATION").toBe(0);
    expect(fstatSync(descriptors[1]!).nlink, "SUCCESSOR_RESERVATION_SURVIVES_PREDECESSOR_CLOSE").toBeGreaterThan(0);
    await second!.close();
    expect(fstatSync(descriptors[1]!).nlink, "SUCCESSOR_CLOSE_RELEASES_OWN_RESERVATION").toBe(0);
  } finally {
    await first.close(); await second?.close();
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});

test("copied checkpoint release reserves file inodes until fixture cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal-inodes-odysseus-")), brain = join(root, "brain");
  mkdirSync(brain); writeFileSync(join(brain, "note.md"), "Odysseus returns to Ithaca.");
  const native = createNativeJournalFixture(brain, root);
  let descriptor: number | undefined;
  try {
    const checkpoint = await native.manager.checkpoint("inode-lifetime");
    descriptor = openSync(join(checkpoint.path, "note.md"), "r");
    await native.manager.release(checkpoint.id);
    expect(existsSync(checkpoint.path), "CHECKPOINT_NAME_IS_RELEASED").toBe(false);
    expect(fstatSync(descriptor).nlink, "RELEASED_COPY_INODE_REMAINS_RESERVED").toBeGreaterThan(0);
    await native.close();
    expect(fstatSync(descriptor).nlink, "FIXTURE_CLOSE_RELEASES_INODE_RESERVATION").toBe(0);
    expect(readFileSync(join(brain, "note.md"), "utf8")).toBe("Odysseus returns to Ithaca.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    await native.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("configuration coverage summary follows retained inventory, independently of missing versions", async () => {
  const f = fixture();
  try {
    expect(f.journal.summary("absent")).not.toHaveProperty("configurationCoverage");
    await f.begin("coverage");
    expect(f.journal.summary("coverage"), "RECORDING_COVERAGE_IS_UNKNOWN").toHaveProperty("configurationCoverage", "unknown");
    await f.journal.finish("coverage");
    expect(f.journal.summary("coverage"), "FINISHED_TURN_RECORDS_EMPTY_SET").toHaveProperty("configurationCoverage", "complete");
    expect(f.journal.summary("coverage"), "EMPTY_SET_HAS_NO_SET_FIELD").not.toHaveProperty("configurationCoverageSet");
    for (const state of ["complete", "recording", "partial", "expired"] as const) {
      for (const incomplete of [false, true]) {
        const set = configurationSet(incomplete ? ["workspaces/412/brain.config.ts"] : []);
        await f.journal.writeOperation([
          journalStatement("INSERT OR IGNORE INTO turn_journal_configuration_sets (hash,paths,count) VALUES (?,?,?)", set.hash, JSON.stringify(set.paths), set.paths.length),
          journalStatement("UPDATE turn_journal_turns SET state=?,configuration_set=?,missing=? WHERE turn_id='coverage'",
            state, set.hash, JSON.stringify([{ path: "notes/odysseus.md", reason: "journal_capacity" }]))]);
        expect(f.journal.summary("coverage"), "COVERAGE_COMES_FROM_CONFIGURATION_INVENTORY")
          .toHaveProperty("configurationCoverage", incomplete ? "incomplete" : state === "complete" ? "complete" : "unknown");
        expect(f.journal.summary("coverage").configurationCoverageSet, "SET_FIELD_ONLY_FOR_NONEMPTY_SET").toBe(incomplete ? set.hash : undefined);
        expect(f.journal.summary("coverage").changedFiles, "COVERAGE_NEVER_CHANGES_PATH_ACCOUNTING").toBe(state === "partial" ? null : 0);
      }
    }
    // A row from before #3257 with an empty array never recorded a set it can prove.
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET state='complete',configuration_set=NULL,steering_inventory_missing='[]' WHERE turn_id='coverage'")]);
    expect(f.journal.summary("coverage"), "LEGACY_EMPTY_ROW_NEVER_COMPLETE").toHaveProperty("configurationCoverage", "unknown");
    expect(f.journal.summary("coverage")).not.toHaveProperty("configurationCoverageSet");
  } finally { await f.close(); }
});

test("identified SQLite sidecars and large coverage retain exact accounting without hiding similarly named content", async () => {
  // Concrete observer/CAS/SQLite with the explicitly synthetic native-record
  // helper: this is capture/accounting proof, not Btrfs-manager qualification.
  const f = fixture(), path = join(f.brain, "ledger.sqlite"), sqlite = new Database(path);
  try {
    writeFileSync(join(f.brain, ".gitignore"), "/ledger.sqlite*\n");
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cargo (id INTEGER PRIMARY KEY,value TEXT); INSERT INTO cargo VALUES (1,'Ithaca');");
    for (let i = 0; i < 733; i++) {
      const dir = join(f.brain, "scripts/config", String(i)); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "brain.config.ts"), "export default {modules: [import(process.env.ODYSSEUS_MODULE)]};\n");
    }
    // Current consumed-input discovery correctly ignores unrelated nested
    // configs. Make every opaque input part of the actual root import graph.
    writeFileSync(join(f.brain, "brain.config.ts"), Array.from({ length: 733 }, (_, i) => `import "./scripts/config/${i}/brain.config.ts";`).join("\n") + "\nexport default {};\n");
    const samples = () => ["", "-wal", "-shm"].filter(suffix => existsSync(path + suffix)).map(suffix => {
      const info = statSync(path + suffix), bytes = readFileSync(path + suffix);
      return { path: `ledger.sqlite${suffix}`, hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, inode: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
    });
    await f.begin("small"); const before = samples();
    const note = "Odysseus returns home.\r\n"; expect(Buffer.byteLength(note)).toBe(24);
    writeFileSync(join(f.brain, "notes/small.md"), note);
    sqlite.query("UPDATE cargo SET value=? WHERE id=1").run("Athena"); const after = samples();
    await f.journal.finish("small");
    const first = f.journal.details("ithaca", "small")!;
    expect(first.summary.changedFiles).toBe(new Set(first.changes.map(change => change.path)).size);
    expect(first.changes.find(change => change.path === "notes/small.md")?.after?.hash).toBe(createHash("sha256").update(note).digest("hex"));
    expect(first.changes.filter(change => change.path.startsWith("ledger.sqlite")).length).toBeGreaterThan(0);
    expect(first.changes.filter(change => change.path.startsWith("ledger.sqlite")).every(change => change.after?.ignored && !change.after?.hash)).toBe(true);
    const coverage = first.missing.filter(item => item.reason === "configuration_inputs_not_fully_identified");
    expect(coverage.filter(item => item.path.startsWith("scripts/config/"))).toHaveLength(733);
    expect(coverage).toHaveLength(734); // Root interpretation is also conservatively unproven.
    expect(first.summary).toHaveProperty("configurationCoverage", "incomplete");
    expect(before.some(old => after.some(current => current.path === old.path && current.hash !== old.hash))).toBe(true);
    await f.begin("host-only"); sqlite.query("UPDATE cargo SET value=? WHERE id=1").run("Penelope"); await f.journal.finish("host-only");
    const second = f.journal.details("ithaca", "host-only")!;
    expect(second.changes.some(change => change.path === "notes/small.md")).toBe(false);
    expect(second.changes.length).toBeGreaterThan(0);
    expect(second.changes.every(change => change.path.startsWith("ledger.sqlite") && change.after?.ignored)).toBe(true);
    await f.begin("deliberate");
    writeFileSync(join(f.brain,"notes/ledger.sqlite-shm"), "Athena deliberately keeps this note.\n");
    writeFileSync(join(f.brain,"scripts/config/0/brain.config.ts"), "export default {modules: []};\n");
    await f.journal.finish("deliberate");
    const deliberate = f.journal.details("ithaca", "deliberate")!;
    expect(deliberate.changes.find(change => change.path === "notes/ledger.sqlite-shm"), "SIMILAR_OPERATIONAL_NAME_REMAINS_CONTENT").toMatchObject({ class: "content", after: { ignored: false } });
    expect(deliberate.changes.find(change => change.path === "scripts/config/0/brain.config.ts"), "GENUINE_CONFIGURATION_CHANGE_REMAINS_STEERING").toMatchObject({ class: "steering" });
    console.log(`JOURNAL_REVIEW_SQLITE_RECEIPT ${JSON.stringify({ writer: "one identified fixture-owned SQLite connection; no agent tools", before, after, changedPaths: first.changes.map(change => change.path), noToolPaths: second.changes.map(change => change.path), coverage: coverage.length })}`);
  } finally { sqlite.close(); await f.close(); }
});

test("the retained journal reads exact before/after versions and ignored listings after the turn ends", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "# Ithaca\r\nReturn by sea.\r\n");
    writeFileSync(join(f.brain, "notes", "athena.md"), "# Athena\n");
    writeFileSync(join(f.brain, "ignored.txt"), "ignored change");
    await f.journal.finish("odysseus");
    const details = f.journal.details("ithaca", "odysseus")!;
    expect(details.summary).toMatchObject({ state: "complete", changedFiles: 3, costUsd: null, profile: "governed" });
    const note = details.changes.find(change => change.path === "notes/odysseus.md")!;
    expect(f.journal.version("ithaca", "odysseus", note.sequence, "before")!.bytes(1024)).toEqual(Buffer.from("# Ithaca\r\n"));
    expect(f.journal.version("ithaca", "odysseus", note.sequence, "after")!.bytes(1024)).toEqual(Buffer.from("# Ithaca\r\nReturn by sea.\r\n"));
    expect(details.changes.find(change => change.path === "ignored.txt")?.after).toMatchObject({ ignored: true, bytes: 14 });
    expect(f.journal.details("other-session", "odysseus")).toBeNull();
  } finally { await f.close(); }
});

test("inline preview enforces the approved raw byte and line boundaries and never coerces binary content", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus");
    writeFileSync(join(f.brain, "large.txt"), "A".repeat(256 * 1024 + 1));
    writeFileSync(join(f.brain, "boundary.txt"), "B".repeat(256 * 1024));
    writeFileSync(join(f.brain, "lines.txt"), Array.from({ length: 5001 }, () => "Ithaca").join("\n"));
    writeFileSync(join(f.brain, "line-boundary.txt"), Array.from({ length: 5000 }, () => "Athena").join("\n"));
    writeFileSync(join(f.brain, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    await f.journal.finish("odysseus");
    const routes = createJournalRoutes({ journal: f.journal });
    const details = f.journal.details("ithaca", "odysseus")!;
    for (const [path, expected] of [["large.txt", { inline: false, reason: "size" }], ["boundary.txt", { inline: true }], ["lines.txt", { inline: false, reason: "lines" }], ["line-boundary.txt", { inline: true }], ["binary.bin", { inline: false, reason: "binary_or_unavailable" }]] as const) {
      const change = details.changes.find(change => change.path === path)!;
      const response = await routes.request(`/sessions/ithaca/turns/odysseus/journal/${change.sequence}/preview`);
      expect(response.status).toBe(200); expect(await response.json(), `JOURNAL_INLINE_BOUNDARY_${path}`).toMatchObject(expected);
    }
  } finally { await f.close(); }
});

test("native admission refuses unavailable storage and changed-version capacity stops work without copying the baseline", async () => {
  const f = fixture(1024 * 1024);
  try {
    writeFileSync(join(f.brain, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024, 65));
    f.native.failNextCheckpoint(Error("native capacity fixture"));
    await expectRejection(f.begin("refused"), "native capacity fixture");
    expect(f.journal.summary("refused").state).toBe("unknown");
    const stopped: Error[] = [];
    await f.journal.begin("running", { sessionId: "ithaca", actor: "voice", model: null, profile: "governed", policyHash: null }, error => stopped.push(error));
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_objects").get(), "NATIVE_BASELINE_RETAINS_NO_UNCHANGED_CONTENT").toEqual({ n: 0 });
    writeFileSync(join(f.brain, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024, 66));
    await expectRejection(f.journal.finish("running"));
    expect(stopped.length, "JOURNAL_OVERFLOW_STOPS_TURN").toBeGreaterThan(0);
    expect(f.journal.details("ithaca", "running")).toMatchObject({ summary: { state: "partial", actor: "voice" }, missing: [{ path: ".", reason: "journal_capacity" }] });
    expect(Bun.file(join(f.brain, "too-large.txt")).size, "JOURNAL_PARTIAL_WORK_REMAINS").toBe(2 * 1024 * 1024);
  } finally { await f.close(); }
});

test("failed policy admission ends its journal row and leaves no raw baseline pins before the next turn", async () => {
  const f = fixture(512 * 1024);
  try {
    // Concrete disk input failure after durable admission row: ignore policy is a directory.
    rmSync(join(f.brain, ".gitignore")); mkdirSync(join(f.brain, ".gitignore"));
    await expectRejection(f.begin("refused-manifest"), "native journal admission could not be prepared");
    await f.journal.finish("refused-manifest");
    expect(f.db.query("SELECT ended_at FROM turn_journal_turns WHERE turn_id='refused-manifest'").get(), "JOURNAL_REFUSED_ADMISSION_ENDED").toMatchObject({ ended_at: expect.any(Number) });
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_object_refs WHERE turn_id='refused-manifest'").get(), "JOURNAL_REFUSED_BASELINE_PINS_RELEASED").toEqual({ n: 0 });
    rmSync(join(f.brain, ".gitignore"), { recursive: true }); writeFileSync(join(f.brain, ".gitignore"), "ignored.txt\n");
    await f.begin("small-next"); await f.journal.finish("small-next");
    expect(f.journal.summary("small-next").state, "JOURNAL_SAME_PROCESS_NEXT_TURN_RECOVERS").toBe("complete");
  } finally { await f.close(); }
});

test("a delayed observation holds authority synchronously until its complete serialized barrier", async () => {
  const f = fixture();
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  try {
    await f.begin("delayed");
    const delta = f.native.manager.delta;
    f.native.manager.delta = async (...args) => { entered(); await blocked; return delta(...args); };
    const observation = f.journal.observe();
    expect(f.journal.isHeld(), "JOURNAL_AUTHORITY_HELD_BEFORE_ASYNC_YIELD").toBe(true);
    await started;
    let idle = false; const waiting = f.journal.idle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle, "JOURNAL_IDLE_WAITS_COMPLETE_NATIVE_BARRIER").toBe(false);
    resume(); await observation; await waiting;
    expect(f.journal.isHeld()).toBe(false); expect(idle).toBe(true);
    f.native.manager.delta = delta;
    await f.journal.finish("delayed");
  } finally { resume(); await f.close(); }
});

test("a previous checkpoint is released after the hold, and a release failure leaves every active turn running", async () => {
  const f = fixture();
  const release = f.native.manager.release;
  let fail: ((error: Error) => void) | undefined, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const stopped: Error[] = [];
    const activity = createActivityStore(f.db);
    for (const id of ["telemachus", "penelope"]) activity.startSpan({ spanId: `${id}:turn`, runId: id, name: "Voyage", kind: "turn", origin: "session" });
    for (const id of ["telemachus", "penelope"])
      await f.journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => stopped.push(error));
    await f.journal.releasesSettled();
    f.native.manager.release = () => new Promise((_resolve, reject) => { fail = reject; entered(); });
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "The suitors are gone.\n");
    const observed = f.journal.observe().then(() => true);
    expect(await Promise.race([observed, Bun.sleep(5_000).then(() => false)]), "JOURNAL_OBSERVATION_ENDS_BEFORE_RELEASE").toBe(true);
    expect(f.journal.isHeld(), "JOURNAL_RELEASE_OUTSIDE_THE_HOLD").toBe(false);
    await started;
    expect(stopped, "JOURNAL_PENDING_RELEASE_STOPS_NOTHING").toEqual([]);
    expect(f.journal.summary("telemachus").state).toBe("recording");
    fail!(new Error("Odysseus release refused"));
    await f.journal.releasesSettled();
    expect(stopped, "JOURNAL_RELEASE_FAILURE_LEAVES_TURNS_RUNNING").toEqual([]);
    await f.journal.idle();
    for (const id of ["telemachus", "penelope"]) expect(f.journal.summary(id).state, `JOURNAL_RELEASE_FAILURE_STILL_RECORDING ${id}`).toBe("recording");
    const diagnostics = f.db.query("SELECT payload FROM activity_events WHERE event_type='checkpoint_release_retry'").all();
    expect(diagnostics, "CHECKPOINT_CAUSE_DURABLE_FOR_BOTH_TURNS").toHaveLength(2);
    expect(JSON.stringify(diagnostics)).toContain("Odysseus release refused");
    f.native.manager.release = release;
    for (const id of ["telemachus", "penelope"]) await f.journal.finish(id);
    expect(f.journal.summary("telemachus").state).toBe("complete");
  } finally { fail?.(new Error("Odysseus cleanup")); f.native.manager.release = release; await f.close(); }
});

test("a release failing during admission preserves admission and resumes its hold", async () => {
  const f = fixture();
  const release = f.native.manager.release;
  try {
    const stopped: Error[] = [], completed: boolean[] = [];
    await f.journal.begin("telemachus", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => stopped.push(error));
    await f.journal.releasesSettled();
    f.journal.onObservation(() => {}, { before() {}, after(ok) { completed.push(ok); } });
    // The release begun by this admission's observation fails before the admission registers its turn.
    f.native.manager.release = async () => { throw new Error("Odysseus release refused"); };
    await f.begin("penelope");
    await f.journal.releasesSettled(); await f.journal.idle();
    expect(f.journal.summary("penelope").state, "JOURNAL_ADMISSION_SURVIVES_RELEASE_FAILURE").toBe("recording");
    expect(stopped, "JOURNAL_RELEASE_FAILURE_STOPS_NOTHING").toEqual([]);
    expect(completed, "JOURNAL_OVERLAPPED_HOLD_RESUMES").toEqual([true]);
    f.native.manager.release = release;
    await f.journal.finish("telemachus"); await f.journal.finish("penelope");
  } finally { f.native.manager.release = release; await f.close(); }
});

test("an admission queued behind other journal work survives a superseded release failure", async () => {
  const f = fixture();
  const release = f.native.manager.release, delta = f.native.manager.delta;
  let fail: ((error: Error) => void) | undefined, resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  try {
    const stopped: Error[] = [];
    await f.journal.begin("telemachus", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => stopped.push(error));
    await f.journal.releasesSettled();
    f.native.manager.release = () => new Promise((_resolve, reject) => { fail = reject; });
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Athena guides the voyage.\n");
    await f.journal.observe();
    f.native.manager.delta = async (...args) => { entered(); await blocked; return delta(...args); };
    const occupied = f.journal.observe(); occupied.catch(() => {});
    await started;
    const queued = f.begin("penelope"); queued.catch(() => {});
    fail!(new Error("Odysseus release refused")); fail = undefined;
    f.native.manager.release = release; f.native.manager.delta = delta; resume();
    await occupied.catch(() => {});
    await queued;
    expect(stopped, "JOURNAL_RELEASE_FAILURE_STOPS_NOTHING").toEqual([]);
    expect(f.journal.summary("penelope").state, "JOURNAL_QUEUED_ADMISSION_SURVIVES_RELEASE_FAILURE").toBe("recording");
    await f.journal.finish("telemachus"); await f.journal.finish("penelope");
  } finally { fail?.(new Error("Odysseus cleanup")); resume(); f.native.manager.release = release; f.native.manager.delta = delta; await f.close(); }
});

test("cancellation while native admission awaits cannot create an active late turn", async () => {
  const f = fixture(), cancellation = new AbortController();
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  const checkpoint = f.native.manager.checkpoint;
  f.native.manager.checkpoint = async (...args) => { entered(); await blocked; return checkpoint(...args); };
  try {
    const pending = f.journal.begin("cancelled", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {}, cancellation.signal);
    void pending.catch(() => {});
    await started; cancellation.abort(Error("Odysseus cancelled admission")); resume();
    await expectRejection(pending, "Odysseus cancelled admission");
    expect(f.journal.summary("cancelled").state, "JOURNAL_CANCELLED_ADMISSION_NEVER_RECORDING").toBe("unknown");
    expect(f.journal.isHeld()).toBe(false);
    f.native.manager.checkpoint = checkpoint;
    await f.begin("next"); await f.journal.finish("next");
    expect(f.journal.summary("next").state).toBe("complete");
  } finally { resume(); await f.close(); }
});

test("cancelling an overlapping admission resumes a healthy peer after its shared observation", async () => {
  const f = fixture(), cancellation = new AbortController();
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  const delta = f.native.manager.delta, completed: boolean[] = [];
  let paused = false;
  try {
    await f.begin("healthy-peer");
    f.journal.onObservation(() => {}, { before() { paused = true; }, after(ok) { completed.push(ok); if (ok) paused = false; } });
    f.native.manager.delta = async (...args) => { entered(); await blocked; return delta(...args); };
    const pending = f.journal.begin("cancelled-peer", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {}, cancellation.signal);
    void pending.catch(() => {});
    await started; expect(paused).toBe(true);
    cancellation.abort(Error("Odysseus cancelled overlapping admission")); resume();
    await expectRejection(pending, "cancelled overlapping admission");
    expect(completed, "CANCELLED_ADMISSION_PRESERVES_HEALTHY_PEER_HOLD").toEqual([true]);
    expect(paused).toBe(false);
    expect(f.journal.summary("cancelled-peer").state).toBe("unknown");
    f.native.manager.delta = delta;
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "The original turn continues.\n");
    await f.journal.finish("healthy-peer");
    expect(f.journal.summary("healthy-peer")).toMatchObject({ state: "complete", changedFiles: 1 });
  } finally { resume(); f.native.manager.delta = delta; await f.close(); }
});

test("a retained raw stream pins its object until the reader ends", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus"); writeFileSync(join(f.brain, "notes", "odysseus.md"), "Athena\n"); await f.journal.finish("odysseus");
    const change = f.journal.details("ithaca", "odysseus")!.changes[0]!;
    const stream = await f.journal.version("ithaca", "odysseus", change.sequence, "before")!.stream();
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='read'").get()).toEqual({ n: 1 });
    expect(await new Response(stream.body).text()).toBe("# Ithaca\r\n");
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='read'").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test("overlapping writable windows both preserve observed shared and disjoint versions with shared attribution", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus"); await f.begin("athena");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Shared return plan");
    writeFileSync(join(f.brain, "notes", "athena.md"), "Athena's observed advice");
    await f.journal.observe();
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Overwritten between observations");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Next observed return plan");
    await f.journal.finish("odysseus"); await f.journal.finish("athena");
    for (const [id, other] of [["odysseus", "athena"], ["athena", "odysseus"]]) {
      const details = f.journal.details("ithaca", id!)!;
      expect(details.summary.sharedAttribution).toBe(true);
      expect(details.changes.find(change => change.path === "notes/athena.md")?.overlappingTurnIds).toEqual([other]);
      const versions = details.changes.filter(change => change.path === "notes/odysseus.md").map(change => f.journal.version("ithaca", id!, change.sequence, "after")?.bytes(1024).toString());
      expect(versions).toEqual(["Shared return plan", "Next observed return plan"]);
      expect(versions).not.toContain("Overwritten between observations");
    }
  } finally { await f.close(); }
});

test("a complete no-change turn has a known zero change count and unknown price; missing history remains unknown", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus"); await f.journal.finish("odysseus");
    expect(f.journal.summary("odysseus")).toMatchObject({ state: "complete", changedFiles: 0, costUsd: null });
    expect(f.journal.summary("unrecorded")).toMatchObject({ state: "unknown", changedFiles: null, costUsd: null });
  } finally { await f.close(); }
});

test("approved policy writes retain user attribution in the original active windows and cannot revive a completed turn", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.brain, "context/policies"), { recursive: true });
    const policy = join(f.brain, "context/policies/governance.md");
    writeFileSync(policy, "Athena's original policy\n");
    await f.begin("odysseus"); await f.begin("athena");
    await f.journal.observeUserPolicy("odysseus", () => writeFileSync(policy, "Odysseus approves the policy\n"));
    for (const id of ["odysseus", "athena"]) {
      const change = f.journal.details("ithaca", id)!.changes.find(change => change.path === "context/policies/governance.md")!;
      expect(change, "JOURNAL_APPROVED_POLICY_ATTRIBUTION").toMatchObject({ class: "policy", actor: "user" });
      expect(change.overlappingTurnIds).toHaveLength(1);
      expect(f.journal.version("ithaca", id, change.sequence, "before")!.bytes(1024).toString()).toBe("Athena's original policy\n");
    }
    await f.journal.finish("odysseus"); await f.journal.finish("athena");
    let executed = false;
    await expectRejection(f.journal.observeUserPolicy("odysseus", () => { executed = true; }), "active complete observation window");
    expect(executed, "JOURNAL_COMPLETED_TURN_NEVER_REVIVED").toBe(false);
  } finally { await f.close(); }
});

test("actual journal classifies steering and local transitive configuration separately from content and policy", async () => {
  const f = fixture();
  try {
    for (const path of [".claude/skills/voyage", ".claude", "config", "hooks", "context/scheduled-tasks", "context/policies"]) mkdirSync(join(f.brain, path), { recursive: true });
    const inputs = {
      ".claude/skills/voyage/SKILL.md": "# Voyage\n",
      "AGENTS.md": "Athena's instructions\n", ".mcp.json": "{}\n",
      ".claude/settings.json": JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "bun ./hooks/voyage.ts" }] }] } }),
      "hooks/voyage.ts": 'import "../config/routes.json";\n',
      "brain.config.ts": 'import "./config/helper.ts"; throw new Error("must never execute config");\n',
      "config/helper.ts": 'import "./routes.json";\n', "config/routes.json": '{"harbour":"Ithaca"}\n',
      "context/scheduled-tasks/voyage.md": "Athena reviews the schedule.\n",
      "context/policies/governance.md": "Original policy\n",
    };
    for (const [path, bytes] of Object.entries(inputs)) writeFileSync(join(f.brain, path), bytes);
    await f.begin("steering");
    for (const [path, bytes] of Object.entries(inputs)) if (path !== "context/policies/governance.md") writeFileSync(join(f.brain, path), bytes + "\n");
    writeFileSync(join(f.brain, "notes/a.md"), "Odysseus returns.\n");
    await f.journal.observeUserPolicy("steering", () => writeFileSync(join(f.brain, "context/policies/governance.md"), "Approved policy\n"));
    await f.journal.finish("steering");
    const details = f.journal.details("ithaca", "steering")!;
    for (const path of Object.keys(inputs).filter(path => path !== "context/policies/governance.md")) expect(details.changes.find(change => change.path === path)?.class, `STEERING_ACTUAL_INPUT_${path}`).toBe("steering");
    expect(details.changes.find(change => change.path === "notes/a.md")?.class).toBe("content");
    expect(details.changes.find(change => change.path === "context/policies/governance.md")).toMatchObject({ class: "policy", actor: "user" });
    expect(details.summary.steeringFiles, "STEERING_COUNT_EXCLUDES_POLICY").toBe(9);
    expect(queryGovernanceEvents(f.db, { turnId: "steering", kinds: ["steering_change"], limit: 100 })).toHaveLength(9);
  } finally { await f.close(); }
});

test("steering retains only taint recorded before observation, including sticky session evidence and overlap", async () => {
  const f = fixture();
  try {
    connectedSafetySession(f.db, "ithaca", "untainted");
    writeFileSync(join(f.brain, "AGENTS.md"), "Original instructions\n");
    await f.begin("untainted"); writeFileSync(join(f.brain, "AGENTS.md"), "First instructions\n"); await f.journal.finish("untainted");
    const source = recordGovernanceEvent(f.db, { kind: "taint", sessionId: "ithaca", turnId: "prior-turn", actor: "interactive", model: null, profile: "governed", payload: { source: "web_fetch", tool: "WebFetch", detail: "Odysseus reads a harbour notice." } });
    await f.begin("odysseus"); await f.begin("athena"); writeFileSync(join(f.brain, "AGENTS.md"), "Shared instructions\n"); await f.journal.finish("odysseus"); await f.journal.finish("athena");
    expect(f.journal.details("ithaca", "untainted")!.changes[0], "STEERING_NO_RETROACTIVE_TAINT").not.toHaveProperty("tainted");
    for (const id of ["odysseus", "athena"]) {
      const change = f.journal.details("ithaca", id)!.changes.find(change => change.path === "AGENTS.md")!;
      expect(change, "STEERING_REAL_TAINT_SOURCE").toMatchObject({ class: "steering", tainted: true, taintSourceEventId: source.id });
      expect(change.overlappingTurnIds).toHaveLength(1);
    }
  } finally { await f.close(); }
});

test("opaque configuration input limitations survive replay without executing code or fabricating a steering dependency", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.brain, "brain.config.ts"), 'import("./" + selectRoute() + ".json"); throw new Error("no host evaluation");\n');
    await f.begin("opaque-config"); writeFileSync(join(f.brain, "notes/a.md"), "Odysseus keeps the route.\n"); await f.journal.finish("opaque-config");
    const replay = createTurnJournal(f.db, { nativeManager: f.native.manager, brainPath: f.brain, dbPath: join(f.root, "ui.db"), objectsRoot: join(f.root, "objects") });
    try {
      const details = replay.details("ithaca", "opaque-config")!;
      expect(details.missing, "STEERING_OPAQUE_INPUT_HONEST_REPLAY").toContainEqual({ path: "brain.config.ts", reason: "configuration_inputs_not_fully_identified" });
      expect(details.changes.find(change => change.path === "notes/a.md")?.class).toBe("content");
    } finally { await replay.close(); }
  } finally { await f.close(); }
});


const OPAQUE_CONFIG = 'import("./" + selectRoute() + ".json"); throw new Error("no host evaluation");\n';
const setRows = (db: Database) => db.query("SELECT hash,paths,count FROM turn_journal_configuration_sets ORDER BY hash").all() as { hash: string; paths: string; count: number }[];
const turnSets = (db: Database, ...ids: string[]) => ids.map(id => db.query("SELECT configuration_set,steering_inventory_missing FROM turn_journal_turns WHERE turn_id=?").get(id) as { configuration_set: string | null; steering_inventory_missing: string });

test("two turns with the same untraced configuration set store its paths once (#3257)", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.brain, "brain.config.ts"), OPAQUE_CONFIG);
    for (const id of ["penelope", "telemachus"]) {
      await f.begin(id); writeFileSync(join(f.brain, `notes/${id}.md`), `${id} waits in Ithaca.\n`); await f.journal.finish(id);
    }
    const rows = setRows(f.db), [first, second] = turnSets(f.db, "penelope", "telemachus");
    expect(rows, "ONE_SET_ROW_FOR_ONE_DISTINCT_SET").toHaveLength(1);
    expect(JSON.parse(rows[0]!.paths)).toContain("brain.config.ts");
    expect(rows[0]!.count).toBe(JSON.parse(rows[0]!.paths).length);
    expect(first!.configuration_set, "TURNS_REFERENCE_THE_SET").toBe(rows[0]!.hash);
    expect(second!.configuration_set, "TURNS_REFERENCE_THE_SET").toBe(rows[0]!.hash);
    expect([first!.steering_inventory_missing, second!.steering_inventory_missing], "NO_PER_TURN_ARRAY").toEqual(["[]", "[]"]);
    expect(f.journal.summary("telemachus")).toMatchObject({ configurationCoverage: "incomplete", configurationCoverageSet: rows[0]!.hash });
    expect(f.journal.details("ithaca", "telemachus")!.missing).toContainEqual({ path: "brain.config.ts", reason: "configuration_inputs_not_fully_identified" });
    // The operational backup copies sets and references like any journal row.
    const backup = await exportInboxSnapshot(f.db, f.brain, 1000);
    const image = Database.deserialize(Buffer.from(backup.database.data, "base64"));
    try {
      expect(image.query("SELECT hash FROM turn_journal_configuration_sets").all(), "BACKUP_KEEPS_SETS").toEqual([{ hash: rows[0]!.hash }]);
      expect(image.query("SELECT count(*) AS n FROM turn_journal_turns WHERE configuration_set=?").get(rows[0]!.hash)).toEqual({ n: 2 });
    } finally { image.close(); }
    // A set lives as long as a turn references it.
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET configuration_set=NULL WHERE turn_id='penelope'")]);
    expect(setRows(f.db), "A_STILL_REFERENCED_SET_STAYS").toHaveLength(1);
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET configuration_set=NULL WHERE turn_id='telemachus'")]);
    expect(setRows(f.db), "UNREFERENCED_SET_IS_RELEASED").toHaveLength(0);
  } finally { await f.close(); }
});

test("per-turn arrays recorded before #3257 move into sets at open and read the same (#3257)", async () => {
  const f = fixture();
  try {
    for (const id of ["achilles", "ajax", "hector", "empty"]) { await f.begin(id); await f.journal.finish(id); }
    const legacy = { achilles: ["scripts/b.ts", "brain.config.ts"], ajax: ["brain.config.ts", "scripts/b.ts"], hector: ["workspaces/412/brain.config.ts"], empty: [] as string[] };
    await f.journal.writeOperation(Object.entries(legacy).map(([id, paths]) =>
      journalStatement("UPDATE turn_journal_turns SET configuration_set=NULL,steering_inventory_missing=? WHERE turn_id=?", JSON.stringify(paths), id)));
    expect(setRows(f.db), "LEGACY_FIXTURE_HAS_NO_SETS").toHaveLength(0);
    const read = (journal: typeof f.journal) => Object.fromEntries(Object.keys(legacy).map(id => [id, {
      coverage: journal.summary(id).configurationCoverage, set: journal.summary(id).configurationCoverageSet,
      missing: journal.details("ithaca", id)!.missing.filter(item => item.reason === "configuration_inputs_not_fully_identified").map(item => item.path).sort(),
    }]));
    const before = read(f.journal);
    expect(before.achilles!.coverage).toBe("incomplete");
    expect(before.empty!.coverage, "LEGACY_EMPTY_ROW_NEVER_COMPLETE").toBe("unknown");
    await f.journal.close();
    const reopened = createTurnJournal(f.db, { nativeManager: f.native.manager, brainPath: f.brain, dbPath: join(f.root, "ui.db"), objectsRoot: join(f.root, "objects") });
    try {
      await reopened.writeOperation([]);
      expect(read(reopened), "MIGRATION_PRESERVES_COVERAGE_AND_MISSING").toEqual(before);
      const rows = setRows(f.db), turns = turnSets(f.db, "achilles", "ajax", "hector", "empty");
      expect(rows, "EQUAL_SETS_IN_ANY_ORDER_SHARE_ONE_ROW").toHaveLength(2);
      expect(turns[0]!.configuration_set).toBe(turns[1]!.configuration_set);
      expect(turns.map(turn => turn.steering_inventory_missing), "ARRAYS_MOVED").toEqual(["[]", "[]", "[]", "[]"]);
      expect(turns[3]!.configuration_set, "LEGACY_EMPTY_STAYS_UNRECORDED").toBeNull();
      expect(before.achilles!.set).toBe(turns[0]!.configuration_set!);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("the brain's current configuration set is the latest complete turn's, and unknown until one records it (#3257)", async () => {
  const f = fixture();
  try {
    const routes = createJournalRoutes({ journal: f.journal });
    const current = async () => { const response = await routes.request("/journal/configuration-coverage"); expect(response.status).toBe(200); return response.json(); };
    expect(await current(), "NO_TURN_IS_UNKNOWN").toEqual({ state: "unknown" });
    await f.begin("legacy"); await f.journal.finish("legacy");
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET configuration_set=NULL,steering_inventory_missing='[]' WHERE turn_id='legacy'")]);
    expect(await current(), "LEGACY_EMPTY_ROW_IS_UNKNOWN_NOT_EMPTY").toEqual({ state: "unknown" });

    // A turn that changes nothing takes no configuration inventory: its empty
    // set covers the turn, not the brain.
    await f.begin("idle"); await f.journal.finish("idle");
    expect(f.journal.summary("idle"), "IDLE_TURN_COVERAGE_UNCHANGED").toHaveProperty("configurationCoverage", "complete");
    expect(await current(), "UNINVENTORIED_TURN_IS_NOT_A_BRAIN_SET").toEqual({ state: "unknown" });

    await f.begin("clean"); writeFileSync(join(f.brain, "notes/clean.md"), "Odysseus sets sail.\n"); await f.journal.finish("clean");
    const clean = await current();
    expect(clean, "RECORDED_EMPTY_SET_IS_KNOWN").toMatchObject({ state: "known", paths: [], count: 0, turnId: "clean", hash: configurationSet([]).hash });

    writeFileSync(join(f.brain, "brain.config.ts"), OPAQUE_CONFIG);
    await f.begin("opaque"); writeFileSync(join(f.brain, "notes/route.md"), "Odysseus charts the route.\n"); await f.journal.finish("opaque");
    const opaque = await current() as { state: string; hash: string; paths: string[]; count: number; turnId: string; observedAt: number };
    expect(opaque).toMatchObject({ state: "known", turnId: "opaque" });
    expect(opaque.paths).toContain("brain.config.ts");
    expect(opaque.count).toBe(opaque.paths.length);
    expect(opaque.hash).toBe(f.journal.summary("opaque").configurationCoverageSet!);
    expect(opaque.observedAt).toBe(f.journal.summary("opaque").observedAt!);

    // Later partial and expired turns with another set never replace it, and
    // neither does a complete turn that took no inventory.
    await f.begin("chat"); await f.journal.finish("chat");
    expect(await current(), "IDLE_TURN_NEVER_REPLACES").toEqual(opaque);
    rmSync(join(f.brain, "brain.config.ts"));
    for (const [id, state] of [["broken", "partial"], ["faded", "expired"]] as const) {
      await f.begin(id); writeFileSync(join(f.brain, `notes/${id}.md`), `${id}\n`); await f.journal.finish(id);
      await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET state=?,ended_at=ended_at+60000 WHERE turn_id=?", state, id)]);
    }
    expect(await current(), "PARTIAL_OR_EXPIRED_NEVER_REPLACES").toEqual(opaque);
  } finally { await f.close(); }
});

test("runtime main-model binding only updates the correlated active journal", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus");
    await f.journal.begin("athena", { sessionId: "troy", actor: "voice", model: null, profile: "governed", policyHash: null }, error => { throw error; });
    expect(f.journal.bindModel("odysseus", "troy", "main-model"), "MODEL_WRONG_SESSION_REJECTED").toBe(false);
    expect(f.journal.bindModel("odysseus", "ithaca", "main-model"), "MODEL_ACTIVE_BINDING").toBe(true);
    await f.journal.idle(); expect(f.journal.summary("odysseus").model, "MODEL_ACTIVE_SUMMARY").toBe("main-model");
    expect(f.journal.summary("athena").model, "MODEL_CONCURRENT_ISOLATION").toBeNull();
    expect(f.journal.bindModel("athena", "ithaca", "wrong-model"), "MODEL_TWO_SESSIONS_CROSS_BIND_REJECTED").toBe(false);
    expect(f.journal.bindModel("athena", "troy", "voice-model")).toBe(true);
    await f.journal.idle(); expect(f.journal.summary("athena").model).toBe("voice-model");
    await f.journal.finish("odysseus");
    expect(f.journal.bindModel("odysseus", "ithaca", "late-model"), "MODEL_FINISHED_REJECTED").toBe(false);
    expect(f.journal.summary("odysseus").model).toBe("main-model");
  } finally { await f.close(); }
});

test("native capture journals consumed nested configuration and ordinary excluded project edits", async () => {
  const f = fixture();
  try {
    const inputs = {
      "bunfig.toml": 'preload = ["./config/navigator/start.ts"]\n',
      "package.json": '{"name":"ithaca"}\n',
      "config/navigator/start.ts": 'export const route = "Ithaca";\n',
      "config/navigator/package.json": '{"type":"module","scripts":{"unused":"bun ./unused.ts"}}\n',
      "config/navigator/unused.ts": 'throw new Error("unused");\n',
      "node_modules/a/package.json": '{"name":"incidental"}\n',
      "workspaces/odyssey-tools/package.json": '{"scripts":{"start":"bun ./start.ts"}}\n',
      "workspaces/odyssey-tools/start.ts": 'throw new Error("unused clone");\n',
    };
    writeFileSync(join(f.brain, ".gitignore"), "node_modules/\n");
    for (const [path, text] of Object.entries(inputs)) { mkdirSync(join(f.brain, path, ".."), {recursive:true}); writeFileSync(join(f.brain, path), text); }
    await f.begin("consumer-seeds");
    for (const [path, text] of Object.entries(inputs)) writeFileSync(join(f.brain, path), text + "\n");
    await f.journal.finish("consumer-seeds");
    const details = f.journal.details("ithaca", "consumer-seeds")!;
    for (const path of ["bunfig.toml", "package.json", "config/navigator/start.ts", "config/navigator/package.json"]) expect(details.changes.find(change => change.path === path)?.class, `NATIVE_CONSUMED_CONFIGURATION_${path}`).toBe("steering");
    for (const path of ["config/navigator/unused.ts", "workspaces/odyssey-tools/package.json", "workspaces/odyssey-tools/start.ts"]) expect(details.changes.find(change => change.path === path)?.class, `NATIVE_UNUSED_CONFIGURATION_${path}`).toBe("content");
    expect(details.missing.filter(item => item.path.startsWith("node_modules/") || item.path.startsWith("workspaces/")), "NATIVE_INCIDENTAL_CONFIG_NOT_COVERAGE_NOISE").toEqual([]);
    expect(details.changes.find(change => change.path === "node_modules/a/package.json")?.after?.ignored).toBe(true);
  } finally { await f.close(); }
});
test("native journal excludes the resolved index and sidecars while preserving input-role events", async () => {
  const index = ".brain-index/brain.db", f = fixture();
  try {
    // A copied checkpoint is not native inode lineage. Keep a probe link to an
    // initial input inode and simulate allocator reuse only if releasing its
    // checkpoint leaves this probe as the sole owner. Fixture reservations must
    // prevent that reuse without suppressing the genuine later input edit.
    const { linkSync, unlinkSync } = await import("node:fs");
    const checkpoint = f.native.manager.checkpoint.bind(f.native.manager);
    const release = f.native.manager.release.bind(f.native.manager);
    const pin = join(f.root, "released-copied-input-inode");
    let pinnedId = "", released = false, reused = false;
    f.native.manager.release = async (id, signal) => {
      await release(id, signal);
      if (id === pinnedId) released = true;
    };
    f.native.manager.checkpoint = async (id, signal) => {
      const result = await checkpoint(id, signal);
      const nested = join(result.path, "resources/brain.db");
      const indexCopy = join(result.path, ".brain-index", "brain.db");
      if (!pinnedId && existsSync(nested)) { linkSync(nested, pin); pinnedId = id; }
      if (released && !reused && statSync(pin).nlink === 1 && existsSync(indexCopy) && readFileSync(indexCopy, "utf8") === "index changed") {
        unlinkSync(indexCopy); linkSync(pin, indexCopy); writeFileSync(indexCopy, "index changed"); reused = true;
      }
      return result;
    };

    mkdirSync(join(f.brain, "cache"), { recursive: true }); mkdirSync(join(f.brain,"resources")); mkdirSync(join(f.brain,".claude")); mkdirSync(join(f.brain,".brain-index"));
    const ignored = [index, ...["-wal","-shm","-journal"].map(suffix=>`${index}${suffix}`)];
    writeFileSync(join(f.brain,".gitignore"), ignored.join("\n"));
    writeFileSync(join(f.brain,"brain.config.ts"), `export default { db: "${index}", output: "./ordinary" };`);
    writeFileSync(join(f.brain,"bunfig.toml"), `preload = ["./startup.ts", ${ignored.map(path=>JSON.stringify(`./${path}`)).join(", ")}]`);
    writeFileSync(join(f.brain,"startup.ts"), 'import "./instructions" with {type:"text"}; import "./resources/brain.db" with {type:"text"};');
    writeFileSync(join(f.brain,".claude/settings.json"), JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"bun ./hook.ts ./ordinary"}]}]}}));
    const genuine = ["startup.ts","instructions","resources/brain.db","hook.ts",".claude/settings.json"];
    for (const path of [...ignored,"instructions","resources/brain.db","hook.ts","ordinary"]) writeFileSync(join(f.brain,path), "initial");
    await f.begin("index-only");
    for (const path of ignored) writeFileSync(join(f.brain,path), "index changed");
    await f.journal.finish("index-only");
    const details = f.journal.details("ithaca","index-only")!;
    expect(readFileSync(join(f.brain, "resources/brain.db"), "utf8"), "UNCHANGED_IMPORTED_INPUT_BYTES").toBe("initial");
    expect(details.changes.map(change=>change.path).sort(), "COPIED_INODE_CANNOT_ALIAS_UNCHANGED_INPUT").toEqual(ignored.sort());
    expect(released, "CONTROL_OBSERVED_CHECKPOINT_RELEASE").toBe(true);
    expect(reused, "COPIED_INPUT_INODE_REMAINS_RESERVED").toBe(false);
    expect(details.changes.every(change=>change.class === "content"), "NATIVE_INDEX_HAS_NO_STEERING_CLASS").toBe(true);
    expect(queryGovernanceEvents(f.db,{turnId:"index-only",kinds:["steering_change"],limit:100}), "NATIVE_INDEX_HAS_NO_STEERING_EVENTS").toEqual([]);
    expect(details.summary.steeringFiles).toBe(0);
    await f.begin("inputs");
    writeFileSync(join(f.brain,"startup.ts"), 'import "./instructions" with {type:"text"}; import "./resources/brain.db" with {type:"text"}; // edited');
    writeFileSync(join(f.brain,"hook.ts"), 'export {}; // edited');
    writeFileSync(join(f.brain,"instructions"), "Athena guides the return.");
    writeFileSync(join(f.brain,"resources/brain.db"), "A genuine text input, despite its basename.");
    writeFileSync(join(f.brain,"ordinary"), "data changed");
    writeFileSync(join(f.brain,".claude/settings.json"), JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"bun ./hook.ts ./ordinary"}]}]},model:"voyage"}));
    await f.journal.finish("inputs");
    const controls = f.journal.details("ithaca","inputs")!;
    expect(controls.changes.filter(change=>change.class === "steering").map(change=>change.path).sort(), "NATIVE_GENUINE_INPUT_ROLE_CONTROLS").toEqual(genuine.sort());
    expect(controls.changes.find(change=>change.path === "ordinary")?.class, "NATIVE_ORDINARY_ARGUMENT_IS_DATA").toBe("content");
    expect(queryGovernanceEvents(f.db,{turnId:"inputs",kinds:["steering_change"],limit:100}).map(event=>event.payload.path).sort()).toEqual(genuine.sort());
  } finally { await f.close(); }
});


test("native capture excludes an alternate trusted index identity without a public configuration option", async () => {
  const f = fixture();
  const capture = createNativeJournalCapture(f.native.manager, async () => { throw Error("ignored versions must not be retained"); }, {resolvedIndexPaths:["cache/voyage.sqlite"]});
  try {
    mkdirSync(join(f.brain,"cache")); mkdirSync(join(f.brain,"resources"));
    const indexes = ["", "-wal", "-shm", "-journal"].map(suffix=>`cache/voyage.sqlite${suffix}`);
    writeFileSync(join(f.brain,".gitignore"),indexes.join("\n"));
    writeFileSync(join(f.brain,"bunfig.toml"),`preload = [${[...indexes,"resources/brain.db"].map(path=>JSON.stringify(`./${path}`)).join(",")}]`);
    for (const path of [...indexes,"resources/brain.db"]) writeFileSync(join(f.brain,path),"initial");
    await capture.initialize(); const policy = await capture.policy();
    for (const path of indexes) writeFileSync(join(f.brain,path),"changed");
    const observed = await capture.observe(new Map([["alternate",policy]]));
    try {
      expect(observed.changes.get("alternate")!.map(change=>change.path).sort()).toEqual(indexes.sort());
      for (const path of indexes) expect(observed.steering.paths.has(path),"NATIVE_ALTERNATE_INDEX_IDENTITY_EXCLUDED").toBe(false);
      expect(observed.steering.paths.has("resources/brain.db"),"NATIVE_UNRELATED_BASENAME_REMAINS_INPUT").toBe(true);
      await observed.commit();
    } catch (error) { await observed.abort(); throw error; }
  } finally { await capture.close(); await f.close(); }
});

test("journal startup quarantines one corrupt object and preserves unrelated history", async () => {
  const f = fixture();
  let reopened: ReturnType<typeof createTurnJournal> | undefined;
  try {
    await f.begin("odysseus-corrupt");
    writeFileSync(join(f.brain, "notes/odysseus.md"), "# New voyage\n");
    await f.journal.finish("odysseus-corrupt");
    await f.begin("athena-healthy");
    writeFileSync(join(f.brain, "notes/athena.md"), "# Guidance\n");
    await f.journal.finish("athena-healthy");
    const before = f.journal.details("ithaca", "odysseus-corrupt")!.changes.find(change => change.path === "notes/odysseus.md")!.before!;
    await f.journal.close();
    // Reproduce an interrupted publisher on an existing retained object.
    const {createJournalAccounting} = await import("../src/brain/journal-accounting.js");
    const accounting = createJournalAccounting(f.db, join(f.root, "ui.db"));
    accounting.write(() => f.db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash) VALUES (?,?,?,'gone',0,?)")
      .run(crypto.randomUUID(), before.bytes, process.pid, before.hash!));
    accounting.write(() => f.db.query("UPDATE turn_journal_turns SET ended_at=NULL,state='recording',pid=?,pid_start='gone' WHERE turn_id='odysseus-corrupt'").run(process.pid));
    writeFileSync(join(f.root, "objects", before.hash!), Buffer.alloc(before.bytes));
    reopened = createTurnJournal(f.db, {nativeManager:f.native.manager,brainPath:f.brain,dbPath:join(f.root,"ui.db"),objectsRoot:join(f.root,"objects")});
    await reopened.ready;
    expect(reopened.summary("odysseus-corrupt").state, "JOURNAL_READY_AFTER_CORRUPT_PUBLICATION").toBe("partial");
    expect(reopened.details("ithaca", "odysseus-corrupt")!.missing).toContainEqual({path:"notes/odysseus.md",reason:"retained_object_corrupt"});
    expect(reopened.hasRetainedVersion("odysseus-corrupt", before)).toBe(false);
    const other = reopened.details("ithaca", "athena-healthy")!;
    expect(other.summary.state, "JOURNAL_OTHER_HISTORY_STAYS_COMPLETE").toBe("complete");
    expect(reopened.hasRetainedVersion("athena-healthy", other.changes.find(change => change.path === "notes/athena.md")!.after!)).toBe(true);
    const stopped: Error[] = [];
    for (const id of ["telemachus-active", "penelope-active"]) await reopened.begin(id,
      {sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",policyHash:null}, error => stopped.push(error));
    writeFileSync(join(f.brain, "notes/odysseus.md"), "# Ithaca\r\n");
    writeFileSync(join(f.brain, "notes/athena.md"), "# More guidance\n");
    const observed = await reopened.finish("telemachus-active").then(() => null, error => error);
    expect(stopped, "JOURNAL_RECAPTURE_DOES_NOT_STOP_OTHER_ACTIVE_TURNS").toEqual([]);
    expect(observed, "JOURNAL_QUARANTINE_RECAPTURE_COMPLETES_OBSERVATION").toBeNull();
    await reopened.finish("penelope-active");
    expect(reopened.details("ithaca", "penelope-active")!.missing.find(item => item.path === "notes/odysseus.md")).toMatchObject({reason:"retained_object_corrupt"});
    const healthy = reopened.details("ithaca", "penelope-active")!.changes.find(change => change.path === "notes/athena.md")!;
    expect(reopened.version("ithaca", "penelope-active", healthy.sequence, "after")!.bytes(100)).toEqual(Buffer.from("# More guidance\n"));
    expect(reopened.hasRetainedVersion("odysseus-corrupt", before), "JOURNAL_OLD_GAP_NEVER_CLEARS").toBe(false);
  } finally { await reopened?.close(); await f.close(); }
});


test("a quarantine gap added by recovery preserves an open turn until normal completion", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus-live");
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET missing=? WHERE turn_id='odysseus-live'",JSON.stringify([{path:"notes/odysseus.md",reason:"retained_object_corrupt"}]))]);
    expect(f.journal.summary("odysseus-live").state).toBe("recording");
    await f.journal.finish("odysseus-live");
    expect(f.journal.summary("odysseus-live").state,"JOURNAL_FINISH_PRESERVES_RECOVERY_GAP").toBe("partial");
    expect(f.journal.details("ithaca","odysseus-live")!.missing).toContainEqual({path:"notes/odysseus.md",reason:"retained_object_corrupt"});
  } finally { await f.close(); }
});

test("idle checkpoint cleanup records its cause durably before any turn exists and exposes authenticated status", async () => {
  const f = fixture();
  const release = f.native.manager.release;
  try {
    f.native.manager.release = async () => { throw new Error("Odysseus idle checkpoint release refused"); };
    await f.journal.observe();
    await f.journal.releasesSettled(); await f.journal.idle();
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_turns").get()).toEqual({ n: 0 });
    const saved = new Database(join(f.root, "ui.db"), { readonly: true });
    try {
      const failure = saved.query("SELECT value FROM settings WHERE key='journal.cleanup.lastFailure'").get();
      expect(failure, "IDLE_CLEANUP_CAUSE_DURABLE").not.toBeNull();
      expect(failure).toMatchObject({ value: expect.stringContaining("Odysseus idle checkpoint release refused") });
    } finally { saved.close(); }
    const routes = createStatusRoutes({ sourceCommit: "fixture", getCronStatus: () => [], isTurnActive: () => false,
      getJournalCleanup: () => f.journal.cleanupStatus() });
    const status = await (await routes.request("/status")).json() as any;
    expect(status.journalCleanup).toMatchObject({ retained: { failed: 1 }, lastFailure: { cause: "Error: Odysseus idle checkpoint release refused" } });
  } finally { f.native.manager.release = release; await f.close(); }
});
