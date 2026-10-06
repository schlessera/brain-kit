import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ClientChatMessage,
  MessageSource,
  ServerMessage,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "../src/ws/clients";
import { attachMessageSources, saveMessageSource } from "../src/ws/message-sources";
import { makeFakeBackend } from "./helpers/fake-backend";
import {
  closeDb,
  getDb,
  handleClientMessage,
  removeDbFile,
  resetForTests,
  setBackendsForTests,
  testHost,
  useTestDb,
} from "./helpers/test-host";

/**
 * How a user message was produced survives its replay: the host records the
 * source a client sends on `chat_message` and joins it back onto the user
 * messages the backend replays, so a dictated message is still dictated after
 * a reload or on another device (#549). The test host wires no classifier, so
 * every replay here runs without one.
 */

const TEST_DB = `/tmp/brain-ui-ws-message-source-${process.pid}.db`;

beforeEach(() => {
  closeDb();
  removeDbFile(TEST_DB);
  useTestDb(TEST_DB);
  resetForTests();
});

afterEach(() => {
  resetForTests();
  closeDb();
  removeDbFile(TEST_DB);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

/**
 * A backend with a real transcript: every prompt it is handed is stored as a
 * user message, as both production backends store theirs, and `getHistory`
 * replays it. `hold` parks the next turn until released.
 */
function transcriptBackend(options: { sessionId: string; followUp?: boolean }) {
  const transcript: SessionHistoryMessage[] = [];
  let turns = 0;
  let hold: Promise<void> | null = null;
  const backend = makeFakeBackend({
    id: "claude",
    capabilities: options.followUp ? { followUp: true } : {},
    async startTurn(request: StartTurnRequest) {
      turns += 1;
      request.bridge.emit({
        type: "session_info",
        sessionId: options.sessionId,
        isNew: turns === 1,
        providerId: "claude",
      });
      transcript.push({ role: "user", content: request.prompt, toolCalls: [] });
      if (hold) await hold;
      transcript.push({ role: "assistant", content: "Noted.", toolCalls: [] });
      request.bridge.emit({
        type: "result",
        sessionId: options.sessionId,
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    },
    ...(options.followUp
      ? {
          async followUp(request: { prompt: string }) {
            transcript.push({ role: "user", content: request.prompt, toolCalls: [] });
          },
        }
      : {}),
    getHistory: async () => transcript.map((message) => ({ ...message })),
  });
  return {
    backend,
    get turns() {
      return turns;
    },
    get transcript() {
      return transcript;
    },
    holdNextTurn(): () => void {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
      return release;
    },
  };
}

function socket(): { ws: WSContext; frames: ServerMessage[] } {
  const frames: ServerMessage[] = [];
  return { ws: { send: (raw: string) => frames.push(JSON.parse(raw)) }, frames };
}

function send(ws: WSContext, text: string, extra: Partial<ClientChatMessage> = {}) {
  return handleClientMessage(ws, { type: "chat_message", text, ...extra });
}

/** Resume the session on a fresh socket, as a reload or a second device does. */
async function replay(sessionId: string): Promise<SessionHistoryMessage[]> {
  const { ws, frames } = socket();
  await handleClientMessage(ws, { type: "session_resume", sessionId });
  const history = frames.find((frame) => frame.type === "session_history");
  if (!history || history.type !== "session_history") throw new Error("no session_history sent");
  // Host-proven turn ids (#964) are asserted in ws-session-recovery.test.ts.
  return history.messages.map(({ turnId: _turnId, ...message }) => message);
}

function userSources(messages: SessionHistoryMessage[]): Array<MessageSource | undefined> {
  return messages.filter((message) => message.role === "user").map((message) => message.source);
}

describe("a replayed user message keeps its source", () => {
  test("a dictated message that started the session replays as dictated", async () => {
    const fake = transcriptBackend({ sessionId: "s1" });
    setBackendsForTests([fake.backend], "claude");
    const { ws } = socket();

    await send(ws, "Buy oat milk", { source: "voice-dictate" });
    await waitFor(() => fake.transcript.length === 2);

    const history = await replay("s1");
    // The join has something to match: the replay carries the message.
    expect(history.filter((message) => message.role === "user")).toHaveLength(1);
    expect(userSources(history)).toEqual(["voice-dictate"]);
  });

  test("identical texts replay with their own sources, in the order they were sent", async () => {
    const fake = transcriptBackend({ sessionId: "s1" });
    setBackendsForTests([fake.backend], "claude");
    const { ws } = socket();

    await send(ws, "yes", { source: "voice-dictate" });
    await waitFor(() => fake.transcript.length === 2);
    await send(ws, "yes", { sessionId: "s1", source: "typed" });
    await waitFor(() => fake.transcript.length === 4);
    await send(ws, "yes", { sessionId: "s1" });
    await waitFor(() => fake.transcript.length === 6);
    await send(ws, "yes", { sessionId: "s1", source: "voice-conversation" });
    await waitFor(() => fake.transcript.length === 8);

    expect(userSources(await replay("s1"))).toEqual([
      "voice-dictate",
      undefined,
      undefined,
      "voice-conversation",
    ]);
  });

  test("a follow-up queued behind a running turn is counted after that turn's prompt", async () => {
    const fake = transcriptBackend({ sessionId: "s1" });
    setBackendsForTests([fake.backend], "claude");
    const { ws } = socket();

    await send(ws, "yes");
    await waitFor(() => fake.transcript.length === 2);
    const release = fake.holdNextTurn();
    await send(ws, "yes", { sessionId: "s1" });
    await waitFor(() => fake.transcript.length === 3);
    // Queued: the session is still running its second turn.
    await send(ws, "yes", { sessionId: "s1", source: "voice-dictate" });
    release();
    await waitFor(() => fake.transcript.length === 6);

    expect(userSources(await replay("s1"))).toEqual([undefined, undefined, "voice-dictate"]);
  });

  test("a follow-up injected into a running turn is counted after that turn's prompt", async () => {
    const fake = transcriptBackend({ sessionId: "s1", followUp: true });
    setBackendsForTests([fake.backend], "claude");
    const { ws } = socket();

    await send(ws, "yes");
    await waitFor(() => fake.transcript.length === 2);
    const release = fake.holdNextTurn();
    await send(ws, "yes", { sessionId: "s1" });
    await waitFor(() => fake.transcript.length === 3);
    await send(ws, "yes", { sessionId: "s1", source: "voice-dictate" });
    await waitFor(() => fake.transcript.length === 4);
    release();
    await waitFor(() => fake.transcript.length === 5);

    expect(userSources(await replay("s1"))).toEqual([undefined, undefined, "voice-dictate"]);
  });

  test("the snapshot sent on connect to a running session carries the source", async () => {
    const fake = transcriptBackend({ sessionId: "s1" });
    setBackendsForTests([fake.backend], "claude");
    const { ws } = socket();
    const release = fake.holdNextTurn();
    await send(ws, "Remind me at six", { source: "voice-dictate" });
    await waitFor(() => fake.transcript.length === 1);

    const history = testHost().prepareHistory("s1", await fake.backend.getHistory("s1"));
    release();
    expect(userSources(history)).toEqual(["voice-dictate"]);
  });

  test("a client that sends no source replays exactly as before", async () => {
    const fake = transcriptBackend({ sessionId: "s1" });
    setBackendsForTests([fake.backend], "claude");
    const { ws } = socket();

    await send(ws, "hello");
    await waitFor(() => fake.transcript.length === 2);

    const history = await replay("s1");
    expect(history).toEqual([
      { role: "user", content: "hello", toolCalls: [] },
      { role: "assistant", content: "Noted.", toolCalls: [] },
    ]);
  });
});

describe("the message source store", () => {
  test("a replayed text the host never saw matches nothing and shifts nothing", () => {
    const db = getDb();
    saveMessageSource(db, "s1", "/skill:plan the week", "voice-dictate");
    saveMessageSource(db, "s1", "yes", "voice-dictate");
    const joined = attachMessageSources(db, "s1", [
      // What pi replays for a /skill: command: the expanded skill, not the text sent.
      { role: "user", content: '<skill name="plan">…</skill>\n\nthe week', toolCalls: [] },
      { role: "user", content: "yes", toolCalls: [] },
    ]);
    expect(joined.map((message) => message.source)).toEqual([undefined, "voice-dictate"]);
  });

  test("rows are scoped to their session", () => {
    const db = getDb();
    saveMessageSource(db, "s1", "yes", "voice-dictate");
    const joined = attachMessageSources(db, "s2", [{ role: "user", content: "yes", toolCalls: [] }]);
    expect(joined[0]!.source).toBeUndefined();
  });

  test("assistant messages with the same text are not counted or tagged", () => {
    const db = getDb();
    saveMessageSource(db, "s1", "yes", "typed");
    saveMessageSource(db, "s1", "yes", "voice-dictate");
    const joined = attachMessageSources(db, "s1", [
      { role: "assistant", content: "yes", toolCalls: [] },
      { role: "user", content: "yes", toolCalls: [] },
      { role: "user", content: "yes", toolCalls: [] },
    ]);
    expect(joined.map((message) => message.source)).toEqual([undefined, undefined, "voice-dictate"]);
  });

  test("a stored source this build does not know reads as typed", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO message_sources (session_id, text_hash, ordinal, source, created_at) VALUES (?, ?, 0, ?, 0)"
    ).run("s1", new Bun.CryptoHasher("sha256").update("hi").digest("hex"), "voice-telepathy");
    const joined = attachMessageSources(db, "s1", [{ role: "user", content: "hi", toolCalls: [] }]);
    expect(joined[0]).toEqual({ role: "user", content: "hi", toolCalls: [] });
  });
});
