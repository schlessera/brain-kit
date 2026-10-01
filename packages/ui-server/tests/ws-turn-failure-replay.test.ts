import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage, TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { buildSessionHistory } from "../../ui-backend-claude/src/history";
import { normalizeMessages } from "../../ui-backend-pi/src/history";
import { makeFakeBackend } from "./helpers/fake-backend";
import { addClient, closeDb, getDb, handleClientMessage, removeDbFile, resetForTests, setBackendsForTests, testHost, useTestDb } from "./helpers/test-host";
import type { WSContext } from "../src/ws/clients";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";

const TEST_DB = `/tmp/brain-ui-failure-replay-${process.pid}.db`;
beforeEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); useTestDb(TEST_DB); });
afterEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); });

async function settled(complete: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (complete() && !testHost().coordinator.isTurnActive()) return;
    await Bun.sleep(5);
  }
  throw new Error("turn did not settle");
}

/** Real backend history normalizers, with only their transcript transport replaced. */
function harness(id: "claude" | "pi") {
  const raw: any[] = [];
  const frames: ServerMessage[] = [];
  const ws: WSContext = { send: (data) => frames.push(JSON.parse(data)) };
  let failure: TurnFailure | undefined;
  let turns = 0;
  let persist = true;
  let historyHold: Promise<void> | undefined;
  let reads = 0;
  const bridges: BackendBridge[] = [];
  let lateFailure: TurnFailure | undefined;
  const backend = makeFakeBackend({
    id,
    async startTurn(req) {
      turns++;
      bridges.push(req.bridge);
      req.bridge.emit({ type: "session_info", sessionId: "s1", isNew: turns === 1 });
      if (persist && id === "claude") {
        raw.push({ type: "user", message: { content: req.prompt } });
        raw.push({ type: "assistant", message: { model: "fixture", content: [{ type: "text", text: "Partial answer." }] } });
        raw.push({ type: "assistant", message: { model: failure ? "<synthetic>" : "fixture", content: [{ type: "text", text: failure?.message ?? " Success." }] } });
      } else if (persist) {
        raw.push({ role: "user", content: req.prompt });
        // pi retains each assistant step; Claude folds them into one message.
        raw.push({ role: "assistant", content: [{ type: "text", text: "Partial answer." }] });
        raw.push({ role: "assistant", content: [{ type: "text", text: failure ? "" : "Success." }], stopReason: failure ? "error" : "stop", errorMessage: failure?.message });
      }
      req.bridge.emit({ type: "text_delta", text: "Partial answer." });
      if (lateFailure && turns > 1) bridges[0]!.emit({ type: "result", sessionId: "s1", numTurns: 1, durationMs: 1,
        isError: true, outcome: "error", failure: lateFailure });
      req.bridge.emit({ type: "result", sessionId: "s1", numTurns: 1, durationMs: 1, isError: !!failure,
        outcome: failure ? "error" : "success", ...(failure ? { failure } : {}) });
    },
    async getHistory() {
      reads++;
      const hold = historyHold;
      historyHold = undefined;
      await hold;
      return id === "claude"
        ? buildSessionHistory("s1", async () => raw, "/fixture")
        : normalizeMessages(raw);
    },
  });
  setBackendsForTests([backend], id);
  addClient(ws);
  return {
    raw, frames, backend,
    get reads() { return reads; },
    withholdTranscript() { persist = false; },
    emitLateFailure(next: TurnFailure) { lateFailure = next; },
    holdHistory() {
      let release!: () => void;
      historyHold = new Promise<void>((resolve) => { release = () => { historyHold = undefined; resolve(); }; });
      return release;
    },
    async send(next?: TurnFailure) {
      failure = next;
      const expected = frames.filter((frame) => frame.type === "result").length + 1;
      await handleClientMessage(ws, { type: "chat_message", text: "yes", attachments: [], ...(turns || raw.length ? { sessionId: "s1" } : {}) });
      await settled(() => frames.filter((frame) => frame.type === "result").length >= expected);
    },
    async replay() { return testHost().prepareHistory("s1", await backend.getHistory("s1")); },
  };
}

for (const id of ["claude", "pi"] as const) describe(`${id}: live failure survives host replay`, () => {
  test("preserves class, status, message and auth action on the terminal assistant", async () => {
    const h = harness(id);
    const live: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 The provider rejected this request." };
    await h.send(live);
    const terminal = h.frames.find((frame) => frame.type === "result");
    expect(terminal?.type === "result" && terminal.failure).toEqual(live);
    const replay = await h.replay();
    expect(replay.filter((message) => message.role === "assistant").length).toBeGreaterThan(0);
    expect(replay.at(-1)?.failure?.errorClass).toBe("invalid_request");
    expect(replay.at(-1)?.failure).toEqual(live);
    expect(replay.some((message) => message.content.includes("Partial answer."))).toBe(true);

    const auth: TurnFailure = { errorClass: "billing_error", status: 402, message: "API Error: 402 Account access is restricted.", authAction: "check_account" };
    await h.send(auth);
    expect((await h.replay()).at(-1)?.failure).toEqual(auth);
  });

  test("identical prompts and failure texts retain distinct failures through a later success", async () => {
    const h = harness(id);
    const text = "API Error: 400 Request refused.";
    const first: TurnFailure = { errorClass: "invalid_request", status: 400, message: text };
    const second: TurnFailure = { errorClass: "model_not_found", status: 400, message: text };
    await h.send(first); await h.send(second); await h.send();
    const replay = await h.replay();
    expect(replay.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["yes", "yes", "yes"]);
    expect(replay.filter((message) => message.failure).map((message) => message.failure?.errorClass)).toEqual(["invalid_request", "model_not_found"]);
    expect(replay.filter((message) => message.failure).map((message) => message.failure)).toEqual([first, second]);
    expect(replay.at(-1)?.failure).toBeUndefined();
  });

  test("unrecorded legacy failures are unchanged and do not shift the new assistant position", async () => {
    const h = harness(id);
    // Same text as the new failure, from a turn this host never saw.
    const text = "API Error: 400 Request refused.";
    if (id === "claude") h.raw.push({ type: "user", message: { content: "legacy" } }, { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] } });
    else h.raw.push({ role: "user", content: "legacy" }, { role: "assistant", content: [], stopReason: "error", errorMessage: text });
    const old = await h.backend.getHistory("s1");
    expect(old.at(-1)?.failure?.message).toBe(text);
    expect(testHost().prepareHistory("s1", old)).toEqual(old);
    await h.send({ errorClass: "model_not_found", status: 400, message: text });
    const replay = await h.replay();
    expect(replay[1]?.failure).toEqual(old[1]?.failure);
    expect(replay.at(-1)?.failure?.errorClass).toBe("model_not_found");
  });

  test("recorded metadata is durable across a new host and database connection", async () => {
    const h = harness(id);
    const live: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." };
    await h.send(live);
    // Reopen the durable database and rebuild the host, as a server restart does.
    resetForTests(); closeDb(); useTestDb(TEST_DB); setBackendsForTests([h.backend], id);
    expect((await h.replay()).at(-1)?.failure?.errorClass).toBe("invalid_request");
    expect((await h.replay()).at(-1)?.failure).toEqual(live);
  });

  test("a failed turn with no new stored answer cannot relabel an unrecorded identical failure", async () => {
    const h = harness(id);
    const first: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." };
    await h.send(first);
    expect(getDb().query("SELECT COUNT(*) AS n FROM turn_failures").get()).toEqual({ n: 1 });
    getDb().exec("DELETE FROM turn_failures");
    const fallback = await h.backend.getHistory("s1");
    expect(fallback.at(-1)?.failure).toBeDefined();
    h.withholdTranscript();
    await h.send({ ...first, errorClass: "model_not_found" });
    const replay = await h.replay();
    expect(replay.filter((message) => message.failure)).toHaveLength(1);
    expect(replay.at(-1)?.failure?.errorClass).toBe(fallback.at(-1)?.failure?.errorClass);
    expect(replay.at(-1)?.failure).toEqual(fallback.at(-1)?.failure);
    expect(getDb().query("SELECT COUNT(*) AS n FROM turn_failures").get()).toEqual({ n: 0 });
  });

  test("a changed transcript prefix and another session keep the backend fallback", async () => {
    const h = harness(id);
    const live: TurnFailure = { errorClass: "model_not_found", status: 400, message: "API Error: 400 Request refused." };
    await h.send(live);
    const original = await h.backend.getHistory("s1");
    expect(original.at(-1)?.failure).toBeDefined();
    expect(testHost().prepareHistory("s2", original)).toEqual(original);
    if (id === "claude") h.raw[0].message.content = "Changed earlier prompt.";
    else h.raw[0].content = "Changed earlier prompt.";
    const changed = await h.backend.getHistory("s1");
    expect(testHost().prepareHistory("s1", changed)).toEqual(changed);
  });

  test("unreadable saved metadata falls back without losing history", async () => {
    const h = harness(id);
    await h.send({ errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." });
    const original = await h.backend.getHistory("s1");
    getDb().prepare("UPDATE turn_failures SET failure_json = ?").run('{"errorClass":42,"message":"wrong"}');
    expect(testHost().prepareHistory("s1", original)).toEqual(original);
    getDb().prepare("UPDATE turn_failures SET failure_json = ?").run("invalid JSON");
    expect(testHost().prepareHistory("s1", original)).toEqual(original);
    getDb().prepare("UPDATE turn_failures SET failure_json = ?").run(JSON.stringify({ errorClass: "model_not_found", message: "Different failure." }));
    expect(testHost().prepareHistory("s1", original)).toEqual(original);
  });

  test("unobserved status and auth action stay absent even when fallback infers a status", async () => {
    const h = harness(id);
    const live: TurnFailure = { errorClass: "invalid_request", message: "API Error: 400 Request refused." };
    await h.send(live);
    expect((await h.replay()).at(-1)?.failure).toEqual(live);
    expect((await h.replay()).at(-1)?.failure?.status).toBeUndefined();
    expect((await h.replay()).at(-1)?.failure?.authAction).toBeUndefined();
  });

  test("local command assistants do not shift the backend failure positions", async () => {
    const h = harness(id);
    const first: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." };
    const second: TurnFailure = { ...first, errorClass: "model_not_found" };
    await h.send(first);
    expect(testHost().catalog.recordLocalExchange?.("s1", {
      id: "local-stats", command: "stats", prompt: "Stats", context: "Documents: 3",
      answer: [{ kind: "tiles", source: "corpus", tiles: [{ label: "Documents", value: "3" }] }],
    }, false)).toBe(true);
    await h.send(second);
    const replay = await h.replay();
    expect(replay.filter((message) => message.localAnswer)).toHaveLength(1);
    expect(replay.find((message) => message.localAnswer)?.failure).toBeUndefined();
    expect(replay.filter((message) => message.failure).map((message) => message.failure)).toEqual([first, second]);
  });

  test("an unreadable terminal transcript keeps the live frame and backend fallback", async () => {
    const h = harness(id);
    const read = h.backend.getHistory;
    h.backend.getHistory = async () => { throw new Error("Fixture transcript unavailable"); };
    const live: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." };
    await h.send(live);
    h.backend.getHistory = read;
    expect(h.frames.find((frame) => frame.type === "result")?.type).toBe("result");
    const fallback = await read("s1");
    expect(fallback.at(-1)?.failure).toBeDefined();
    expect(await h.replay()).toEqual(fallback);
    expect(getDb().query("SELECT COUNT(*) AS n FROM turn_failures").get()).toEqual({ n: 0 });
  });

  test("an unavailable metadata store does not drop the live frame or history", async () => {
    const h = harness(id);
    getDb().exec("DROP TABLE turn_failures");
    const live: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." };
    await h.send(live);
    const terminal = h.frames.find((frame) => frame.type === "result");
    expect(terminal?.type === "result" && terminal.failure).toEqual(live);
    const fallback = await h.backend.getHistory("s1");
    expect(fallback.at(-1)?.failure).toBeDefined();
    expect(await h.replay()).toEqual(fallback);
  });

  test("a closed successful turn's late failure cannot label a later failed assistant", async () => {
    const h = harness(id);
    await h.send();
    const live: TurnFailure = { errorClass: "model_not_found", status: 400, message: "API Error: 400 Request refused." };
    h.emitLateFailure({ ...live, errorClass: "invalid_request" });
    await h.send(live);
    const replay = await h.replay();
    expect(replay.filter((message) => message.failure)).toHaveLength(1);
    expect(replay.at(-1)?.failure?.errorClass).toBe("model_not_found");
    expect(replay.at(-1)?.failure).toEqual(live);
  });

  test("a reconnect during the terminal history write waits for the observed classification", async () => {
    const h = harness(id);
    const live: TurnFailure = { errorClass: "invalid_request", status: 400, message: "API Error: 400 Request refused." };
    const release = h.holdHistory();
    const sending = h.send(live);
    try {
      for (let i = 0; i < 200 && h.reads === 0; i++) await Bun.sleep(5);
      expect(h.frames.filter((frame) => frame.type === "result")).toHaveLength(1);
      expect(h.reads).toBe(1);
      const frames: ServerMessage[] = [];
      const loading = handleClientMessage({ send: (data) => frames.push(JSON.parse(data)) }, { type: "session_resume", sessionId: "s1" });
      await Bun.sleep(10);
      expect(frames.some((frame) => frame.type === "session_history")).toBe(false);
      release();
      await sending; await loading;
      const replay = frames.find((frame) => frame.type === "session_history");
      expect(replay?.type === "session_history" && replay.messages.at(-1)?.failure?.errorClass).toBe("invalid_request");
      expect(replay?.type === "session_history" && replay.messages.at(-1)?.failure).toEqual(live);
    } finally { release(); await sending; }
  });
});
