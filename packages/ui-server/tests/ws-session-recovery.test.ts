/**
 * Session recovery (#964, D52 §6), through the real host, run loop, catalog,
 * Activity recorder and dispatch, with a scripted backend whose transcript
 * the test controls. No model, key or network.
 *
 * What it replaces: a client that reloaded with several turns open could not
 * tell a finished turn from a new one (a newer `lastActiveAt` accompanies
 * both), lost the identity of a queued follow-up, and lost a pending approval
 * whenever the replayed history ended on the user's message.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  SESSION_RECOVERY_CAPABILITY,
  type AskUserFormSpec,
  type AskUserListSpec,
  type AskUserQuestion,
  type AskUserRankSpec,
  type ClientMessage,
  type ServerMessage,
  type SessionHistoryMessage,
  type SessionRecovery,
} from "@schlessera/brain-ui-sdk/protocol";
import { sessionRecoverySchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BackendBridge, PermissionDecision, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import type { Principal } from "../src/db/principals";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { handleClientMessage as dispatch } from "../src/ws/dispatch";
import { WsHost } from "../src/ws/host";
import { readSessionRecovery } from "../src/ws/recovery";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { removeDbFile } from "./helpers/test-host";
import { recoveryDeadline } from "./helpers/recovery-deadline";
import { testAuthorization, testPrincipal } from "./helpers/principal";

const QUESTIONS: AskUserQuestion[] = [{
  question: "Which harbour first?",
  header: "Harbour",
  multiSelect: false,
  options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor’s court" }],
}];
const LIST: AskUserListSpec = {
  prompt: "Which stores are aboard?",
  scale: [{ label: "Aboard" }, { label: "Missing" }],
  items: [{ id: "oars", label: "Spare oars" }, { id: "wine", label: "Wine from Maron" }],
  allowSkip: true,
  notes: true,
};
const RANK: AskUserRankSpec = { prompt: "Rank the landings", items: [{ id: "aeolia", label: "Aeolia" }, { id: "scheria", label: "Scheria" }] };
const FORM: AskUserFormSpec = {
  prompt: "Plan the crossing",
  nodes: [{ id: "course", kind: "single", prompt: "Which course?", options: [{ label: "Coast" }, { label: "Open sea" }] }],
};

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** One turn the test drives: it holds until `finish`, and can raise interactions. */
interface Turn {
  sessionId: string;
  prompt: string;
  bridge: BackendBridge;
  /** Append the assistant answer (unless `answer` is null) and end with `outcome`. */
  finish(options?: { answer?: string | null; outcome?: "success" | "error" }): void;
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

function world(options: { db?: Database; principalValid?: () => boolean; turnTimeoutMs?: number; historyRead?: () => Promise<void>; governedTurns?: import("../src/brain/governed-turn.js").GovernedTurns } = {}) {
  const db = options.db ?? createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "recovery-test" });
  const stream = createActivityStream(store);
  const transcripts = new Map<string, SessionHistoryMessage[]>();
  const turns: Turn[] = [];
  let created = 0;
  let failHistory = false;
  const backend = makeFakeBackend({
    id: "fixture",
    capabilities: { permissions: true, askUser: true },
    async getHistory(sessionId) {
      await options.historyRead?.();
      if (failHistory) throw new Error("Fixture transcript unavailable");
      return structuredClone(transcripts.get(sessionId) ?? []);
    },
    startTurn: (req: StartTurnRequest) => new Promise<void>((resolve) => {
      const sessionId = req.sessionId ?? `odyssey-${++created}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      // The backend keeps the prompt at once, so a reload mid-turn replays a
      // history that ends on the user's message.
      transcript.push({ role: "user", content: req.prompt, toolCalls: [] });
      let done = false;
      const end = () => { if (!done) { done = true; resolve(); } };
      req.signal.addEventListener("abort", end, { once: true });
      turns.push({
        sessionId,
        prompt: req.prompt,
        bridge: req.bridge,
        finish({ answer = `Answer to ${req.prompt}.`, outcome = "success" } = {}) {
          if (done) return;
          if (answer !== null) transcript.push({ role: "assistant", content: answer, toolCalls: [] });
          req.bridge.emit({ type: "result", sessionId, numTurns: 1, durationMs: 1, isError: outcome === "error", outcome });
          end();
        },
      });
    }),
  });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    activity: { store, stream },
    governedTurns: options.governedTurns,
    turnTimeoutMs: options.turnTimeoutMs,
    isPrincipalValid: options.principalValid ?? (() => true),
  });
  const principal: Principal = testPrincipal();
  const frames: ServerMessage[] = [];
  const ws: WSContext = { send: (data) => frames.push(JSON.parse(data)) };
  host.clients.add(ws, principal.id);
  const connection = { principal, authorization: testAuthorization() };
  cleanups.push(() => {
    for (const turn of turns) turn.finish({ answer: null });
    host.coordinator.reset();
    host.close();
    stream.close();
    if (!options.db) db.close();
  });
  const send = (msg: ClientMessage) => dispatch(host, ws, msg, connection);
  return {
    db, store, host, backend, transcripts, turns, frames, ws, principal,
    breakHistory(broken: boolean) { failHistory = broken; },
    send,
    async chat(text: string, extra: Partial<Extract<ClientMessage, { type: "chat_message" }>> = {}) {
      const before = turns.length;
      await send({ type: "chat_message", text, attachments: [], ...extra } as ClientMessage);
      return before;
    },
    /** Wait for the n-th turn (0-based) to have started. */
    async turn(index: number): Promise<Turn> {
      await until(() => turns.length > index);
      return turns[index]!;
    },
    async idle() {
      await until(() => !host.coordinator.isTurnActive() && host.coordinator.startingBySession.size === 0);
      // The turn boundary is written after the run loop has let go.
      await host.failureReplay.wait(turns.at(-1)?.sessionId ?? "");
    },
    async recover(sessionId: string): Promise<SessionRecovery> {
      const read = await readSessionRecovery(host, sessionId, principal);
      if (read.kind !== "ok") throw new Error(`recovery read: ${read.kind}`);
      // Every envelope the host builds must be one a client accepts.
      expect(sessionRecoverySchema.safeParse(read.recovery).success).toBe(true);
      return read.recovery;
    },
    async replay(sessionId: string): Promise<SessionHistoryMessage[]> {
      const from = frames.length;
      await send({ type: "session_resume", sessionId });
      const history = frames.slice(from).find((f) => f.type === "session_history");
      if (!history || history.type !== "session_history") throw new Error("no session_history");
      return history.messages;
    },
  };
}

describe("latest accepted work", () => {
  test("server_hello advertises sessionRecovery", async () => {
    const w = world();
    const handlers = createWsHandlers(w.host, w.principal);
    const sent: ServerMessage[] = [];
    await handlers.onOpen(undefined as never, { send: (d: string) => sent.push(JSON.parse(d)), close: () => {} });
    const hello = sent.find((f) => f.type === "server_hello");
    expect(hello?.type === "server_hello" && hello.capabilities?.[SESSION_RECOVERY_CAPABILITY]).toBe(true);
  });

  test("a finished first turn is terminal success, with Activity's own times and the turn on its answer", async () => {
    const w = world();
    await w.chat("Plot the course home", { requestId: "req-course" });
    const first = await w.turn(0);
    const running = await w.recover(first.sessionId);
    expect(running.revision).toBe(1);
    expect(running.latest).toMatchObject({ requestId: "req-course", state: "running", outcome: null, endedAt: null });
    expect(running.latest.turnId).toBeString();
    expect(running.latest.startedAt).toBeNumber();

    first.finish();
    await w.idle();
    const done = await w.recover(first.sessionId);
    const rollup = w.store.runRollup!(running.latest.turnId!)!;
    expect(done).toEqual({
      sessionId: first.sessionId,
      backendId: "fixture",
      revision: 1,
      latest: {
        requestId: "req-course",
        turnId: running.latest.turnId,
        state: "terminal",
        outcome: "success",
        startedAt: rollup.startedAt,
        endedAt: rollup.endedAt,
      },
      pending: [],
    });
    expect(rollup.endedAt).toBeNumber();

    const history = await w.replay(first.sessionId);
    expect(history.map((m) => [m.role, m.content])).toEqual([
      ["user", "Plot the course home"],
      ["assistant", "Answer to Plot the course home."],
    ]);
    expect(history.at(-1)?.turnId).toBe(running.latest.turnId!);
    expect(history[0]!.turnId).toBeUndefined();
  });

  test("a queued follow-up is the latest request while the earlier turn runs, and is never read as its success", async () => {
    const w = world();
    await w.chat("Count the crew");
    const first = await w.turn(0);
    first.finish();
    await w.idle();
    const sid = first.sessionId;
    const r1 = await w.recover(sid);
    expect(r1.latest.state).toBe("terminal");

    await w.chat("Ready the oars", { sessionId: sid, requestId: "req-oars" });
    const second = await w.turn(1);
    await w.chat("Mind the Sirens", { sessionId: sid, requestId: "req-sirens" });
    const queued = await w.recover(sid);
    expect(queued.revision).toBe(3);
    expect(queued.latest).toEqual({ requestId: "req-sirens", turnId: null, state: "queued", outcome: null, startedAt: null, endedAt: null });

    // The earlier turn raises an approval while the newer request waits.
    const decided = second.bridge.requestPermission({ toolUseId: "tool-mast", toolName: "Bash", input: { command: "tie --mast" }, kind: "tool" });
    await until(() => w.host.coordinator.pendingApprovals.size === 1);
    const pendingWhileQueued = await w.recover(sid);
    expect(pendingWhileQueued.latest.state).toBe("queued");
    const runningTurnId = w.host.coordinator.bySession.get(sid)!.turnId;
    expect(pendingWhileQueued.pending).toEqual([{ kind: "approval", requestId: "tool-mast", turnId: runningTurnId }]);

    await w.send({ type: "tool_approval", toolUseId: "tool-mast", turnId: runningTurnId });
    expect((await decided).behavior).toBe("allow");
    second.finish();
    // The queued request now runs as its own turn, with its own identity.
    const third = await w.turn(2);
    const dispatched = await w.recover(sid);
    expect(dispatched.revision).toBe(3);
    expect(dispatched.latest).toMatchObject({ requestId: "req-sirens", state: "running" });
    expect(dispatched.latest.turnId).not.toBe(runningTurnId);
    expect(dispatched.pending).toEqual([]);
    third.finish({ outcome: "error", answer: "The Sirens drowned out the oars." });
    await w.idle();
    const failed = await w.recover(sid);
    expect(failed.latest).toMatchObject({ requestId: "req-sirens", turnId: dispatched.latest.turnId, state: "terminal", outcome: "error" });
  });

  test("cancellation is Activity's cancelled, and pruned detail keeps the rollup's proof", async () => {
    const w = world();
    await w.chat("Sail past Scylla");
    const first = await w.turn(0);
    await w.send({ type: "cancel", sessionId: first.sessionId });
    await w.idle();
    const cancelled = await w.recover(first.sessionId);
    expect(cancelled.latest).toMatchObject({ state: "terminal", outcome: "cancelled" });
    expect(cancelled.latest.endedAt).toBeNumber();

    // Detail pruning removes spans, never the rollup.
    w.db.exec("DELETE FROM activity_spans");
    w.db.exec("UPDATE activity_run_rollups SET detail_pruned = 1");
    expect((await w.recover(first.sessionId)).latest).toEqual(cancelled.latest);

    // With no rollup either, the identity stays, and the state is unknown.
    w.db.exec("DELETE FROM activity_run_rollups");
    const unproven = (await w.recover(first.sessionId)).latest;
    expect(unproven).toMatchObject({ requestId: null, turnId: cancelled.latest.turnId, state: "unknown", outcome: null, endedAt: null });
    expect(unproven.startedAt).toBeNumber();
  });

  test("an Activity run of another session is not this request's proof", async () => {
    const w = world();
    await w.chat("Weigh anchor");
    const first = await w.turn(0);
    first.finish();
    await w.idle();
    const recovered = await w.recover(first.sessionId);
    w.db.prepare("UPDATE activity_run_rollups SET session_id = ? WHERE run_id = ?").run("odyssey-other", recovered.latest.turnId);
    expect((await w.recover(first.sessionId)).latest).toEqual({
      requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null,
    });
  });

  test("an acceptance that could not be recorded makes the session unknown, never its older success", async () => {
    const w = world();
    await w.chat("Count the crew");
    const first = await w.turn(0);
    first.finish();
    await w.idle();
    const sid = first.sessionId;
    expect((await w.recover(sid)).latest.state).toBe("terminal");

    w.db.exec("ALTER TABLE session_work RENAME TO session_work_offline");
    await w.chat("Ready the oars", { sessionId: sid });
    await w.turn(1);
    w.db.exec("ALTER TABLE session_work_offline RENAME TO session_work");
    const unordered = await w.recover(sid);
    expect(unordered.revision).toBe(1);
    expect(unordered.latest.state).toBe("unknown");
    expect(unordered.latest.turnId).toBeNull();
    // Still unknown once the unrecorded turn has finished: the persisted
    // latest is the older success, and must not stand in for it.
    w.turns[1]!.finish();
    await w.idle();
    expect((await w.recover(sid)).latest).toEqual({
      requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null,
    });

    // A later recorded acceptance restores ordering.
    await w.chat("Mind the Sirens", { sessionId: sid, requestId: "req-sirens" });
    const ordered = await w.recover(sid);
    expect(ordered.revision).toBe(2);
    expect(ordered.latest).toMatchObject({ requestId: "req-sirens", state: "queued" });
  });

  test("two sessions open at once keep their own latest work and pending interactions", async () => {
    const w = world();
    await w.chat("Ithaca bound");
    const a = await w.turn(0);
    await w.chat("Troy bound");
    const b = await w.turn(1);
    const asked = b.bridge.askUser!("ask-route", QUESTIONS);
    asked.catch(() => {});
    await until(() => w.host.coordinator.pendingAskUser.size === 1);
    a.finish();
    await until(() => w.host.coordinator.bySession.get(a.sessionId) === undefined);
    await w.host.failureReplay.wait(a.sessionId);
    const ra = await w.recover(a.sessionId);
    const rb = await w.recover(b.sessionId);
    expect(ra.latest.state).toBe("terminal");
    expect(ra.pending).toEqual([]);
    expect(rb.latest.state).toBe("running");
    expect(rb.pending).toEqual([{ kind: "ask_user", requestId: "ask-route", turnId: rb.latest.turnId! }]);
    expect(ra.latest.turnId).not.toBe(rb.latest.turnId);
  });

  test("all four ask kinds and an approval are listed with their original identities", async () => {
    const w = world();
    await w.chat("Plan the voyage");
    const t = await w.turn(0);
    const waits = [
      t.bridge.askUser!("ask-1", QUESTIONS),
      t.bridge.askUserList!("ask-2", LIST),
      t.bridge.askUserRank!("ask-3", RANK),
      t.bridge.askUserForm!("ask-4", FORM),
    ];
    for (const wait of waits) (wait as Promise<unknown>).catch(() => {});
    void t.bridge.requestPermission({ toolUseId: "tool-sail", toolName: "Bash", input: { command: "hoist" }, kind: "tool" });
    await until(() => w.host.coordinator.pendingApprovals.size === 1 && w.host.coordinator.pendingAskUserForm.size === 1);
    const recovered = await w.recover(t.sessionId);
    const turnId = recovered.latest.turnId!;
    expect(recovered.pending).toEqual([
      { kind: "approval", requestId: "tool-sail", turnId },
      { kind: "ask_user", requestId: "ask-1", turnId },
      { kind: "ask_user_list", requestId: "ask-2", turnId },
      { kind: "ask_user_rank", requestId: "ask-3", turnId },
      { kind: "ask_user_form", requestId: "ask-4", turnId },
    ]);
    // A read changes nothing: no reply, no turn, nothing settled.
    const sentBefore = w.frames.length;
    await w.recover(t.sessionId);
    expect(w.frames.length).toBe(sentBefore);
    expect(w.turns).toHaveLength(1);
    expect(w.host.coordinator.pendingApprovals.size).toBe(1);
  });
});

describe("restart", () => {
  test("a restart neither resurrects a running turn or its queue nor forgets a proven outcome", async () => {
    const path = `/tmp/brain-ui-recovery-${process.pid}.db`;
    removeDbFile(path);
    cleanups.push(() => removeDbFile(path));
    const db = createUiDb(path);
    cleanups.push(() => db.close());

    const before = world({ db });
    await before.chat("Count the crew");
    const first = await before.turn(0);
    first.finish();
    await before.idle();
    const sid = first.sessionId;
    const proven = await before.recover(sid);
    await before.chat("Ready the oars", { sessionId: sid, requestId: "req-oars" });
    await before.turn(1);
    await before.chat("Mind the Sirens", { sessionId: sid, requestId: "req-sirens" });
    expect((await before.recover(sid)).latest.state).toBe("queued");

    // A new process over the same database: the old one's queue and running
    // turn lived only in its memory.
    const reopened = createUiDb(path);
    cleanups.push(() => reopened.close());
    const after = world({ db: reopened });
    const lost = await after.recover(sid);
    expect(lost.revision).toBe(3);
    expect(lost.latest).toEqual({ requestId: "req-sirens", turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null });
    expect(lost.pending).toEqual([]);
    expect(after.turns).toHaveLength(0);
    expect(after.host.coordinator.running.size).toBe(0);
    // The finished first turn's proof is the Activity rollup, which outlives the process.
    expect(after.store.runRollup!(proven.latest.turnId!)?.outcome).toBe("success");
  });
});

describe("authorization and existence", () => {
  test("a revoked caller learns nothing, including after the read's asynchronous step", async () => {
    let valid = true;
    const w = world({ principalValid: () => valid });
    w.transcripts.set("odyssey-imported", [{ role: "user", content: "From the CLI", toolCalls: [] }]);
    valid = false;
    expect(await readSessionRecovery(w.host, "odyssey-imported", w.principal)).toEqual({ kind: "unauthorized" });
    valid = true;
    // Revoked while the backend history read is in flight.
    const read = readSessionRecovery(w.host, "odyssey-imported", w.principal);
    valid = false;
    expect(await read).toEqual({ kind: "unauthorized" });
  });

  test("imported history is a session with no fabricated identity; an unknown one is not found; a failed read throws", async () => {
    const w = world();
    w.transcripts.set("odyssey-imported", [
      { role: "user", content: "From the CLI", toolCalls: [] },
      { role: "assistant", content: "Answered outside the host.", toolCalls: [] },
    ]);
    const imported = await w.recover("odyssey-imported");
    expect(imported).toEqual({
      sessionId: "odyssey-imported", backendId: null, revision: 0,
      latest: { requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null },
      pending: [],
    });
    const importedHistory = await w.replay("odyssey-imported");
    expect(importedHistory.map((m) => [m.role, m.content])).toEqual([
      ["user", "From the CLI"],
      ["assistant", "Answered outside the host."],
    ]);
    expect(importedHistory.every((m) => m.turnId === undefined)).toBe(true);
    expect(await readSessionRecovery(w.host, "odyssey-nowhere", w.principal)).toEqual({ kind: "not_found" });
    w.breakHistory(true);
    await expect(readSessionRecovery(w.host, "odyssey-nowhere", w.principal)).rejects.toThrow("Fixture transcript unavailable");
  });
});

describe("a stalled backend", () => {
  const nativeTurn = () => new Promise<void>(resolve => setImmediate(resolve));
  async function completed(check: () => boolean, oracle: string) {
    const deadline = performance.now() + 1_000;
    while (!check() && performance.now() < deadline) await nativeTurn();
    expect(check(), oracle).toBe(true);
  }

  function fixture(extraBackend = false) {
    const reads: { backend: string; session: string; done: boolean; release: () => void }[] = [];
    const stalledBackend = (id: string) => makeFakeBackend({ id, getHistory: session => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const read = { backend: id, session, done: false, release };
      reads.push(read);
      return pending.then(() => { read.done = true; return []; });
    } });
    const stalled = stalledBackend("stalled");
    const holding = makeFakeBackend({ id: "holding", histories: { "odyssey-imported": [{ role: "user", content: "From the CLI", toolCalls: [] }] } });
    const registry = createStaticBackendRegistry([stalled, ...(extraBackend ? [stalledBackend("other")] : []), holding], "stalled");
    const hosts: { host: WsHost; db: Database }[] = [];
    const makeHost = () => {
      const db = createUiDb(":memory:");
      const host = new WsHost({ registry, catalog: createSessionCatalog(() => db) });
      hosts.push({ host, db });
      return host;
    };
    const host = makeHost();
    const clock = recoveryDeadline();
    const requests: Promise<unknown>[] = [];
    function recover(session: string, owner = host) {
      const result: { state: "pending" | "done"; value?: Awaited<ReturnType<typeof readSessionRecovery>> | string } = { state: "pending" };
      const promise = readSessionRecovery(owner, session, testPrincipal()).then(
        value => { result.state = "done"; result.value = value; return value; },
        (error: Error) => { result.state = "done"; result.value = error.message; return error.message; },
      );
      requests.push(promise);
      return { result, promise };
    }
    return {
      host, hosts, makeHost, clock, reads, recover,
      async close() {
        const failures: unknown[] = [];
        try {
          // The backend has no cancellation API. Release only during teardown,
          // after reuse assertions; clearing wrapper timers never releases it.
          for (const read of reads) read.release();
          await Promise.all(requests);
          await completed(() => reads.every(read => read.done) && clock.registrations.every(timer => timer.cleared), "RECOVERY_CLEANUP_SETTLES_READS_AND_WRAPPERS");
          expect(clock.pending(), "RECOVERY_CLEANUP_HAS_NO_PENDING_TIMER").toEqual([]);
        } catch (error) { failures.push(error); }
        finally {
          // Each owner is disposed even if another teardown action fails.
          for (const { host, db } of hosts) {
            try { host.close(); } catch (error) { failures.push(error); }
            try { db.close(); } catch (error) { failures.push(error); }
          }
          try { clock.restore(); } catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Recovery fixture disposal failed");
        expect(["setTimeout", "clearTimeout"].map(name => Object.getOwnPropertyDescriptor(globalThis, name)), "RECOVERY_TIMER_DESCRIPTORS_RESTORED").toEqual(clock.descriptors);
        for (const { host, db } of hosts) {
          expect(host.closing, "RECOVERY_HOST_CLOSED").toBe(true);
          expect(() => db.query("SELECT 1").get(), "RECOVERY_DATABASE_CLOSED").toThrow();
        }
      },
    };
  }

  test("cannot hold a recovery read open: another backend's history settles it, and silence everywhere is a failure", async () => {
    const f = fixture();
    try {
      const started = Date.now();
      const found = await f.recover("odyssey-imported").promise;
      expect(typeof found === "object" && found.kind).toBe("ok");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(f.clock.registrations.map(timer => timer.cleared), "RECOVERY_FOUND_CLEARS_ONLY_RESPONDING_BACKEND").toEqual([false, true]);
      const silent = f.recover("odyssey-nowhere");
      await completed(() => f.clock.registrations.length === 4 && f.clock.registrations[3]!.cleared, "RECOVERY_EMPTY_BACKEND_COMPLETES_BEFORE_ADVANCE");
      expect(f.reads.map(read => [read.session, read.done]), "RECOVERY_TWO_DISTINCT_UNFINISHED_READS").toEqual([["odyssey-imported", false], ["odyssey-nowhere", false]]);
      // The empty backend's real promise and bounded wrapper have completed;
      // only the explicitly held fixture reads and their deadlines remain.
      f.clock.advanceTo(2_999);
      await nativeTurn();
      expect(silent.result.state, "RECOVERY_PENDING_BEFORE_DEADLINE").toBe("pending");
      expect(f.clock.registrations.filter(timer => timer.fired), "RECOVERY_NO_EARLY_CALLBACK").toHaveLength(0);
      f.clock.advanceTo(3_000);
      expect(f.clock.registrations.filter(timer => timer.fired), "RECOVERY_BOTH_LOSING_WRAPPERS_REACH_DEADLINE").toHaveLength(2);
      await completed(() => silent.result.state === "done", "RECOVERY_CALLBACK_SETTLES_AT_DEADLINE");
      expect(await silent.promise).toBe("Session lookup timed out");
      expect(f.clock.registrations.map(timer => timer.delay), "RECOVERY_ACTUAL_REGISTRATION_IS_3000_MS").toEqual([3_000, 3_000, 3_000, 3_000]);
      expect(f.clock.registrations.every(timer => timer.cleared), "RECOVERY_TIMEOUT_CLEARS_WRAPPERS").toBe(true);
      expect(f.reads.every(read => !read.done), "RECOVERY_TIMEOUT_DOES_NOT_CANCEL_BACKEND").toBe(true);
      // Retries reuse the stalled backend's unfinished read instead of piling up more.
      for (let i = 0; i < 3; i++) {
        const retry = await f.recover("odyssey-imported").promise;
        expect(typeof retry === "object" && retry.kind).toBe("ok");
      }
      const stalledReads = f.reads.length;
      expect(stalledReads, "RECOVERY_RETRIES_REUSE_UNFINISHED_PROBES").toBe(2);
      expect(f.clock.pending(), "RECOVERY_RETRIES_OWN_THREE_LOSING_WRAPPERS").toHaveLength(3);
      expect(f.clock.pending().every(timer => timer.delay === 3_000 && timer.due === 6_000)).toBe(true);
    } finally { await f.close(); }
  }, 15_000);

  test("unfinished recovery probes belong to each host and backend independently", async () => {
    const f = fixture(true);
    try {
      const otherHost = f.makeHost();
      const requests = [f.recover("odyssey-nowhere"), f.recover("odyssey-nowhere"), f.recover("odyssey-nowhere", otherHost), f.recover("odyssey-nowhere", otherHost)];
      await completed(() => f.clock.registrations.length === 12, "RECOVERY_CONCURRENT_WRAPPERS_REGISTERED");
      await nativeTurn();
      expect(f.reads.map(read => read.backend).sort(), "RECOVERY_HOST_AND_BACKEND_IDENTITIES_ARE_INDEPENDENT").toEqual(["other", "other", "stalled", "stalled"]);
      await completed(() => f.clock.registrations.filter(timer => timer.cleared).length === 4, "RECOVERY_CONCURRENT_EMPTY_BACKENDS_COMPLETE");
      expect(f.clock.pending(), "RECOVERY_EACH_LOOKUP_OWNS_ITS_WRAPPERS").toHaveLength(8);
      f.clock.advanceTo(2_999);
      await nativeTurn();
      expect(requests.every(request => request.result.state === "pending")).toBe(true);
      f.clock.advanceTo(3_000);
      await completed(() => requests.every(request => request.result.state === "done"), "RECOVERY_CONCURRENT_CALLBACKS_SETTLE");
      expect(await Promise.all(requests.map(request => request.promise))).toEqual(Array(4).fill("Session lookup timed out"));
      expect(f.reads.every(read => !read.done)).toBe(true);
    } finally { await f.close(); }
  });

  test("an assertion failure releases held recovery reads, restores descriptors and closes every owner", async () => {
    const f = fixture();
    let failure: unknown;
    try {
      try {
        f.recover("odyssey-nowhere");
        await completed(() => f.reads.length === 1 && f.clock.registrations.length === 2, "RECOVERY_DIRTY_FAILURE_HAS_ACTIVE_RESOURCES");
        expect(f.reads[0]!.done, "RECOVERY_INJECTED_ASSERTION_FAILURE").toBe(true);
      } finally { await f.close(); }
    } catch (error) { failure = error; }
    expect(String(failure), "RECOVERY_FAILURE_CONTROL_REACHED_ASSERTION").toContain("RECOVERY_INJECTED_ASSERTION_FAILURE");
    expect(f.reads.every(read => read.done)).toBe(true);
    expect(f.clock.registrations).toEqual([]);
    let delivered = false;
    await new Promise<void>(resolve => setTimeout(() => { delivered = true; resolve(); }, 0));
    expect(delivered, "RECOVERY_SUCCESSOR_USES_NATIVE_TIMEOUT").toBe(true);
  });
});

describe("approval recovery after a partial history", () => {
  test("session_resume replays a history that ends on the user's message, then the still-pending approval under its turn", async () => {
    const w = world();
    await w.chat("Pass the Sirens");
    const t = await w.turn(0);
    const decided = t.bridge.requestPermission({ toolUseId: "tool-wax", toolName: "Bash", input: { command: "seal --ears" }, kind: "tool" });
    await until(() => w.host.coordinator.pendingApprovals.size === 1);
    const turnId = w.host.coordinator.bySession.get(t.sessionId)!.turnId;

    const from = w.frames.length;
    const history = await w.replay(t.sessionId);
    expect(history.map((m) => m.role)).toEqual(["user"]);
    const after = w.frames.slice(from);
    const historyAt = after.findIndex((f) => f.type === "session_history");
    const approvals = after.filter((f) => f.type === "tool_approval_request");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ type: "tool_approval_request", toolUseId: "tool-wax", sessionId: t.sessionId, turnId });
    expect(after.indexOf(approvals[0]!)).toBeGreaterThan(historyAt);

    // Answerable for the original turn.
    await w.send({ type: "tool_approval", toolUseId: "tool-wax", turnId });
    expect((await decided as PermissionDecision).behavior).toBe("allow");

    // Settled: another resume neither revives it nor sends a second card.
    const again = w.frames.length;
    await w.replay(t.sessionId);
    expect(w.frames.slice(again).filter((f) => f.type === "tool_approval_request")).toEqual([]);
    expect((await w.recover(t.sessionId)).pending).toEqual([]);
  });

  test("a resume of another session does not redeliver this session's approval", async () => {
    const w = world();
    await w.chat("Ithaca bound");
    const a = await w.turn(0);
    a.finish();
    await w.idle();
    await w.chat("Troy bound");
    const b = await w.turn(1);
    void b.bridge.requestPermission({ toolUseId: "tool-horse", toolName: "Bash", input: { command: "open --gates" }, kind: "tool" });
    await until(() => w.host.coordinator.pendingApprovals.size === 1);
    const from = w.frames.length;
    await w.replay(a.sessionId);
    expect(w.frames.slice(from).filter((f) => f.type === "tool_approval_request")).toEqual([]);
  });
});

describe("turn linkage", () => {
  test("only an answer the host saw its turn produce carries the turn, and an edited transcript loses it", async () => {
    const w = world();
    await w.chat("First watch");
    const first = await w.turn(0);
    first.finish();
    await w.idle();
    const sid = first.sessionId;
    const r1 = await w.recover(sid);
    // A turn that answered nothing links nothing, and the earlier answer
    // keeps its own turn.
    await w.chat("Second watch", { sessionId: sid });
    const second = await w.turn(1);
    second.finish({ answer: null });
    await w.idle();
    const r2 = await w.recover(sid);
    expect(r2.latest.turnId).not.toBe(r1.latest.turnId);
    let history = await w.replay(sid);
    expect(history.map((m) => m.turnId ?? null)).toEqual([null, r1.latest.turnId, null]);

    // Rewriting the transcript before the answer breaks the proof.
    w.transcripts.get(sid)![0]!.content = "First watch, edited";
    history = await w.replay(sid);
    expect(history.map((m) => [m.role, m.content])).toEqual([
      ["user", "First watch, edited"],
      ["assistant", "Answer to First watch."],
      ["user", "Second watch"],
    ]);
    expect(history.every((m) => m.turnId === undefined)).toBe(true);
  });
});


test("cancelling native admission settles both clients without starting a backend", async () => {
  let entered = false, cleaned = false;
  const w = world({ governedTurns: {
    async begin(_turn, signal) {
      entered = true;
      try {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      } finally { await Bun.sleep(10); cleaned = true; }
      throw new Error("unreachable admission");
    },
    facts() { throw new Error("No policy facts are needed before admission completes"); },
    refresh() {}, async close() {},
  } });
  const other: ServerMessage[] = [];
  w.host.clients.add({ send: data => other.push(JSON.parse(data)) }, w.principal.id);
  await w.chat("Plot the next course", { requestId: "cancel-native-admission" });
  await until(() => entered);
  await w.send({ type: "cancel" });
  await w.idle();
  expect(cleaned, "NATIVE_ADMISSION_CLEANUP_SETTLED").toBe(true);
  expect(w.turns, "CANCELLED_NATIVE_ADMISSION_NEVER_STARTS_BACKEND").toHaveLength(0);
  for (const frames of [w.frames, other]) {
    expect(frames.filter(frame => frame.type === "status" && frame.status === "cancelled" && frame.requestId === "cancel-native-admission"),
      "CANCELLED_NATIVE_ADMISSION_SETTLES_CLIENT_ONCE").toHaveLength(1);
    expect(frames.filter(frame => frame.type === "status" && frame.status === "idle"), "CANCELLED_ADMISSION_IS_NOT_REPLACED_WITH_IDLE").toHaveLength(0);
    expect(frames.filter(frame => frame.type === "error")).toEqual([]);
  }
});


test("finalization idle refreshes terminal times only after journal and history cleanup", async () => {
  const historyEntered = Promise.withResolvers<void>(), historyReleased = Promise.withResolvers<void>();
  const w = world({ historyRead: async () => { historyEntered.resolve(); await historyReleased.promise; } });
  const journalEntered = Promise.withResolvers<void>(), journalReleased = Promise.withResolvers<void>();
  await w.chat("Plot the course home", { requestId: "req-finalized" });
  const first = await w.turn(0), running = await w.recover(first.sessionId);
  const originalJournal = w.host.journal;
  Object.defineProperty(w.host, "journal", { value: { async finish() { journalEntered.resolve(); await journalReleased.promise; } }, configurable: true });
  const atIdle: ReturnType<typeof readSessionRecovery>[] = [];
  const send = w.ws.send;
  w.ws.send = data => {
    send(data);
    const frame = JSON.parse(data) as ServerMessage;
    if (frame.type === "status" && frame.status === "idle") atIdle.push(readSessionRecovery(w.host, first.sessionId, w.principal));
  };
  try {
    first.finish();
    await journalEntered.promise;
    expect(w.frames.some(frame => frame.type === "result")).toBe(true);
    expect((await w.recover(first.sessionId)).latest).toMatchObject({ state: "running", endedAt: null });
    expect(atIdle).toHaveLength(0);
    Object.defineProperty(w.host, "journal", { value: originalJournal, configurable: true });
    journalReleased.resolve();
    await historyEntered.promise;
    // Activity is committed and the live markers are cleared, but cleanup
    // still awaits history. The final notification must wait for it too.
    expect((await w.recover(first.sessionId)).latest).toMatchObject({ state: "terminal", outcome: "success" });
    expect(atIdle, "NO_FINAL_IDLE_BEFORE_REQUIRED_CLEANUP").toHaveLength(0);
  } finally {
    Object.defineProperty(w.host, "journal", { value: originalJournal, configurable: true });
    journalReleased.resolve(); historyReleased.resolve();
    await w.idle();
  }
  expect(atIdle, "FINALIZED_TURN_NOTIFIES_RECOVERY_CLIENT").toHaveLength(1);
  const read = await atIdle[0]!;
  expect(read.kind).toBe("ok");
  if (read.kind !== "ok") throw Error("Expected finalized recovery");
  expect(read.recovery.latest).toMatchObject({ turnId: running.latest.turnId, state: "terminal", outcome: "success" });
  expect(read.recovery.latest.endedAt).toBeNumber();
  const idle = w.frames.find(frame => frame.type === "status" && frame.status === "idle");
  expect(idle).toMatchObject({ sessionId: first.sessionId, turnId: running.latest.turnId });
  expect(w.frames.filter(frame => frame.type === "result")).toHaveLength(1);
});


for (const outcome of ["error", "cancelled", "timeout"] as const) {
  test(`finalization idle preserves the authoritative ${outcome} outcome`, async () => {
    const w = world(outcome === "timeout" ? { turnTimeoutMs: 20 } : {});
    await w.chat("Watch the crossing");
    const first = await w.turn(0);
    const atIdle: ReturnType<typeof readSessionRecovery>[] = [];
    const send = w.ws.send;
    w.ws.send = data => {
      send(data);
      const frame = JSON.parse(data) as ServerMessage;
      if (frame.type === "status" && frame.status === "idle") atIdle.push(readSessionRecovery(w.host, first.sessionId, w.principal));
    };
    if (outcome === "error") first.finish({ outcome: "error" });
    else if (outcome === "cancelled") await w.send({ type: "cancel", sessionId: first.sessionId });
    await w.idle();
    expect(atIdle, "FINAL_IDLE_RETAINS_HOST_TERMINAL_PRECEDENCE").toHaveLength(1);
    const read = await atIdle[0]!;
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw Error("Expected terminal recovery");
    expect(read.recovery.latest).toMatchObject({ state: "terminal", outcome });
    expect(read.recovery.latest.endedAt).toBeNumber();
    expect(w.frames.filter(frame => frame.type === "result")).toHaveLength(outcome === "error" ? 1 : 0);
  });
}

test("finalization idle keeps its turn identity ahead of the queued successor", async () => {
  const w = world();
  await w.chat("First watch", { requestId: "req-first-watch" });
  const first = await w.turn(0), before = await w.recover(first.sessionId);
  await w.chat("Next watch", { sessionId: first.sessionId, requestId: "req-next-watch" });
  const atIdle: ReturnType<typeof readSessionRecovery>[] = [];
  const send = w.ws.send;
  w.ws.send = data => {
    send(data);
    const frame = JSON.parse(data) as ServerMessage;
    if (frame.type === "status" && frame.status === "idle") atIdle.push(readSessionRecovery(w.host, first.sessionId, w.principal));
  };
  first.finish();
  const second = await w.turn(1);
  try {
    const idleIndex = w.frames.findIndex(frame => frame.type === "status" && frame.status === "idle");
    const nextIndex = w.frames.findIndex(frame => frame.type === "session_info" && (frame as { turnId?: string }).turnId !== before.latest.turnId);
    expect(idleIndex, "FINAL_IDLE_PRECEDES_QUEUED_SUCCESSOR").toBeGreaterThanOrEqual(0);
    expect(nextIndex).toBeGreaterThan(idleIndex);
    expect(w.frames[idleIndex]).toMatchObject({ sessionId: first.sessionId, turnId: before.latest.turnId });
    const read = await atIdle[0]!;
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw Error("Expected queued recovery");
    expect(read.recovery.latest).toMatchObject({ requestId: "req-next-watch", state: "queued", outcome: null });
  } finally { second.finish(); await w.idle(); }
});
