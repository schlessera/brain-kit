// #2898: the idle-session move waits on fsync off the event loop; restore stays
// synchronous. Archive and restore are proved separately, and every window the
// move now yields in is exercised against a restore, a turn start and a sweep.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { archiveIdleSessions, listArchivedSessions, restoreArchivedSession, transcriptPaths, type ArchiveOptions } from "../src/transcript-archive.js";

const ID = "11111111-1111-4111-8111-111111111111";
const DAY = 86400000;
let root: string, brain: string, live: string, archive: string, now: number, options: ArchiveOptions;
let metadata: SDKSessionInfo[], errors: unknown[], active: Set<string>;
let syncs: number, onSync: ((count: number) => void) | undefined, restoreSync: () => void;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "claude-archive-loop-")); brain = join(root, "brain"); mkdirSync(brain);
  now = Date.parse("2026-07-12T12:00:00Z"); metadata = []; errors = []; active = new Set();
  options = { brainPath: brain, env: { CLAUDE_CONFIG_DIR: join(root, "config") }, now: () => now,
    listSessionsFn: async () => metadata, log: (_message, error) => errors.push(error), activeSessionIds: () => active };
  ({ live, archive } = transcriptPaths(brain, options.env)); mkdirSync(live, { recursive: true });
  // Every asynchronous fsync is delayed, as on a host under write load; a
  // hook can act as another caller at a chosen sync. Kept real time: the delay
  // is the stimulus. Each awaited sync then takes wall time on any host (a
  // tmpfs fsync returns at once), so the liveness case's 1 ms interval has a
  // chance to run; a fake clock does not slow native IO.
  const probe = await open(tmpdir(), "r"), handle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const sync = handle.sync; syncs = 0; onSync = undefined;
  const delayed = spyOn(handle, "sync").mockImplementation(async function (this: unknown) {
    syncs++; onSync?.(syncs); await Bun.sleep(5); return sync.call(this);
  });
  restoreSync = () => delayed.mockRestore();
});
afterEach(() => { restoreSync(); rmSync(root, { recursive: true, force: true }); });
function session(id = ID, age = 31) {
  const time = now - age * DAY;
  metadata.push({ sessionId: id, customTitle: "Return to Ithaca", summary: "Odysseus", firstPrompt: "Plan the voyage", createdAt: time - DAY, lastModified: time, fileSize: 1 });
  mkdirSync(join(live, id, "subagents"), { recursive: true });
  writeFileSync(join(live, `${id}.jsonl`), Buffer.from('Odysseus\n\u0000ÿ'));
  writeFileSync(join(live, id, "subagents", "agent.jsonl"), "Athena\n");
  writeFileSync(join(live, id, "notes.bin"), new Uint8Array([0, 255, 17]));
  for (const name of [`${id}.jsonl`, `${id}/subagents/agent.jsonl`, `${id}/notes.bin`, `${id}/subagents`, id])
    utimesSync(join(live, name), new Date(time), new Date(time));
}
const savedIndex = () => JSON.parse(readFileSync(join(archive, "index.json"), "utf8"));
const liveBytes = () => [`${ID}.jsonl`, `${ID}/notes.bin`, `${ID}/subagents/agent.jsonl`].map(name => readFileSync(join(live, name)));
// Syncs before the first staged file: the two new archive directories' parents,
// the daily marker and its directory.
const MARKER_SYNCS = 4;

test("an idle session's move waits on fsync off the event loop, with every sync kept", async () => {
  session(); const bytes = liveBytes();
  const blocking = spyOn(fs, "fsyncSync");
  let ticks = 0, blocked = -1; const timer = setInterval(() => { ticks++; }, 1);
  try { await archiveIdleSessions(options); }
  finally { clearInterval(timer); blocked = blocking.mock.calls.length; blocking.mockRestore(); }
  expect(errors).toEqual([]);
  expect(blocked, "ARCHIVE_MOVE_NEVER_SYNC_FSYNC").toBe(0);
  expect(ticks, "ARCHIVE_MOVE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  // The same syncs the synchronous move made: the marker (4); three staged
  // files (file and directory each) with two new staged directories' parents
  // (8); the manifest (2); the staged tree's three directories (3); the
  // archive directory after the commit rename (1); the index (2); the three
  // removed files' directories (3) and the live directory after pruning (1).
  expect(syncs, "ARCHIVE_MOVE_STAYS_DURABLE").toBe(MARKER_SYNCS + 8 + 2 + 3 + 1 + 2 + 3 + 1);
  expect(existsSync(join(live, `${ID}.jsonl`))).toBe(false); expect(existsSync(join(live, ID))).toBe(false);
  expect(savedIndex().map((s: { id: string }) => s.id)).toEqual([ID]);
  restoreArchivedSession(ID, options);
  expect(liveBytes()).toEqual(bytes);
});

// Restore is the scoped residual: it stays synchronous so that no turn can
// start and no sweep can archive between its validation and publication.
test("restore stays synchronous: a sweep or turn start begun mid-restore sees it only once published", async () => {
  session(); const bytes = liveBytes(); await archiveIdleSessions(options);
  expect(existsSync(join(archive, ID))).toBe(true);
  now += DAY; const syncsBefore = syncs;
  const seen: string[] = []; let sweep: Promise<void> | undefined;
  const state = () => `${existsSync(join(archive, ID)) ? "archived" : "published"}:${existsSync(join(live, `${ID}.jsonl`)) ? "live" : "absent"}`;
  restoreArchivedSession(ID, { ...options, checkpoint: phase => {
    if (phase !== "restore") return;
    // Between validation and publication: a concurrent sweep and turn start.
    sweep = archiveIdleSessions({ ...options });
    queueMicrotask(() => { seen.push(`turn ${state()}`); active.add(ID); restoreArchivedSession(ID, options); });
    setTimeout(() => seen.push(`timer ${state()}`), 0);
  } });
  expect(seen, "RESTORE_EXCLUDES_UNTIL_PUBLISHED").toEqual([]);
  expect(syncs, "RESTORE_NEVER_AWAITS_A_SYNC").toBe(syncsBefore);
  await sweep; await Bun.sleep(1);
  expect(seen).toEqual(["turn published:live", "timer published:live"]);
  expect(errors).toEqual([]);
  expect(liveBytes()).toEqual(bytes);
  expect(existsSync(join(archive, ID))).toBe(false); expect(savedIndex()).toEqual([]);
});

test("a turn that starts while the move copies keeps its live transcript and no archived copy is committed", async () => {
  session(); const bytes = liveBytes();
  // The first staged file's sync: the copy has begun, nothing is committed.
  onSync = count => { if (count === MARKER_SYNCS + 1) { active.add(ID); restoreArchivedSession(ID, options); } };
  await archiveIdleSessions(options);
  expect(errors).toEqual([]);
  expect(liveBytes(), "TURN_DURING_COPY_KEEPS_LIVE").toEqual(bytes);
  expect(existsSync(join(archive, ID)), "TURN_DURING_COPY_COMMITS_NOTHING").toBe(false);
  expect(readdirSync(archive).filter(name => name.startsWith("."))).toEqual([]);
  expect(listArchivedSessions(options)).toEqual([]);
});

test("a turn admitted after the commit keeps its live transcript; its later write wins on the next sweep", async () => {
  session(); const bytes = liveBytes();
  // Admitted while the committed move writes its index; it has not restored yet.
  await archiveIdleSessions({ ...options, checkpoint: phase => {
    if (phase === "archive") queueMicrotask(() => active.add(ID));
  } });
  expect(errors).toEqual([]);
  expect(liveBytes(), "ADMITTED_TURN_KEEPS_LIVE").toEqual(bytes);
  restoreArchivedSession(ID, options);
  expect(liveBytes()).toEqual(bytes);
  writeFileSync(join(live, `${ID}.jsonl`), "written by the resumed turn");
  active.clear(); now += DAY;
  await archiveIdleSessions(options);
  expect(errors).toEqual([]);
  expect(readFileSync(join(live, `${ID}.jsonl`), "utf8")).toBe("written by the resumed turn");
});

test("a history read that restores while the move writes its index wins: no deletion, no stale index", async () => {
  session(); const bytes = liveBytes();
  await archiveIdleSessions({ ...options, checkpoint: phase => {
    if (phase === "archive") queueMicrotask(() => restoreArchivedSession(ID, options));
  } });
  expect(errors, "RESTORED_MOVE_SKIPS_REMOVAL").toEqual([]);
  expect(liveBytes()).toEqual(bytes);
  expect(existsSync(join(archive, ID))).toBe(false);
  expect(savedIndex(), "OVERTAKEN_INDEX_IS_REWRITTEN").toEqual([]);
  expect(listArchivedSessions(options)).toEqual([]);
});
