/**
 * A turn the host itself stopped (#4565), live: the frames a real host
 * sends, through the real handlers, store and MessageBubble. The turn says
 * the host stopped it and why, not that it timed out; the tool it cut short
 * shows the host's stop, not the runtime's text that reads as the user
 * refusing the tool.
 */
import { registerHostStopDom, unregisterHostStopDom } from "./host-stop-dom.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as renderDom } from "@testing-library/react";
import { hostStopOutcomeDetail, type HostStopCause, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useStore } from "zustand";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider, useBrainUiRoot } from "../../src/root-context.js";

/** What the Claude runtime writes into a tool it interrupts. */
const RUNTIME_REFUSAL = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const scoped = { sessionId: "s1", turnId: "turn-ithaca" };

let root: BrainUiRoot;
afterEach(cleanup);
afterEach(() => root.dispose());
beforeAll(registerHostStopDom);
afterAll(unregisterHostStopDom);
beforeEach(() => {
  root = createBrainUiRoot({ storage: null });
  root.stores.chat.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {}, deliveries: {} });
});

function Live() {
  const r = useBrainUiRoot();
  const message = useStore(r.stores.chat, (s) => s.buffers.s1?.messages.findLast((m) => m.role === "assistant"));
  return message ? <MessageBubble message={message} onToolApproval={() => {}} onAskUserSubmit={() => {}} onAskUserListSubmit={() => {}} onAskUserCancel={() => {}} /> : null;
}

/** A turn with a running tool, ended the way the host ends a turn it stopped. */
function stopped(end: { detail: string; outcomeDetail?: string; hostStop?: HostStopCause; diagnostic?: string }) {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [{ role: "user", content: "Weave the shroud", toolCalls: [] }] } as ServerMessage);
  send({ type: "status", status: "thinking", ...scoped } as ServerMessage);
  send({ type: "text_delta", text: "Unravelling tonight's work. ", ...scoped } as ServerMessage);
  send({ type: "tool_use_start", toolUseId: "loom", toolName: "Bash", ...scoped } as ServerMessage);
  send({ type: "tool_use_complete", toolUseId: "loom", toolName: "Bash", input: { command: "unweave --shroud" }, ...scoped } as ServerMessage);
  const view = renderDom(<BrainUiProvider root={root}><Live /></BrainUiProvider>);
  // The failing owner's own error frame, which the host sends as it stops the turn.
  if (end.diagnostic) send({ type: "error", code: "AGENT_ERROR", message: end.diagnostic, ...scoped } as ServerMessage);
  send({ type: "tool_result", toolUseId: "loom", output: RUNTIME_REFUSAL, isError: true, ...(end.hostStop ? { hostStop: end.hostStop } : {}), ...scoped } as ServerMessage);
  send({ type: "status", status: "cancelled", detail: end.detail, ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", ...(end.outcomeDetail ? { outcomeDetail: end.outcomeDetail } : {}), durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  const message = root.stores.chat.getState().buffers.s1!.messages.findLast((m) => m.role === "assistant")!;
  return { view, tool: message.toolCalls.find((t) => t.id === "loom")! };
}

test("a host-stopped turn names the host and its cause, not a timeout", () => {
  const { view } = stopped({ detail: "Stopped by the host", outcomeDetail: hostStopOutcomeDetail("safety_recording"), hostStop: "safety_recording" });
  const notice = view.container.querySelector('[data-turn-notice="host_stop"]');
  expect(notice, "HOST_STOP_NOTICE_SHOWN").not.toBeNull();
  expect(notice!.textContent).toContain("Stopped by the host");
  expect(notice!.textContent, "HOST_STOP_NAMES_CAUSE").toContain("The host stopped this turn because it couldn't record the turn's safety checks. Try again. If it happens again, start a new chat or report it.");
  expect(view.container.querySelector('[data-turn-notice="timeout"]'), "HOST_STOP_NOT_TIMEOUT").toBeNull();
  expect(view.container.textContent).not.toContain("timed out");
  // Announced once, politely, like the timeout notice.
  expect(view.container.querySelector('[role="status"]')!.textContent).toContain("Stopped by the host.");
});

test("the tool a host stop cut short shows the host's stop, never the runtime's refusal text", () => {
  const { view, tool } = stopped({ detail: "Stopped by the host", outcomeDetail: hostStopOutcomeDetail("change_journal"), hostStop: "change_journal" });
  expect(tool, "TOOL_SHOWS_HOST_STOP").toMatchObject({ hostStop: "change_journal", isError: true });
  // Open the tool's details: what it shows is the host's account.
  const card = view.container.querySelector('[data-tool-call="loom"]')!;
  act(() => { fireEvent.click(card.querySelector("button")!); });
  expect(card.textContent, "OPENED_TOOL_NAMES_HOST_STOP")
    .toContain("The host stopped this turn before this tool finished, because it couldn't record the turn's changes. You didn't refuse it.");
  expect(view.container.textContent, "NO_REFUSAL_TEXT").not.toContain("doesn't want");
  expect(view.container.querySelector('[data-turn-notice="host_stop"]')!.textContent).toContain("Check any partial work before you continue.");
});

test("a host stop whose cause this client does not know still says the host stopped it", () => {
  const { view, tool } = stopped({ detail: "Stopped by the host", outcomeDetail: "host_stop:sirens" });
  expect(view.container.querySelector('[data-turn-notice="host_stop"]')!.textContent).toContain("The host stopped this turn. Try again.");
  // No host label on the tool: the runtime's text is all this client was told.
  expect(tool.output).toBe(RUNTIME_REFUSAL);
});

test("a timeout still reads as a timeout", () => {
  const { view } = stopped({ detail: "Turn timed out", outcomeDetail: "host_timeout" });
  expect(view.container.querySelector('[data-turn-notice="timeout"]')).not.toBeNull();
  expect(view.container.querySelector('[data-turn-notice="host_stop"]')).toBeNull();
});

test("a host stop that also raised its owner's error still says the host stopped the turn, and why", () => {
  const { view } = stopped({ detail: "Stopped by the host", outcomeDetail: hostStopOutcomeDetail("inbox_share"), hostStop: "inbox_share", diagnostic: "SQLITE_IOERR" });
  // The diagnostic stays, and the host's account joins it rather than being dropped.
  expect(view.container.textContent).toContain("SQLITE_IOERR");
  const notice = view.container.querySelector('[data-turn-notice="host_stop"]');
  expect(notice, "HOST_STOP_BESIDE_FAILURE").not.toBeNull();
  expect(notice!.textContent).toContain("The host stopped this turn because it couldn't link this chat's inbox shares. Try again.");
});

test("a tool the runtime never answered before the host stopped the turn shows the host's stop", () => {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [{ role: "user", content: "Weave the shroud", toolCalls: [] }] } as ServerMessage);
  send({ type: "status", status: "thinking", ...scoped } as ServerMessage);
  send({ type: "text_delta", text: "Unravelling tonight's work. ", ...scoped } as ServerMessage);
  send({ type: "tool_use_start", toolUseId: "loom", toolName: "Bash", ...scoped } as ServerMessage);
  send({ type: "tool_use_complete", toolUseId: "loom", toolName: "Bash", input: { command: "unweave --shroud" }, ...scoped } as ServerMessage);
  // The worker exits: no tool_result, only the host-stopped terminal.
  send({ type: "status", status: "cancelled", detail: "Stopped by the host", ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", outcomeDetail: hostStopOutcomeDetail("safety_recording"), durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  const tool = root.stores.chat.getState().buffers.s1!.messages.findLast((m) => m.role === "assistant")!.toolCalls.find((t) => t.id === "loom")!;
  expect(tool, "UNANSWERED_TOOL_SHOWS_HOST_STOP").toMatchObject({ hostStop: "safety_recording", isError: true,
    output: "The host stopped this turn before this tool finished, because it couldn't record the turn's safety checks. You didn't refuse it." });
});

test("a composer-opened reply's unanswered tool shows the host's stop, before any turn id reached it", () => {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [{ role: "user", content: "Weave the shroud", toolCalls: [] }] } as ServerMessage);
  // The composer opens the reply before the host names its turn.
  const chat = root.stores.chat.getState(), buffer = chat.buffers.s1!;
  root.stores.chat.setState({ buffers: { ...chat.buffers, s1: { ...buffer, isStreaming: true, messages: [...buffer.messages,
    { id: "reply", role: "assistant", content: "", toolCalls: [], parts: [], isStreaming: true, timestamp: Date.now() }] } } });
  send({ type: "tool_use_start", toolUseId: "loom", toolName: "Bash", ...scoped } as ServerMessage);
  send({ type: "tool_use_complete", toolUseId: "loom", toolName: "Bash", input: { command: "unweave --shroud" }, ...scoped } as ServerMessage);
  // The runtime's cancelled status ends streaming before its result arrives.
  send({ type: "status", status: "cancelled", detail: "Stopped by the host", ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", outcomeDetail: hostStopOutcomeDetail("inbox_share"), durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  const tool = root.stores.chat.getState().buffers.s1!.messages.find((m) => m.id === "reply")!.toolCalls.find((t) => t.id === "loom");
  expect(tool, "COMPOSER_REPLY_TOOL_SHOWS_HOST_STOP").toMatchObject({ hostStop: "inbox_share", isError: true });
});

test("a host stop before the new reply opens never labels an earlier answer's tools", () => {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  // An earlier, finished answer whose Read never reported a result.
  send({ type: "session_history", sessionId: "s1", messages: [
    { role: "user", content: "Read the log", toolCalls: [] },
    { role: "assistant", content: "Reading it.", toolCalls: [{ id: "read", name: "Read", input: { path: "log.md" } }] },
    { role: "user", content: "Weave the shroud", toolCalls: [] },
  ] } as ServerMessage);
  send({ type: "result", outcome: "cancelled", outcomeDetail: hostStopOutcomeDetail("inbox_share"), durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  const earlier = root.stores.chat.getState().buffers.s1!.messages.find((m) => m.role === "assistant" && m.content === "Reading it.")!;
  expect(earlier.toolCalls.find((t) => t.id === "read")?.hostStop, "EARLIER_ANSWER_UNTOUCHED").toBeUndefined();
  // The notice belongs to the request that failed, after it, not above it.
  const messages = root.stores.chat.getState().buffers.s1!.messages;
  expect(earlier.runtimeNotice, "EARLIER_ANSWER_HAS_NO_NOTICE").toBeUndefined();
  expect(messages.at(-1), "NOTICE_ON_A_REPLY_TO_THE_FAILED_REQUEST").toMatchObject({ role: "assistant", runtimeNotice: { cause: "host_stop", hostStop: "inbox_share" } });
});

test("a diagnostic before the new reply opens never claims an earlier answer for the stopped turn", () => {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [
    { role: "user", content: "Read the log", toolCalls: [] },
    { role: "assistant", content: "Reading it.", toolCalls: [{ id: "read", name: "Read", input: { path: "log.md" } }] },
    { role: "user", content: "Weave the shroud", toolCalls: [] },
  ] } as ServerMessage);
  // The journal's own error arrives first, then the host-stopped result.
  send({ type: "error", code: "JOURNAL_UNAVAILABLE", message: "The change journal became unavailable.", failure: { errorClass: "journal_unavailable", message: "The change journal became unavailable." }, ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", outcomeDetail: hostStopOutcomeDetail("change_journal"), durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  const messages = root.stores.chat.getState().buffers.s1!.messages;
  const earlier = messages.find((m) => m.role === "assistant" && m.content === "Reading it.")!;
  expect({ notice: earlier.runtimeNotice, failure: earlier.failure, tool: earlier.toolCalls[0]?.hostStop }, "EARLIER_ANSWER_NOT_CLAIMED")
    .toEqual({ notice: undefined, failure: undefined, tool: undefined });
  expect(messages.at(-1)).toMatchObject({ role: "assistant", runtimeNotice: { cause: "host_stop" } });
});

test("a turn split over two messages labels the unanswered tool in each", () => {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [{ role: "user", content: "Weave the shroud", toolCalls: [] }] } as ServerMessage);
  send({ type: "status", status: "thinking", ...scoped } as ServerMessage);
  send({ type: "text_delta", text: "Unravelling tonight's work. ", ...scoped } as ServerMessage);
  send({ type: "tool_use_start", toolUseId: "loom", toolName: "Bash", ...scoped } as ServerMessage);
  send({ type: "tool_use_complete", toolUseId: "loom", toolName: "Bash", input: { command: "unweave --shroud" }, ...scoped } as ServerMessage);
  // A diagnostic, then more text: the turn now spans two messages.
  send({ type: "error", code: "AGENT_ERROR", message: "SQLITE_IOERR", ...scoped } as ServerMessage);
  send({ type: "text_delta", text: "Still here.", ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", outcomeDetail: hostStopOutcomeDetail("inbox_share"), durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  const tool = root.stores.chat.getState().buffers.s1!.messages.flatMap((m) => m.toolCalls).find((t) => t.id === "loom");
  expect(tool?.hostStop, "SPLIT_TURN_TOOL_LABELLED").toBe("inbox_share");
});

test("a host-stop result without a turn id labels no earlier reply's tool", () => {
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [
    { role: "user", content: "Read the log", toolCalls: [] },
    { role: "assistant", content: "Reading it.", toolCalls: [{ id: "read", name: "Read", input: { path: "log.md" } }] },
  ] } as ServerMessage);
  send({ type: "result", sessionId: "s1", outcome: "cancelled", outcomeDetail: hostStopOutcomeDetail("inbox_share"), durationMs: 1, numTurns: 1, isError: false } as ServerMessage);
  const earlier = root.stores.chat.getState().buffers.s1!.messages.find((m) => m.content === "Reading it.")!;
  expect(earlier.toolCalls[0]?.hostStop, "UNSCOPED_RESULT_LABELS_NO_TOOL").toBeUndefined();
});
