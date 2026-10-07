// Render test for a failed turn (#575). The frames go through the real client
// handler into the store, and the stored assistant message is rendered by the
// component the transcript uses, so a result the client ignored leaves an
// empty row and fails here. The same turn is then replayed from history and
// must read the same. Queries come from `render()`, never `screen` — see
// tests/render/dom.ts for why.
import { unregisterTurnFailureDom } from "./turn-failure-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  type ServerMessage,
  type SessionHistoryMessage,
  type TurnFailure,
} from "@schlessera/brain-ui-sdk/protocol";

import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { flushChatDeltas, handleServerMessage } from "../../src/hooks/use-websocket.js";
import { useChatStore } from "../../src/stores/chat-store.js";

afterEach(cleanup);
afterAll(unregisterTurnFailureDom);

beforeEach(() => {
  flushChatDeltas();
  useChatStore.setState({
    buffers: {},
    draft: null,
    pendingDraftId: null,
    activeSessionId: null,
    runStates: {},
  });
});

// Independent copy of the user-facing instructions: importing the implementation
// would let a changed instruction update both the output and its expectation.
const EXPECTED_AUTH_INSTRUCTIONS = {
  relogin:
    "The Claude subscription token was rejected. " +
    "Mint a new token with `claude setup-token` on a machine with a browser, put it in the host's secret store as " +
    "CLAUDE_CODE_OAUTH_TOKEN with today's date as BRAIN_UI_CLAUDE_TOKEN_MINTED_AT, and redeploy " +
    '(docs/hosting/README.md, "Claude subscription login").',
  check_account:
    "The Claude account itself was refused (organisation not allowed, account on hold, or billing). " +
    "A new token will not help: check the account at claude.ai, then send a turn to confirm.",
  check_config:
    "Claude Code was not set to run on the subscription, so the turn was refused before anything was sent. " +
    "Check that CLAUDE_CODE_OAUTH_TOKEN is set, and that no Claude settings on the host select another " +
    "credential or provider (apiKeyHelper, policyHelper, a stored API key, a third-party provider). The " +
    "refusal names which.",
} as const;

const noop = () => {};
const SESSION = "s1";
const UNSUPPORTED =
  "API Error: 400 Claude Code 2.1.270 does not support this model; version 2.1.280 or newer is required.";
const FAILURE: TurnFailure = { errorClass: "invalid_request", status: 400, message: UNSUPPORTED };

const frame = (msg: Record<string, unknown>) => handleServerMessage({ sessionId: SESSION, ...msg } as ServerMessage);

/** The user sends "Test": the composer adds the message and opens the assistant row, as it does. */
function send(text = "Test") {
  const chat = useChatStore.getState();
  chat.setMessages(SESSION, []);
  chat.setActiveSession(SESSION);
  chat.addUserMessage(SESSION, text);
  chat.startAssistantMessage(SESSION);
}

const messages = () => useChatStore.getState().buffers[SESSION]!.messages;
const assistant = () => messages().filter((m) => m.role === "assistant").at(-1)!;

function renderAssistant() {
  return render(
    <MessageBubble
      message={assistant()}
      onToolApproval={noop}
      onAskUserSubmit={noop}
      onAskUserCancel={noop}
      onAskUserListSubmit={noop}
    />
  );
}

/** The frames a backend sends for a turn that failed with no answer (#191). */
function failLive(failure: TurnFailure) {
  frame({ type: "session_info", isNew: false });
  frame({ type: "status", status: "thinking" });
  frame({ type: "status", status: "idle" });
  frame({ type: "result", outcome: "error", isError: true, durationMs: 800, numTurns: 1, failure });
  flushChatDeltas();
}

function replay(history: SessionHistoryMessage[]) {
  handleServerMessage({ type: "session_history", sessionId: SESSION, messages: history });
}

const failureText = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-turn-failure]")?.textContent ?? "";

describe("a failed turn is visible the moment it ends", () => {
  test("the empty assistant row shows the failure, with no reload", () => {
    send();
    failLive(FAILURE);
    expect(messages().map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(assistant().isStreaming).toBe(false);
    const view = renderAssistant();
    expect(view.getByRole("region", { name: "Turn failed" })).toBeTruthy();
    expect(failureText(view)).toContain("The provider rejected this request.");
    expect(view.container.textContent).not.toContain("Error:");
    expect(view.container.textContent).not.toContain("Thinking");
  });

  test("after a reload the same turn reads the same", () => {
    send();
    failLive(FAILURE);
    const liveView = renderAssistant();
    expect(liveView.getAllByRole("alert")).toHaveLength(1);
    const live = liveView.getByRole("region", { name: "Turn failed" }).textContent!.replace("Turn failed. The provider rejected this request.", "");
    cleanup();

    replay([
      { role: "user", content: "Test", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [], parts: [], failure: FAILURE },
    ]);
    expect(messages()).toHaveLength(2);
    const replayView = renderAssistant();
    expect(replayView.queryAllByRole("alert")).toHaveLength(0);
    const replayed = failureText(replayView);
    expect(live).toContain("The provider rejected this request.");
    expect(replayed).toBe(live);
  });

  test("a partial answer stays, and the failure follows it", () => {
    send();
    frame({ type: "text_delta", text: "Here is the start" });
    flushChatDeltas();
    frame({ type: "status", status: "idle" });
    frame({
      type: "result",
      outcome: "error",
      isError: true,
      durationMs: 1,
      numTurns: 1,
      failure: { errorClass: "server_error", status: 529, message: "API Error: Repeated 529 Overloaded errors." },
    });
    const view = renderAssistant();
    const text = view.container.textContent ?? "";
    expect(text).toContain("Here is the start");
    expect(text.indexOf("Here is the start")).toBeLessThan(text.indexOf("The provider failed to complete this request."));
  });

  test("a diagnostic error and the terminal failure show once", () => {
    send();
    frame({ type: "text_delta", text: "Partial" });
    flushChatDeltas();
    frame({ type: "error", code: "agent_error", message: "provider exploded" });
    frame({ type: "status", status: "idle" });
    frame({
      type: "result",
      outcome: "error",
      isError: true,
      durationMs: 1,
      numTurns: 1,
      failure: { errorClass: "unknown", message: "provider exploded" },
    });
    // Every assistant row the turn left, drawn: the failure appears once
    // across all of them, on the row that holds the partial answer.
    const drawn = messages()
      .filter((m) => m.role === "assistant")
      .map(
        (message) =>
          render(
            <MessageBubble
              message={message}
              onToolApproval={noop}
              onAskUserSubmit={noop}
              onAskUserCancel={noop}
              onAskUserListSubmit={noop}
            />
          ).container.textContent ?? ""
      )
      .join("\n");
    expect(drawn.split("provider exploded").length - 1).toBe(1);
    expect(drawn).toContain("Partial");
  });

  test("a failed turn whose frame names no failure still says it failed", () => {
    send();
    frame({ type: "status", status: "idle" });
    frame({ type: "result", outcome: "error", isError: true, durationMs: 1, numTurns: 0, outcomeDetail: "max_turns" });
    expect(failureText(renderAssistant())).toContain("The turn ended with an error (max_turns).");
  });

  test("a failure before the session existed opens its own row", () => {
    const chat = useChatStore.getState();
    chat.startDraftTurn();
    chat.addUserMessage(null, "Test");
    handleServerMessage({
      type: "error",
      code: "CLAUDE_AUTH",
      message: "refused",
      failure: { errorClass: "subscription_required", message: "refused", authAction: "check_config" },
    });
    const draft = useChatStore.getState().draft!;
    const failed = draft.messages.filter((m) => m.role === "assistant");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.failure?.authAction).toBe("check_config");
  });
});

describe("an auth failure says what to do, per the #254 split", () => {
  const cases = [
    ["relogin", "authentication_failed"],
    ["check_account", "billing_error"],
    ["check_config", "subscription_required"],
  ] as const;

  for (const [action, errorClass] of cases) {
    test(`${action}: its own instruction, live and replayed, and no other`, () => {
      send();
      failLive({ errorClass, message: "Failed to authenticate.", authAction: action });
      const liveView = renderAssistant();
      const live = failureText(liveView);
      const instruction = liveView.getByText(EXPECTED_AUTH_INSTRUCTIONS[action], { exact: true });
      expect(instruction).toBeTruthy();
      expect(live).toContain(EXPECTED_AUTH_INSTRUCTIONS[action].slice(0, 60));
      for (const [other] of cases) {
        if (other !== action) expect(live).not.toContain(EXPECTED_AUTH_INSTRUCTIONS[other].slice(0, 60));
      }
      cleanup();
      replay([
        { role: "user", content: "Test", toolCalls: [] },
        {
          role: "assistant",
          content: "",
          toolCalls: [],
          failure: { errorClass, message: "Failed to authenticate.", authAction: action },
        },
      ]);
      const replayView = renderAssistant();
      expect(replayView.getByText(EXPECTED_AUTH_INSTRUCTIONS[action], { exact: true })).toBeTruthy();
      expect(replayView.queryAllByRole("alert")).toHaveLength(0);
    });
  }
});

describe("a retry is visible while the turn is alive", () => {
  const retry = { attempt: 2, maxAttempts: 10, delayMs: 5000, errorClass: "rate_limit", status: 429 };

  test("the retry replaces the thinking dot, then hands over to the failure", () => {
    send();
    frame({ type: "status", status: "thinking", detail: "Retrying", retry });
    let view = renderAssistant();
    expect(view.container.textContent).toContain("Retrying (attempt 2 of 10) in 5s after rate_limit, HTTP 429");
    expect(view.container.textContent).not.toContain("Thinking...");
    cleanup();

    failLive({ errorClass: "rate_limit", status: 429, message: "API Error: 429 rate limited" });
    view = renderAssistant();
    expect(view.container.textContent).not.toContain("Retrying");
    expect(failureText(view)).toContain("The provider rate limited this request.");
  });

  test("an answer after the retry clears it", () => {
    send();
    frame({ type: "status", status: "thinking", retry });
    frame({ type: "text_delta", text: "Back." });
    flushChatDeltas();
    expect(assistant().retry).toBeUndefined();
    expect(renderAssistant().container.textContent).not.toContain("Retrying");
  });
});
