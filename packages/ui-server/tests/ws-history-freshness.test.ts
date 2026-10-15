import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage, ServerMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { handleClientMessage } from "../src/ws/dispatch";
import { WsHost } from "../src/ws/host";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization, testPrincipal } from "./helpers/principal";

const SESSION = "sirens";
const original: SessionHistoryMessage[] = [
  { role: "user", content: "Sail past the Sirens", toolCalls: [] },
  { role: "assistant", content: "Landed past the Sirens.", toolCalls: [] },
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface Turn {
  turnId: string;
  bridge: BackendBridge;
  finish(holdBackend?: boolean, outcome?: "success" | "cancelled"): void;
  end(answer?: string): void;
}

/** Real dispatch and turn execution; intentionally no accepted-work persistence. */
function world() {
  const transcripts = new Map<string, SessionHistoryMessage[]>([[SESSION, structuredClone(original)]]);
  const holds: Array<{ entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  const allHolds: typeof holds = [];
  const turns: Turn[] = [];
  const starts: Array<(turn: Turn) => void> = [];
  let reads = 0;
  const backend = makeFakeBackend({
    id: "fixture",
    async getHistory(sessionId) {
      reads++;
      const snapshot = structuredClone(transcripts.get(sessionId) ?? []);
      const hold = holds.shift();
      if (hold) { hold.entered.resolve(); await hold.release.promise; }
      return snapshot;
    },
    async startTurn(req) {
      const sessionId = req.sessionId!;
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: req.prompt, toolCalls: [] });
      req.bridge.emit({ type: "session_info", sessionId, isNew: false });
      const done = Promise.withResolvers<void>();
      let finished = false;
      const turn: Turn = {
        turnId: host.coordinator.bySession.get(sessionId)!.turnId,
        bridge: req.bridge,
        finish(holdBackend = false, outcome: "success" | "cancelled" = "success") {
          if (finished) return;
          finished = true;
          const content = `Noted: ${req.prompt}.`;
          transcript.push({ role: "assistant", content, toolCalls: [] });
          req.bridge.emit({ type: "text_delta", sessionId, text: content });
          req.bridge.emit({ type: "result", sessionId, outcome, isError: false, durationMs: 0, numTurns: 1 });
          if (!holdBackend) done.resolve();
        },
        end(answer) {
          if (!finished && answer !== undefined) transcript.push({ role: "assistant", content: answer, toolCalls: [] });
          finished = true;
          done.resolve();
        },
      };
      turns.push(turn);
      starts.shift()!(turn);
      await done.promise;
    },
  });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: {
      getStoredProviderId: () => null,
      getStoredBackendId: () => backend.id,
      persistSessionStub() {},
      persistSession() {},
    },
  });
  const principal = testPrincipal();
  const authorization = testAuthorization();
  const connection = { principal, authorization };
  const frames: ServerMessage[] = [];
  const ws: WSContext = { send: (data) => frames.push(JSON.parse(data)) };
  host.clients.add(ws, principal.id);
  const send = (msg: ClientMessage) => handleClientMessage(host, ws, msg, connection);
  cleanups.push(async () => {
    for (const hold of allHolds) hold.release.resolve();
    for (const turn of turns) { turn.finish(); turn.end(); }
    host.close();
    await Promise.all([...host.turnTasks]);
  });
  return {
    host, backend, transcripts, frames, authorization, principal,
    reads: () => reads,
    hold() {
      const hold = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      holds.push(hold); allHolds.push(hold);
      return hold;
    },
    resume: () => send({ type: "session_resume", sessionId: SESSION }),
    async start(prompt: string, sessionId = SESSION): Promise<Turn> {
      const started = Promise.withResolvers<Turn>();
      starts.push(started.resolve);
      await send({ type: "chat_message", sessionId, text: prompt, attachments: [] });
      return started.promise;
    },
    idle: () => Promise.all([...host.turnTasks]),
    snapshot() {
      const sent: ServerMessage[] = [];
      const socket: WSContext = { send: (data) => sent.push(JSON.parse(data)), close() {} };
      return { frames: sent, done: createWsHandlers(host, principal).onOpen(undefined as never, socket) };
    },
  };
}

const histories = (frames: ServerMessage[]) => frames.filter((frame) => frame.type === "session_history");

describe("history publication across concurrent turns", () => {
  test("an idle-to-idle completed turn invalidates an outstanding read without catalog revisions", async () => {
    const w = world();
    const hold = w.hold();
    const resumed = w.resume();
    await hold.entered.promise;
    const turn = await w.start("Then bind me to the mast");
    turn.finish();
    await w.idle();
    expect(w.host.catalog.latestWork).toBeUndefined();
    expect(w.host.coordinator.bySession.has(SESSION)).toBe(false);
    hold.release.resolve();
    await resumed;
    expect(histories(w.frames).flatMap((frame) => frame.messages)).toEqual(w.transcripts.get(SESSION)!);
    expect(w.reads()).toBe(2);
    expect(w.frames.at(-1)).toMatchObject({ type: "status", sessionId: SESSION, status: "idle" });
  });

  test("a second changing read fails without publishing either stale snapshot, then a later resume succeeds", async () => {
    const w = world();
    const first = w.hold(), second = w.hold();
    const resumed = w.resume();
    await first.entered.promise;
    (await w.start("Bind me to the mast")).finish();
    await w.idle();
    first.release.resolve();
    await second.entered.promise;
    (await w.start("Keep rowing")).finish();
    await w.idle();
    second.release.resolve();
    await resumed;
    expect(w.reads()).toBe(2);
    expect(histories(w.frames)).toHaveLength(0);
    expect(w.frames.filter((frame) => frame.type === "error")).toEqual([
      { type: "error", code: "SESSION_LOAD_ERROR", sessionId: SESSION, message: "Session changed while its history was loading. Try again." },
    ]);
    await w.resume();
    expect(w.reads()).toBe(3);
    expect(histories(w.frames).flatMap((frame) => frame.messages)).toEqual(w.transcripts.get(SESSION)!);
  });

  test("a stable empty replacement remains authoritative", async () => {
    const w = world();
    w.transcripts.set(SESSION, []);
    await w.resume();
    expect(histories(w.frames)).toEqual([{ type: "session_history", sessionId: SESSION, messages: [] }]);
    expect(w.reads()).toBe(1);
  });

  test("cleanup idle for a result already observed does not invalidate the reread", async () => {
    const w = world();
    const turn = await w.start("Bind me to the mast");
    const first = w.hold(), second = w.hold();
    const resumed = w.resume();
    await first.entered.promise;
    turn.finish(true);
    first.release.resolve();
    await second.entered.promise;
    turn.end();
    await w.idle();
    expect(w.frames.at(-1)).toMatchObject({ type: "status", status: "idle", turnId: turn.turnId });
    second.release.resolve();
    await resumed;
    expect(w.reads()).toBe(2);
    expect(w.frames.filter((frame) => frame.type === "error")).toHaveLength(0);
    expect(histories(w.frames).flatMap((frame) => frame.messages)).toEqual(w.transcripts.get(SESSION)!);
  });

  test("a cancelled status cannot make the later terminal result invisible to the reread", async () => {
    const w = world();
    const turn = await w.start("Bind me to the mast");
    const first = w.hold(), second = w.hold();
    const resumed = w.resume();
    await first.entered.promise;
    turn.bridge.emit({ type: "status", sessionId: SESSION, status: "cancelled" });
    first.release.resolve();
    await second.entered.promise;
    turn.finish(false, "cancelled");
    await w.idle();
    second.release.resolve();
    await resumed;
    expect(w.reads()).toBe(2);
    expect(histories(w.frames), "the result changed the second snapshot too").toHaveLength(0);
    expect(w.frames.at(-1)).toMatchObject({ type: "error", code: "SESSION_LOAD_ERROR", sessionId: SESSION });
  });

  test("host cleanup without a backend result still invalidates the read", async () => {
    const w = world();
    const turn = await w.start("Check the oars");
    const hold = w.hold();
    const resumed = w.resume();
    await hold.entered.promise;
    turn.end("The oars are ready.");
    await w.idle();
    hold.release.resolve();
    await resumed;
    expect(w.frames.filter((frame) => frame.type === "result")).toHaveLength(0);
    expect(w.reads()).toBe(2);
    expect(histories(w.frames).flatMap((frame) => frame.messages)).toEqual(w.transcripts.get(SESSION)!);
  });

  test("another session completing does not invalidate this history", async () => {
    const w = world();
    const hold = w.hold();
    const resumed = w.resume();
    await hold.entered.promise;
    (await w.start("Check the oars", "ithaca")).finish();
    await w.idle();
    hold.release.resolve();
    await resumed;
    expect(w.reads()).toBe(1);
    expect(histories(w.frames).flatMap((frame) => frame.messages)).toEqual(original);
  });

  test("text arriving within the same running turn does not consume a retry", async () => {
    const w = world();
    const turn = await w.start("Bind me to the mast");
    const hold = w.hold();
    const resumed = w.resume();
    await hold.entered.promise;
    turn.bridge.emit({ type: "text_delta", sessionId: SESSION, text: "The rope holds." });
    hold.release.resolve();
    await resumed;
    expect(w.reads()).toBe(1);
    expect(w.frames.at(-1)).toMatchObject({ type: "status", status: "thinking", turnId: turn.turnId });
    turn.finish();
    await w.idle();
  });

  test("revocation during the second read prevents history and error publication", async () => {
    const w = world();
    const first = w.hold(), second = w.hold();
    const resumed = w.resume();
    await first.entered.promise;
    (await w.start("Bind me to the mast")).finish();
    await w.idle();
    first.release.resolve();
    await second.entered.promise;
    w.authorization.valid = false;
    second.release.resolve();
    await resumed;
    expect(w.reads()).toBe(2);
    expect(histories(w.frames)).toHaveLength(0);
    expect(w.frames.filter((frame) => frame.type === "error")).toHaveLength(0);
  });

  for (const successor of [false, true]) test(`connect snapshot settles with the current ${successor ? "queued turn" : "idle session"}`, async () => {
    const w = world();
    const originalTurn = await w.start("Check the sail");
    const hold = w.hold();
    const snapshot = w.snapshot();
    await hold.entered.promise;
    const queued = successor ? w.start("Bind me to the mast") : undefined;
    originalTurn.finish();
    const next = queued ? await queued : undefined;
    if (!next) await w.idle();
    hold.release.resolve();
    await snapshot.done;
    expect(histories(snapshot.frames).flatMap((frame) => frame.messages)).toEqual(w.transcripts.get(SESSION)!);
    expect(w.reads()).toBe(2);
    const status = snapshot.frames.at(-1);
    expect(status).toMatchObject({ type: "status", sessionId: SESSION, status: next ? "thinking" : "idle" });
    if (next) expect(status).toHaveProperty("turnId", next.turnId);
    else expect(status).not.toHaveProperty("turnId");
    next?.finish();
    await w.idle();
  });

  test("a connect snapshot that changes twice reports the load error and current idle state", async () => {
    const w = world();
    const originalTurn = await w.start("Check the sail");
    const first = w.hold(), second = w.hold();
    const snapshot = w.snapshot();
    await first.entered.promise;
    originalTurn.finish();
    await w.idle();
    first.release.resolve();
    await second.entered.promise;
    (await w.start("Bind me to the mast")).finish();
    await w.idle();
    second.release.resolve();
    await snapshot.done;
    expect(w.reads()).toBe(2);
    expect(histories(snapshot.frames)).toHaveLength(0);
    expect(snapshot.frames.filter((frame) => frame.type === "error")).toHaveLength(1);
    expect(snapshot.frames.at(-2)).toMatchObject({ type: "error", code: "SESSION_LOAD_ERROR", sessionId: SESSION });
    expect(snapshot.frames.at(-1)).toMatchObject({ type: "status", status: "idle", sessionId: SESSION });
  });
});
