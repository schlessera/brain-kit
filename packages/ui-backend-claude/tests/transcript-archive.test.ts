import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { archiveIdleSessions, listArchivedSessions, restoreArchivedSession, transcriptPaths, type ArchiveOptions } from "../src/transcript-archive.js";
import { createHistory } from "../src/history.js";
import { prepareClaudeWorkerState } from "../src/worker-spawn.js";
import { createStateLedger } from "../src/worker-state-budget.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DAY = 86400000;
let root: string, brain: string, live: string, archive: string, now: number, options: ArchiveOptions;
let metadata: SDKSessionInfo[], calls: number, errors: unknown[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-archive-")); brain = join(root, "brain"); mkdirSync(brain);
  now = Date.parse("2026-07-12T12:00:00Z"); metadata = []; calls = 0; errors = [];
  options = { brainPath: brain, env: { CLAUDE_CONFIG_DIR: join(root, "config") }, now: () => now,
    listSessionsFn: async () => { calls++; return metadata; }, log: (_message, error) => errors.push(error) };
  ({ live, archive } = transcriptPaths(brain, options.env)); mkdirSync(live, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function session(id = ID, age = 31) {
  const time = now - age * DAY;
  metadata.push({ sessionId: id, customTitle: "Return to Ithaca", summary: "Odysseus", firstPrompt: "Plan the voyage", createdAt: time - DAY, lastModified: time, fileSize: 1 });
  mkdirSync(join(live, id, "subagents"), { recursive: true });
  writeFileSync(join(live, `${id}.jsonl`), Buffer.from('Odysseus\n\u0000\u00ff'));
  writeFileSync(join(live, id, "subagents", "agent.jsonl"), "Athena\n");
  writeFileSync(join(live, id, "notes.bin"), new Uint8Array([0, 255, 17]));
  for (const name of [`${id}.jsonl`, `${id}/subagents/agent.jsonl`, `${id}/notes.bin`, `${id}/subagents`, id])
    utimesSync(join(live, name), new Date(time), new Date(time));
}
function savedIndex() { return JSON.parse(readFileSync(join(archive, "index.json"), "utf8")); }
test("idle sessions move to gzip with SDK metadata and round-trip byte-identically", async () => {
  session(); const before = readFileSync(join(live, `${ID}.jsonl`));
  await archiveIdleSessions(options);
  expect(errors).toEqual([]); expect(existsSync(join(live, `${ID}.jsonl`))).toBe(false);
  expect(existsSync(join(live, ID))).toBe(false);
  expect(Bun.gunzipSync(readFileSync(join(archive, ID, `${ID}.jsonl.gz`)))).toEqual(new Uint8Array(before));
  expect(savedIndex()).toEqual([{ id: ID, title: "Return to Ithaca", createdAt: now - 32 * DAY, lastActiveAt: now - 31 * DAY }]);
  restoreArchivedSession(ID, options);
  expect(readFileSync(join(live, `${ID}.jsonl`))).toEqual(before);
  expect(readFileSync(join(live, ID, "notes.bin"))).toEqual(Buffer.from([0, 255, 17]));
  expect(readFileSync(join(live, ID, "subagents/agent.jsonl"), "utf8")).toBe("Athena\n");
  expect(statSync(join(live, `${ID}.jsonl`)).mtimeMs).toBe(now);
  expect(savedIndex()).toEqual([]); expect(existsSync(join(archive, ID))).toBe(false);
  now += DAY; await archiveIdleSessions(options);
  expect(existsSync(join(live, `${ID}.jsonl`))).toBe(true);
});
test("newest nested mtime protects a session; exactly 30 days is not idle enough", async () => {
  session(); session(OTHER, 30);
  utimesSync(join(live, ID, "subagents/agent.jsonl"), new Date(now), new Date(now));
  await archiveIdleSessions(options);
  expect(listArchivedSessions(options)).toEqual([]);
  expect(existsSync(join(live, `${ID}.jsonl`))).toBe(true);
  expect(existsSync(join(live, `${OTHER}.jsonl`))).toBe(true);
});
test("running sessions are checked after asynchronous SDK metadata arrives", async () => {
  session(); const active = new Set<string>();
  options.activeSessionIds = () => active;
  options.listSessionsFn = async () => { active.add(ID); return metadata; };
  await archiveIdleSessions(options);
  expect(listArchivedSessions(options)).toEqual([]);
  expect(existsSync(join(live, `${ID}.jsonl`))).toBe(true);
});
test("once-per-day marker survives a new caller and concurrent sweeps", async () => {
  session(); await Promise.all([archiveIdleSessions(options), archiveIdleSessions({ ...options })]);
  expect(calls).toBe(1);
  now += DAY - 1; await archiveIdleSessions({ ...options }); expect(calls).toBe(1);
  now++; await archiveIdleSessions({ ...options }); expect(calls).toBe(2);
});
for (const phase of ["archive", "index"] as const) test(`interruption after ${phase} recovers without losing the session`, async () => {
  session(); const bytes = readFileSync(join(live, `${ID}.jsonl`));
  await archiveIdleSessions({ ...options, checkpoint: at => { if (at === phase) throw new Error("interrupted"); } });
  expect(errors).toHaveLength(1);
  expect(listArchivedSessions(options).map(s => s.id)).toEqual([ID]);
  expect(readFileSync(join(live, `${ID}.jsonl`))).toEqual(bytes);
  // Also model a crash during source deletion: only a subset remains.
  rmSync(join(live, ID, "notes.bin"));
  now += DAY; await archiveIdleSessions(options);
  expect(existsSync(join(live, `${ID}.jsonl`))).toBe(false);
  restoreArchivedSession(ID, options);
  expect(readFileSync(join(live, `${ID}.jsonl`))).toEqual(bytes);
  expect(readFileSync(join(live, ID, "notes.bin"))).toEqual(Buffer.from([0, 255, 17]));
});
test("interrupted restore is completed on the next sweep, never deleted as an old source", async () => {
  session(); await archiveIdleSessions(options);
  expect(() => restoreArchivedSession(ID, { ...options, checkpoint: () => { throw new Error("interrupted restore"); } })).toThrow("interrupted restore");
  expect(existsSync(join(archive, ID, "restoring"))).toBe(true);
  now += DAY; await archiveIdleSessions(options);
  expect(errors).toEqual([]); expect(savedIndex()).toEqual([]);
  expect(readFileSync(join(live, ID, "subagents/agent.jsonl"), "utf8")).toBe("Athena\n");
});
test("recovery never deletes changed source bytes or a running session", async () => {
  session(); await archiveIdleSessions({ ...options, checkpoint: () => { throw new Error("interrupted"); } });
  const original = readFileSync(join(archive, ID, `${ID}.jsonl.gz`));
  options.activeSessionIds = () => new Set([ID]); now += DAY;
  await archiveIdleSessions(options); expect(existsSync(join(live, `${ID}.jsonl`))).toBe(true);
  writeFileSync(join(live, `${ID}.jsonl`), "new live version");
  // The changed live copy wins; the archived copy is set aside, never deleted,
  // and archival keeps running for every other session.
  session(OTHER); options.activeSessionIds = () => new Set(); now += DAY; await archiveIdleSessions(options);
  expect(readFileSync(join(live, `${ID}.jsonl`), "utf8")).toBe("new live version");
  const aside = readdirSync(archive).find(name => name.startsWith(`.conflict-${ID}-`))!;
  expect(readFileSync(join(archive, aside, `${ID}.jsonl.gz`))).toEqual(original);
  expect(existsSync(join(archive, ID))).toBe(false);
  expect(existsSync(join(archive, OTHER))).toBe(true);
  expect(listArchivedSessions(options).map(s => s.id)).toEqual([OTHER]);
});
test("a resume or history read of a conflicting session keeps the live copy and never blocks", async () => {
  session(); await archiveIdleSessions(options);
  const original = readFileSync(join(archive, ID, `${ID}.jsonl.gz`));
  mkdirSync(live, { recursive: true }); writeFileSync(join(live, `${ID}.jsonl`), "written after archiving");
  expect(() => restoreArchivedSession(ID, options)).not.toThrow();
  expect(readFileSync(join(live, `${ID}.jsonl`), "utf8")).toBe("written after archiving");
  const aside = readdirSync(archive).find(name => name.startsWith(`.conflict-${ID}-`))!;
  expect(readFileSync(join(archive, aside, `${ID}.jsonl.gz`))).toEqual(original);
  expect(listArchivedSessions(options)).toEqual([]);
});
test("one unreadable archive entry neither hides the conversation list nor the other archived sessions", async () => {
  session(); session(OTHER); await archiveIdleSessions(options);
  writeFileSync(join(archive, OTHER, "manifest.json"), "{ not json");
  expect(listArchivedSessions(options).map(s => s.id).sort()).toEqual([ID, OTHER].sort());
  writeFileSync(join(archive, "index.json"), "{ not json");
  const history = createHistory({ brainPath: brain, env: options.env, listSessionsFn: async () => [] });
  expect(await history.listSessions()).toEqual([]);
});
test("archive refuses aliases without deleting sources and logs failure", async () => {
  session(); rmSync(join(live, ID, "notes.bin")); symlinkSync(join(live, `${ID}.jsonl`), join(live, ID, "notes.bin"));
  await archiveIdleSessions(options);
  expect(errors).toHaveLength(1); expect(existsSync(join(live, `${ID}.jsonl`))).toBe(true);
  expect(readdirSync(archive)).toEqual(["last-scan"]);
});
test("archived sessions stay listed through SDK failure, deduplicate, and restore before history reads", async () => {
  session(); await archiveIdleSessions(options);
  const history = createHistory({ brainPath: brain, env: options.env,
    listSessionsFn: async () => { throw new Error("no live sessions"); },
    getSessionMessagesFn: async id => {
      expect(readFileSync(join(live, id, "subagents/agent.jsonl"), "utf8")).toBe("Athena\n");
      return [{ type: "user", uuid: ID, session_id: id, parent_tool_use_id: null, parent_agent_id: null, message: { content: "Return to Ithaca" } }];
    } });
  expect((await history.listSessions()).map(s => s.id)).toEqual([ID]);
  const duplicate = createHistory({ brainPath: brain, env: options.env, listSessionsFn: async () => metadata });
  expect(await duplicate.listSessions()).toHaveLength(1);
  expect(await history.getHistory(ID)).toEqual([{ role: "user", content: "Return to Ithaca", toolCalls: [] }]);
  expect(savedIndex()).toEqual([]);
});
test("a busy refusal leaves an archived session archived: admission comes before restoration (#1625)", async () => {
  session(); await archiveIdleSessions(options);
  const limits = { allowanceBytes: 64 * 1024 * 1024, budgetBytes: 64 * 1024 * 1024 };
  const ledger = createStateLedger(); const running = ledger.reserve(limits);
  const index = savedIndex();
  try {
    expect(() => prepareClaudeWorkerState(brain, options.env!, ["--resume", ID], { limits, ledger })).toThrow("Retry when a running conversation finishes");
    expect(existsSync(join(archive, ID)), "still archived").toBe(true);
    expect(existsSync(join(live, `${ID}.jsonl`)), "not restored").toBe(false);
    expect(savedIndex()).toEqual(index);
    expect(ledger.live).toBe(1);
  } finally { running.release(); }
});
test("worker resume restores archived bytes before copying its session", async () => {
  session(); const bytes = readFileSync(join(live, `${ID}.jsonl`)); await archiveIdleSessions(options);
  const snapshot = prepareClaudeWorkerState(brain, options.env!, ["--resume", ID],
    { limits: { allowanceBytes: 64 * 1024 * 1024, budgetBytes: 64 * 1024 * 1024 }, ledger: createStateLedger() });
  const tmpfs = mkdtempSync(join(root, "tmpfs-"));
  try {
    snapshot.populate(tmpfs);
    const project = brain.replace(/[^a-zA-Z0-9]/g, "-");
    expect(readFileSync(join(tmpfs, "projects", project, `${ID}.jsonl`))).toEqual(bytes);
    expect(savedIndex()).toEqual([]); expect(existsSync(join(archive, ID))).toBe(false);
  } finally { snapshot.release(); }
});
