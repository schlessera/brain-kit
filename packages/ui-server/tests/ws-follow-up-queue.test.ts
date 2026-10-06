/**
 * Pending follow-ups survive a reload (#1002). A message sent while its
 * session is busy waits in the host's in-memory queue and enters the
 * transcript only when its own turn starts, so a client that reloads or
 * reconnects must be told what is still waiting, and every client must learn
 * when an entry is handed to the agent or dropped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 25));

const SESSION = "sess-ithaca";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Every turn names the session and then waits until the test finishes it. */
function setup() {
  const db = createUiDb(":memory:");
  const finishers: Array<() => void> = [];
  const prompts: string[] = [];
  const backend = makeFakeBackend({
    id: "fake",
    startTurn: async ({ bridge, prompt, signal }) => {
      prompts.push(prompt);
      bridge.emit({ type: "session_info", sessionId: SESSION, isNew: prompts.length === 1 });
      await new Promise<void>((resolve) => {
        finishers.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      bridge.emit({ type: "result", sessionId: SESSION, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
  });
  cleanup = () => {
    for (const finish of finishers) finish();
    host.coordinator.reset();
    host.close();
    db.close();
  };
  async function connect(capabilities?: Record<string, boolean>, principalId?: string) {
    const handlers = createWsHandlers(host, testPrincipal(principalId));
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    if (capabilities) send({ type: "client_hello", protocolRev: 5, capabilities });
    await settle();
    const all = (): any[] => sent.map((x) => JSON.parse(x));
    const frames = (type: string): any[] => all().filter((f) => f.type === type);
    const close = () => handlers.onClose({ code: 1000 } as CloseEvent, ws);
    return { send, frames, all, close };
  }
  /** Start the session's first turn and wait until it is running. */
  async function busy(client: Awaited<ReturnType<typeof connect>>) {
    client.send({ type: "chat_message", text: "Chart the way home", requestId: "req-first" });
    await until(() => finishers.length === 1 && host.coordinator.bySession.has(SESSION));
  }
  function finishCurrent() {
    finishers.at(-1)!();
  }
  return { host, prompts, finishers, connect, busy, finishCurrent };
}

const ids = (frame: any) => frame.followUps.map((f: any) => f.requestId);

describe("session_queue", () => {
  test("follow-ups are reported in send order, to declaring connections only", async () => {
    const s = setup();
    const client = await s.connect({ followUpQueue: true });
    const legacy = await s.connect();
    await s.busy(client);
    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    client.send({ type: "chat_message", text: "Keep the bag of winds shut", sessionId: SESSION, requestId: "req-bag" });
    client.send({ type: "chat_message", text: "Steer clear of the Cyclopes", sessionId: SESSION, requestId: "req-cyclopes" });
    await until(() => client.frames("session_queue").length === 3);

    const last = client.frames("session_queue").at(-1);
    expect(last.sessionId).toBe(SESSION);
    expect(ids(last)).toEqual(["req-winds", "req-bag", "req-cyclopes"]);
    expect(last.followUps[0]).toMatchObject({ text: "Ask Aeolus about the winds", queuedAt: expect.any(Number), id: expect.any(String) });
    expect(new Set(last.followUps.map((f: any) => f.id)).size).toBe(3);
    // A legacy connection sees exactly the frames it always saw.
    expect(legacy.frames("session_queue")).toEqual([]);
    expect(legacy.frames("status").some((f) => f.status === "queued")).toBe(true);
  });

  test("a client that reloads gets the queue back, and so does a session_resume", async () => {
    const s = setup();
    const first = await s.connect({ followUpQueue: true });
    await s.busy(first);
    first.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    first.send({ type: "chat_message", text: "Keep the bag of winds shut", sessionId: SESSION, requestId: "req-bag" });
    await until(() => first.frames("session_queue").length === 2);
    first.close();

    // The reload: a new socket that declares the capability.
    const reloaded = await s.connect({ followUpQueue: true });
    const snapshot = reloaded.frames("session_queue");
    expect(snapshot).toHaveLength(1);
    expect(ids(snapshot[0])).toEqual(["req-winds", "req-bag"]);
    expect(snapshot[0].started).toBeUndefined();
    expect(snapshot[0].dropped).toBeUndefined();

    // Opening the session replaces its transcript; the queue comes with it.
    reloaded.send({ type: "session_resume", sessionId: SESSION });
    await until(() => reloaded.frames("session_queue").length === 2);
    expect(ids(reloaded.frames("session_queue")[1])).toEqual(["req-winds", "req-bag"]);
  });

  test("a second client sees the follow-up another client queued", async () => {
    const s = setup();
    const phone = await s.connect({ followUpQueue: true });
    const desk = await s.connect({ followUpQueue: true });
    await s.busy(phone);
    phone.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    await until(() => desk.frames("session_queue").length === 1);
    expect(ids(desk.frames("session_queue")[0])).toEqual(["req-winds"]);
  });

  test("a started follow-up leaves the queue ahead of every frame of its own turn", async () => {
    const s = setup();
    const client = await s.connect({ followUpQueue: true });
    await s.busy(client);
    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    client.send({ type: "chat_message", text: "Keep the bag of winds shut", sessionId: SESSION, requestId: "req-bag" });
    await until(() => client.frames("session_queue").length === 2);

    s.finishCurrent();
    await until(() => s.prompts.length === 2);
    await settle();

    const frames = client.all();
    const startedAt = frames.findIndex((f) => f.type === "session_queue" && f.started);
    expect(startedAt, "the host reports the follow-up it handed over").toBeGreaterThan(-1);
    const started = frames[startedAt];
    expect(started.started).toMatchObject({ requestId: "req-winds", text: "Ask Aeolus about the winds" });
    expect(ids(started)).toEqual(["req-bag"]);
    // The next turn's own frames all come after, under the turn id it names.
    const nextTurn = frames.findIndex((f, i) => i > startedAt && f.type === "session_info" && f.requestId === "req-winds");
    expect(nextTurn).toBeGreaterThan(startedAt);
    expect(frames[nextTurn].turnId).toBe(started.started.turnId);
    expect(frames.slice(0, startedAt).some((f) => f.turnId === started.started.turnId)).toBe(false);

    // The last one goes the same way, and the queue is then empty.
    s.finishCurrent();
    await until(() => s.prompts.length === 3);
    await settle();
    const last = client.frames("session_queue").at(-1);
    expect(last.started).toMatchObject({ requestId: "req-bag" });
    expect(last.followUps).toEqual([]);
    // A reload now has nothing to rebuild.
    const reloaded = await s.connect({ followUpQueue: true });
    expect(reloaded.frames("session_queue")).toEqual([]);
  });

  test("a cancelled session's follow-ups are dropped with the reason and not shown after reload", async () => {
    const s = setup();
    const client = await s.connect({ followUpQueue: true });
    await s.busy(client);
    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    client.send({ type: "chat_message", text: "Keep the bag of winds shut", sessionId: SESSION, requestId: "req-bag" });
    await until(() => client.frames("session_queue").length === 2);

    client.send({ type: "cancel", sessionId: SESSION });
    await until(() => client.frames("session_queue").length === 3);
    const dropped = client.frames("session_queue")[2];
    expect(dropped.followUps).toEqual([]);
    expect(dropped.dropped.map((d: any) => [d.requestId, d.reason])).toEqual([
      ["req-winds", "Cancelled by user"],
      ["req-bag", "Cancelled by user"],
    ]);
    await until(() => !s.host.coordinator.bySession.has(SESSION));
    expect(s.prompts).toHaveLength(1);

    const reloaded = await s.connect({ followUpQueue: true });
    expect(reloaded.frames("session_queue")).toEqual([]);
    reloaded.send({ type: "session_resume", sessionId: SESSION });
    await until(() => reloaded.frames("session_queue").length === 1);
    expect(reloaded.frames("session_queue")[0].followUps).toEqual([]);
  });

  test("a revoked sender's follow-up is dropped, and the others stay", async () => {
    const s = setup();
    const owner = await s.connect({ followUpQueue: true });
    const borrowed = await s.connect({ followUpQueue: true }, "principal-borrowed-tablet");
    await s.busy(owner);
    borrowed.send({ type: "chat_message", text: "Sail past the Sirens", sessionId: SESSION, requestId: "req-sirens" });
    owner.send({ type: "chat_message", text: "Keep the bag of winds shut", sessionId: SESSION, requestId: "req-bag" });
    await until(() => owner.frames("session_queue").length === 2);

    s.host.revokePrincipals(["principal-borrowed-tablet"], 4001, "revoked");
    await until(() => owner.frames("session_queue").length === 3);
    const frame = owner.frames("session_queue")[2];
    expect(ids(frame)).toEqual(["req-bag"]);
    expect(frame.dropped.map((d: any) => d.requestId)).toEqual(["req-sirens"]);
    expect(frame.dropped[0].reason).toBe("Its sender was signed out.");
  });

  test("an entry being handed over is still pending until its turn reaches the backend", () => {
    const s = setup();
    const entry = { followUpId: "fu-1", requestId: "req-winds", text: "Ask Aeolus", attachments: [], queuedAt: 1 } as never;
    const queued = { followUpId: "fu-2", requestId: "req-bag", text: "Keep the bag shut", attachments: [], queuedAt: 2 } as never;
    s.host.coordinator.bySession.set(SESSION, { handingOver: entry, queue: [queued] } as never);
    expect(s.host.followUpQueueFrame(SESSION).followUps.map((f) => f.requestId)).toEqual(["req-winds", "req-bag"]);
    expect(s.host.coordinator.sessionsWithFollowUps()).toEqual([SESSION]);
    s.host.coordinator.bySession.delete(SESSION);
  });
});
