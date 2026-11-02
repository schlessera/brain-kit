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
  native.manager.checkpoint = async (id, signal) => { const made = await checkpoint(id, signal); checkpoints.push({ id: made.id, phase }); return made; };
  native.manager.delta = async (from, to, signal) => { deltas.push(from); return delta(from, to, signal); };
  const db = createUiDb(path);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"),
    now: () => clock, ...(idleObservationMs !== undefined ? { idleObservationMs } : {}) });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  return { brain, db, journal, checkpoints, deltas, begin, setPhase(next: string) { phase = next; }, advance(ms: number) { clock += ms; },
    async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the observer is initialized once startup recovery commits, before any admission", async () => {
  const f = fixture(3_600_000);
  try {
    await f.journal.ready; await f.journal.maintain();
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
