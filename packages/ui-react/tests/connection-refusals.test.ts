import { afterEach, expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";

const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); });

const SESSION = "ithaca-chat";
const PARTIAL = "The fleet is still crossing the harbour.";

function runningReply(turnId?: string) {
  const root = createBrainUiRoot({ storage: null });
  roots.push(root);
  const chat = root.stores.chat.getState();
  chat.setMessages(SESSION, []);
  chat.setActiveSession(SESSION);
  chat.addUserMessage(SESSION, "How is the crossing going?");
  chat.startAssistantMessage(SESSION, turnId);
  chat.appendText(SESSION, PARTIAL);
  chat.setRunState(SESSION, "streaming");
  const before = root.stores.chat.getState().buffers[SESSION];
  expect(before.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(before.messages[1].content).toBe(PARTIAL);
  expect(before.messages[1].isStreaming).toBe(true);
  return root;
}

for (const code of ["RATE_LIMITED", "PARSE_ERROR"] as const) {
  for (const turnId of ["active", undefined]) {
    test(`${code} preserves a non-empty ${turnId ? "identified" : "unidentified"} running reply`, () => {
      const root = runningReply(turnId);
      const before = root.stores.chat.getState().buffers[SESSION];
      root.connection.handleServerMessage({ type: "error", code, message: "Frame refused" });
      const after = root.stores.chat.getState().buffers[SESSION];
      // The identified-row case fails first on a fabricated second assistant;
      // the unidentified case catches incorrectly failing the existing row.
      expect(after.messages).toHaveLength(2);
      expect(after.messages).toEqual(before.messages);
      expect(after.messages[1].failure).toBeUndefined();
      expect(after.messages[1].isStreaming).toBe(true);
      expect(after.isStreaming).toBe(true);
      expect(root.stores.chat.getState().runStates[SESSION]).toBe("streaming");
      expect(root.stores.connection.getState().lastError).toMatchObject({ code, message: "Frame refused" });
      expect(root.stores.connection.getState().lastError!.at).toBeGreaterThan(0);
      root.connection.handleServerMessage({ type: "text_delta", sessionId: SESSION, turnId, text: " Still sailing." });
      root.connection.flushChatDeltas();
      expect(root.stores.chat.getState().buffers[SESSION].messages[1].content).toBe(PARTIAL + " Still sailing.");
    });
  }
}

test("a scoped backend failure ends its own running reply without another assistant", () => {
  const root = runningReply("active");
  const failure = { errorClass: "server_error", status: 500, message: "Provider unavailable" };
  root.connection.handleServerMessage({ type: "error", sessionId: SESSION, turnId: "active", code: "agent_error", message: failure.message, failure });
  const buffer = root.stores.chat.getState().buffers[SESSION];
  expect(buffer.messages).toHaveLength(2);
  expect(buffer.messages[1]).toMatchObject({ turnId: "active", content: PARTIAL, failure, failureLive: true, isStreaming: false });
  expect(buffer.isStreaming).toBe(false);
});

test("a turn-scoped refusal code still fails its own reply", () => {
  const root = runningReply("active");
  root.connection.handleServerMessage({ type: "error", sessionId: SESSION, turnId: "active", code: "RATE_LIMITED", message: "Turn failed" });
  const buffer = root.stores.chat.getState().buffers[SESSION];
  expect(buffer.messages).toHaveLength(2);
  expect(buffer.messages[1]).toMatchObject({ turnId: "active", isStreaming: false, failure: { message: "Turn failed" } });
});

test("a structured setup failure before session identity retains its recovery", () => {
  const root = createBrainUiRoot({ storage: null });
  roots.push(root);
  const chat = root.stores.chat.getState();
  chat.startDraftTurn();
  chat.addUserMessage(null, "How is the crossing going?");
  const failure = { errorClass: "subscription_required", message: "Check the subscription configuration", authAction: "check_config" as const };
  root.connection.handleServerMessage({ type: "error", code: "CLAUDE_AUTH", message: failure.message, failure });
  const draft = root.stores.chat.getState().draft!;
  expect(draft.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(draft.messages[1]).toMatchObject({ failure, failureLive: true, isStreaming: false });
  expect(draft.isStreaming).toBe(false);
});

test("a bare setup refusal still fails the pending draft reply", () => {
  const root = createBrainUiRoot({ storage: null });
  roots.push(root);
  const chat = root.stores.chat.getState();
  chat.startDraftTurn();
  chat.addUserMessage(null, "How is the crossing going?");
  chat.startAssistantMessage(null);
  root.connection.handleServerMessage({ type: "error", code: "SESSION_LIMIT", message: "Session limit reached" });
  const draft = root.stores.chat.getState().draft!;
  expect(draft.messages).toHaveLength(2);
  expect(draft.messages[1]).toMatchObject({ failure: { message: "Session limit reached" }, isStreaming: false });
  expect(draft.isStreaming).toBe(false);
});

test("a structured backend failure is authoritative even with a frame-refusal code", () => {
  const root = runningReply();
  const failure = { errorClass: "rate_limit", status: 429, message: "Provider rate limited" };
  root.connection.handleServerMessage({ type: "error", code: "RATE_LIMITED", message: failure.message, failure });
  const buffer = root.stores.chat.getState().buffers[SESSION];
  expect(buffer.messages).toHaveLength(2);
  expect(buffer.messages[1]).toMatchObject({ failure, isStreaming: false });
  expect(buffer.isStreaming).toBe(false);
});
