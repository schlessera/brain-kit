/** #3355: the journal prepares the next admission while no turn is active, without changing what it records. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const DAY = 24 * 60 * 60 * 1000;

function fixture(idleObservationMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "journal-idle-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes", "ithaca.md"), "# Ithaca\n");
  const native = createNativeJournalFixture(brain, root);
  // Which checkpoints exist, in order, and which root each delta starts from.
  const checkpoints: { id: string; phase: string }[] = [], deltas: string[] = [];
  let phase = "boot", clock = Date.parse("2026-07-12T08:00:00Z");
  const checkpoint = native.manager.checkpoint.bind(native.manager), delta = native.manager.delta.bind(native.manager);
  let block: ((signal?: AbortSignal) => Promise<never>) | undefined;
  native.manager.checkpoint = async (id, signal) => {
    if (block) await block(signal);
    const made = await checkpoint(id, signal); checkpoints.push({ id: made.id, phase }); return made;
  };
  native.manager.delta = async (from, to, signal) => { deltas.push(from); return delta(from, to, signal); };
  const db = createUiDb(path);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"),
    now: () => clock, ...(idleObservationMs !== undefined ? { idleObservationMs } : {}) });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  let closed = false;
  return { brain, db, journal, checkpoints, deltas, begin, setPhase(next: string) { phase = next; }, advance(ms: number) { clock += ms; },
    blockCheckpoints(next: typeof block) { block = next; },
    async close() { if (closed) return; closed = true; await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the observer is initialized once startup recovery commits, before any admission", async () => {
  const f = fixture(3_600_000);
  try {
    // No explicit maintain(): the pass under test is the one the journal starts once ready settles.
    await f.journal.ready; await f.journal.idle();
    expect(f.checkpoints.map(item => item.phase), "JOURNAL_INITIALIZED_BEFORE_FIRST_ADMISSION").toContain("boot");
  } finally { await f.close(); }
});

test("without idle observation nothing is checkpointed before an admission", async () => {
  const f = fixture();
  try {
    await f.journal.ready; await f.journal.idle();
    expect(f.checkpoints, "NO_IDLE_OBSERVATION_WITHOUT_THE_OPTION").toEqual([]);
  } finally { await f.close(); }
});

test("what changed while idle is observed before the next admission and attributed to no turn", async () => {
  const f = fixture(3_600_000);
  try {
    await f.journal.ready;
    await f.begin("turn-before"); await f.journal.finish("turn-before");
    f.setPhase("idle-writes");
    for (let i = 0; i < 20; i++) writeFileSync(join(f.brain, "notes", `suitor-${i}.md`), `Suitor ${i} waits in the hall.\n`);
    f.setPhase("maintained");
    await f.journal.maintain();
    f.setPhase("admission");
    await f.begin("turn-after");
    // The admission's own delta starts from a root taken after the idle writes.
    const from = f.checkpoints.find(item => item.id === f.deltas.at(-1));
    expect(from?.phase, "ADMISSION_DELTA_STARTS_AFTER_IDLE_CHANGES").toBe("maintained");
    await f.journal.finish("turn-after");
    expect(f.journal.summary("turn-after").changedFiles, "IDLE_CHANGES_ATTRIBUTED_TO_NO_TURN").toBe(0);
  } finally { await f.close(); }
});

test("turns past retention expire while idle, before the next admission", async () => {
  const f = fixture(3_600_000);
  try {
    await f.journal.ready;
    await f.begin("turn-old"); await f.journal.finish("turn-old");
    const rows = (id: string) => (f.db.query("SELECT count(*) AS n FROM turn_journal_turns WHERE turn_id=?").get(id) as { n: number }).n;
    f.advance(29 * DAY); await f.journal.maintain();
    expect(rows("turn-old"), "RETAINED_INSIDE_THE_RETENTION_PERIOD").toBe(1);
    f.advance(2 * DAY); await f.journal.maintain();
    expect(rows("turn-old"), "EXPIRED_WHILE_IDLE").toBe(0);
  } finally { await f.close(); }
});

test("an active turn suspends idle maintenance", async () => {
  const f = fixture(3_600_000);
  try {
    await f.journal.ready; await f.journal.maintain();
    await f.begin("turn-active");
    const before = f.checkpoints.length;
    await f.journal.maintain();
    expect(f.checkpoints.length, "NO_IDLE_OBSERVATION_DURING_A_TURN").toBe(before);
    await f.journal.finish("turn-active");
  } finally { await f.close(); }
});

test("closing abandons an idle pass instead of waiting for its native work", async () => {
  const f = fixture(3_600_000);
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  let unblock = () => {};
  try {
    await f.journal.ready; await f.journal.maintain();
    await f.begin("turn-ithaca"); await f.journal.finish("turn-ithaca");
    // The next idle pass blocks inside its checkpoint until it is aborted.
    f.blockCheckpoints(signal => { entered(); return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true }); unblock = () => reject(Error("released by cleanup"));
    }); });
    void f.journal.maintain();
    await blocked;
    // Failure maximum: a correct close settles first; the 5 s branch is only
    // reached if close waits for the blocked native work.
    const closed = await Promise.race([f.journal.close().then(() => "closed"), Bun.sleep(5_000).then(() => "waiting")]);
    expect(closed, "CLOSE_ABANDONS_THE_IDLE_PASS").toBe("closed");
  } finally { f.blockCheckpoints(undefined); unblock(); await f.close().catch(() => {}); }
});

test("only host maintenance scrubs, and a busy turn records its skip in maintenance Activity", async()=>{
 const f=fixture();
 try {
  await f.journal.ready;
  const events=()=>f.db.query("SELECT payload FROM activity_events WHERE event_type='journal_scrub'").all() as {payload:string}[];
  await f.begin("voyage");
  expect(events(),"ADMISSION_DOES_NOT_SCRUB").toEqual([]);
  await f.journal.maintain();
  expect(JSON.parse(events().at(-1)!.payload).v,"SCRUB_BUSY_ACTIVITY").toMatchObject({state:"skipped",reason:"journal_busy",listed:0});
  const beforeFinish=events().length;
  await f.journal.finish("voyage");
  expect(events(),"FINISH_DOES_NOT_SCRUB").toHaveLength(beforeFinish);
  await f.journal.maintain();
  expect(JSON.parse(events().at(-1)!.payload).v,"SCRUB_IDLE_ACTIVITY").toMatchObject({state:"complete",reason:null});
 }finally{await f.close();}
});

test("idle maintenance retries a transient startup recovery fsync and refreshes its status",async()=>{
 const fs=await import("node:fs"),{spyOn}=await import("bun:test");
 const {createJournalAccounting}=await import("../src/brain/journal-accounting.js");
 const root=mkdtempSync(join(tmpdir(),"odysseus-idle-recovery-")),brain=join(root,"brain"),objects=join(root,"objects");mkdirSync(brain);mkdirSync(objects,{mode:0o700});
 const native=createNativeJournalFixture(brain,root),db=createUiDb(":memory:"),accounting=createJournalAccounting(db,":memory:");
 const held=accounting.reserveTemporary(6);writeFileSync(join(objects,`pending-${held.id}`),"Ithaca");
 accounting.write(()=>db.query("UPDATE turn_journal_reservations SET pid_start='gone' WHERE id=?").run(held.id));
 const sync=spyOn(fs,"fsyncSync").mockImplementation(()=>{throw Error("Ithaca startup sync refused");});
 // An in-memory writer runs the actual production accounting procedures inline,
 // allowing the filesystem fault to hit both startup and idle recovery.
 const journal=createTurnJournal(db,{brainPath:brain,dbPath:":memory:",objectsRoot:objects,nativeManager:native.manager});
 try {
  await journal.ready;expect(journal.recoveryStatus(),"STARTUP_RECOVERY_FAILURE_RETAINED").toMatchObject({unresolvedRecords:1,firstCause:{message:"Ithaca startup sync refused"}});
  sync.mockRestore();await journal.maintain();
  expect(journal.recoveryStatus(),"IDLE_RECOVERY_REFRESHES_STATUS").toEqual({unresolvedRecords:0,firstCause:null});
  expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get(),"IDLE_RECOVERY_RELEASES_DURABLE_RESERVATION").toEqual({n:0});
 }finally{sync.mockRestore();await journal.close();await native.close();db.close();rmSync(root,{recursive:true,force:true});}
});
