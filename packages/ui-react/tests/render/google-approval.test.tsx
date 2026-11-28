import { registerGoogleApprovalDom, unregisterGoogleApprovalDom } from "./google-approval-dom.js";
registerGoogleApprovalDom();
import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { GOOGLE_MAIL_APPROVAL_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ToolPermissionCard } from "../../src/components/chat/tool-permission-card.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { activeChat, useChatStore } from "../../src/stores/chat-store.js";
import { replyToToolApproval } from "../../src/lib/tool-approval.js";
import { createConversationPermissions } from "../../src/voice/conversation-permissions.js";
import { GMAIL_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { googleApproval } from "../fixtures/google-approval.js";

const roots: BrainUiRoot[] = [];
afterEach(() => { cleanup(); for (const root of roots.splice(0)) root.dispose(); });
afterAll(unregisterGoogleApprovalDom);
function scene(input: Record<string, unknown> = googleApproval(), timeline = false, sessionId: string | null = null) {
  const root = createBrainUiRoot({ storage: null, request: async () => { throw new Error("No approval lookup"); } });
  roots.push(root);
  root.stores.ui.getState().setSingleKeyShortcuts(true);
  if (sessionId) root.stores.chat.getState().setActiveSession(sessionId);
  root.stores.chat.getState().requestToolApproval(sessionId, "google-card", "brain_google_gmail_modify", input, undefined, "google", false, "turn-ithaca");
  const sent: ClientMessage[] = [];
  root.connection.send = frame => { sent.push(frame); return true; };
  const decide = (id: string, approved: boolean, always?: boolean, forSession?: boolean) => replyToToolApproval(root, sessionId, root.connection.send, id, approved, always, forSession);
  function View() {
    const messages = useChatStore(s => activeChat(s).messages);
    const calls = messages.flatMap(m => m.toolCalls);
    return timeline ? <ToolCallTimeline live toolCalls={calls} onApproval={decide} /> : <ToolPermissionCard toolCall={calls[0]!} onApproval={decide} />;
  }
  const view = render(<BrainUiProvider root={root}><View /><textarea data-composer /></BrainUiProvider>);
  return { root, sent, view, decide, card: () => view.container.querySelector<HTMLElement>("[data-approval-card]")! };
}

test.each([false, true])("standing choice uses the exact offered flag, tainted=%s", tainted => {
  const input = googleApproval("gmail.modify", tainted);
  expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse(input).success).toBe(true);
  const s = scene(input);
  fireEvent.click(s.view.getByRole("button", { name: tainted ? /for this chat/ : /Always allow/ }));
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card", ...(tainted ? { forSession: true } : { always: true }) }]);
});

test.each(["gmail.draft.send", "gmail.draft.delete", "gmail.trash"] as const)("%s has no allow key or standing choice, but d denies", operation => {
  const s = scene(googleApproval(operation, true));
  expect(s.view.container.querySelector("[data-kit-approval-card]")).not.toBeNull();
  expect(s.view.queryByRole("button", { name: /Always allow|for this chat/ })).toBeNull();
  fireEvent.keyDown(s.card(), { key: "a" });
  expect(s.sent).toEqual([]);
  fireEvent.keyDown(s.card(), { key: "d" });
  expect(s.sent).toEqual([{ type: "tool_denial", toolUseId: "google-card", channel: "card", message: "Denied by user" }]);
});
test.each(["gmail.draft.send", "gmail.draft.delete", "gmail.trash"] as const)("%s allows once with neither standing flag", operation => {
  const s = scene(googleApproval(operation));
  const allow = s.view.container.querySelector<HTMLElement>("[data-kit-approval-actions] [role=button]")!;
  fireEvent.click(allow);
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});
test("a reversible card with no offer has no standing choice", () => {
  const input = googleApproval(); input.offers = { allow_always: false, allow_for_session: false };
  const s = scene(input);
  expect(s.view.container.textContent).toContain("Only your mailbox");
  expect(s.view.queryByRole("button", { name: /Always allow|for this chat/ })).toBeNull();
  act(() => { s.decide("google-card", true, true, true); });
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});
test.each(["double press", "key plus press"])("local answer-once guard: %s before the store settles", gesture => {
  const root = createBrainUiRoot({ storage: null }); roots.push(root); root.stores.ui.getState().setSingleKeyShortcuts(true);
  const replies: unknown[] = [];
  const tool = { id: "g", name: "brain_google_gmail_modify", status: "pending_approval" as const, approvalKind: "google" as const, input: googleApproval(), inputJson: "" };
  const view = render(<BrainUiProvider root={root}><ToolPermissionCard toolCall={tool} onApproval={(...args) => { replies.push(args); }} /></BrainUiProvider>);
  const card = view.container.querySelector<HTMLElement>("[data-approval-card]")!;
  const allow = view.container.querySelector<HTMLElement>("[data-kit-approval-actions] [role=button]")!;
  if (gesture === "double press") fireEvent.click(allow); else fireEvent.keyDown(card, { key: "a" });
  fireEvent.click(allow);
  expect(replies).toEqual([["g", true, undefined]]);
});
test("reversible a plus a press sends exactly one frame", () => {
  const s = scene(); const card = s.card();
  const allow = s.view.container.querySelector<HTMLElement>("[data-kit-approval-actions] [role=button]")!;
  fireEvent.keyDown(card, { key: "a" }); fireEvent.click(allow);
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
  expect(s.card()).toBeNull();
});
test("parse failure keeps raw input visible and answerable with no standing flag", () => {
  const s = scene({ operation: "gmail.modify", payload: { message_ids: ["invalid"] } });
  expect(s.view.container.textContent).toContain("invalid");
  expect(s.view.container.textContent).toContain("Approval needed");
  expect(s.view.queryByRole("button", { name: /Always allow|for this chat/ })).toBeNull();
  fireEvent.click(s.view.getByRole("button", { name: "Allow" }));
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});
test("parse failure has an unknown effect, so no single-key allow, but d denies", () => {
  const s = scene({ operation: "gmail.draft.send", payload: { message_ids: ["invalid"] } });
  expect(s.view.container.textContent).toContain("Approval needed");
  fireEvent.keyDown(s.card(), { key: "a" });
  expect(s.sent).toEqual([]);
  fireEvent.keyDown(s.card(), { key: "d" });
  expect(s.sent).toEqual([{ type: "tool_denial", toolUseId: "google-card", channel: "card", message: "Denied by user" }]);
});
test.each([
  ["answered", "answered on another device"], ["ended", "ended with the turn"], ["unlisted", ""], ["revoked", "no longer yours to answer"],
] as const)("restored Google card closes as %s with no live presentation", (closure, word) => {
  const s = scene(googleApproval(), true);
  expect(s.card()).not.toBeNull();
  act(() => {
    if (closure === "revoked") s.root.stores.chat.getState().revokeRestoredApprovals();
    else s.root.stores.chat.getState().closeRestoredApprovals(null, [{ toolUseId: "google-card", closure }]);
  });
  expect(s.view.container.textContent).toContain(word || "brain_google_gmail_modify");
  expect(s.view.container.querySelector("[data-kit-approval-card]")).toBeNull();
  expect(s.card()).toBeNull();
  expect(s.view.queryByRole("button", { name: /Always allow|for this chat|Archive|Deny/ })).toBeNull();
  expect(s.view.container.textContent).not.toContain("Approval needed");
  expect(s.decide("google-card", true, true)).toBe(false);
  expect(s.sent).toEqual([]);
});
test("a read-only Google card cannot render controls even outside the timeline", () => {
  const s = scene(); expect(s.card()).not.toBeNull();
  act(() => { s.root.stores.chat.getState().closeRestoredApprovals(null, [{ toolUseId: "google-card", closure: "ended" }]); });
  expect(s.card()).toBeNull();
  expect(s.sent).toEqual([]);
});
test.each([false, true])("dispatch rejects an unoffered or conflicting standing flag, tainted=%s", tainted => {
  const s = scene(googleApproval("gmail.modify", tainted));
  act(() => { s.decide("google-card", true, true, true); });
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});

test("voice denial followed by a stale card press sends exactly one denial", () => {
  const s = scene(googleApproval(), false, "ithaca");
  const voice = createConversationPermissions(s.root, s.root.connection.send,
    () => ({ active: true, sessionId: "ithaca", micOn: true, quiet: false, isolated: true }), () => {}, () => {});
  try {
    act(() => {
      voice.frame({ type: "tool_approval_request", sessionId: "ithaca", turnId: "turn-ithaca", toolUseId: "google-card", toolName: "brain_google_gmail_modify", kind: "google", input: googleApproval() });
      voice.input({ kind: "input_fragment", utteranceId: "refusal", sequence: 0, origin: "user", text: "brain, stop", finalization: "final", certainty: "known", confidence: 1 });
    });
    expect(s.decide("google-card", true, true)).toBe(false);
    expect(s.sent).toEqual([{ type: "tool_denial", toolUseId: "google-card", turnId: "turn-ithaca", channel: "voice", message: 'Heard “brain, stop”.' }]);
    expect(s.card()).toBeNull();
  } finally { voice.dispose(); }
});
test.each(["idle", "cancelled"] as const)("turn %s expires the Google card through the conversation receipt", status => {
  const s = scene(googleApproval(), true, "ithaca");
  const voice = createConversationPermissions(s.root, s.root.connection.send,
    () => ({ active: true, sessionId: "ithaca", micOn: true, quiet: false, isolated: true }), () => {}, () => {});
  try {
    act(() => {
      voice.frame({ type: "tool_approval_request", sessionId: "ithaca", turnId: "turn-ithaca", toolUseId: "google-card", toolName: "brain_google_gmail_modify", kind: "google", input: googleApproval() });
    });
    expect(s.card()).not.toBeNull();
    act(() => { voice.frame({ type: "status", sessionId: "ithaca", turnId: "turn-ithaca", status }); });
    expect(s.card()).toBeNull();
    expect(s.view.container.textContent).toContain(status === "cancelled" ? "Cancelled" : "Expired");
    expect(s.sent).toEqual([]);
  } finally { voice.dispose(); }
});
test("a host result withdraws the Google card, and late delivery cannot reopen a closed card", () => {
  const s = scene(googleApproval(), true);
  expect(s.card()).not.toBeNull();
  act(() => { s.root.stores.chat.getState().setToolResult(null, "google-card", "Approval expired", true); });
  expect(s.card()).toBeNull();
  act(() => {
    s.root.stores.chat.getState().closeRestoredApprovals(null, [{ toolUseId: "google-card", closure: "ended" }]);
    s.root.stores.chat.getState().requestToolApproval(null, "google-card", "brain_google_gmail_modify", googleApproval(), undefined, "google");
  });
  expect(s.view.container.textContent).toContain("ended with the turn");
  expect(s.card()).toBeNull();
  expect(s.sent).toEqual([]);
});
test("send-list refusal uses approved copy in the tool row without changing stored output", () => {
  const s = scene(googleApproval("gmail.draft.send"), true);
  const output = JSON.stringify({ ok: false, tool: GMAIL_TOOL_NAMES.send, error: { code: "policy_denied", reason: "recipient_not_allowed", message: "Host refusal" } });
  act(() => {
    s.root.stores.chat.getState().requestToolApproval(null, "google-card", GMAIL_TOOL_NAMES.send, googleApproval("gmail.draft.send"), undefined, "google");
    s.root.stores.chat.getState().setToolResult(null, "google-card", output, true);
  });
  // Completion collapses the details. Open the actual row to inspect its error.
  fireEvent.click(s.view.container.querySelector("button")!);
  expect(s.view.container.textContent).toContain("Not sent: one recipient isn't on your send list.");
  expect(activeChat(s.root.stores.chat.getState()).messages[0]!.toolCalls[0]!.output).toBe(output);
});
test("the send preview maps the full host payload and label ids stay unnamed", () => {
  const s = scene(googleApproval("gmail.draft.send", true));
  expect(s.view.container.textContent).toContain("penelope@ithaca.example");
  expect(s.view.container.textContent).toContain("*@ithaca.example");
  expect(s.view.container.textContent).toContain("ithaca");
  expect(s.view.container.textContent).toContain("The voyage home");
  expect(s.view.container.textContent).toContain("The crew is ready to sail.");
  expect(s.view.container.querySelector("[data-google-taint-banner]")).not.toBeNull();
  const m = scene();
  expect(m.view.container.textContent).toContain("Label_12");
});

test.each([false, true])("dispatch drops the other taint's standing flag, tainted=%s", tainted => {
  const s = scene(googleApproval("gmail.modify", tainted));
  act(() => { s.decide("google-card", true, tainted || undefined, !tainted || undefined); });
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});
test("a failed send leaves the card answerable for a later press", () => {
  const s = scene(); const allow = s.view.container.querySelector<HTMLElement>("[data-kit-approval-actions] [role=button]")!;
  s.root.connection.send = () => false;
  fireEvent.click(allow); expect(s.sent).toEqual([]); expect(s.card()).not.toBeNull();
  s.root.connection.send = frame => { s.sent.push(frame); return true; };
  fireEvent.click(allow);
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});
test.each(["gmail.modify", "gmail.draft.save"] as const)("reversible %s can deny with d", operation => {
  const s = scene(googleApproval(operation)); fireEvent.keyDown(s.card(), { key: "d" });
  expect(s.sent).toEqual([{ type: "tool_denial", toolUseId: "google-card", message: "Denied by user", channel: "card" }]);
});
test.each([[true, true], [false, true], [true, false]] as const)("keys print only with a fine pointer (%s) and setting (%s)", (fine, enabled) => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({
    matches: query === "(any-pointer: fine)" && fine, media: query, addEventListener() {}, removeEventListener() {},
  }) });
  try {
    const s = scene(); act(() => s.root.stores.ui.getState().setSingleKeyShortcuts(enabled));
    const actions = s.view.container.querySelector("[data-kit-approval-actions]")!;
    expect([...actions.querySelectorAll("[role=button]")].map(button => / [ad]$/.test(button.querySelector("span")?.textContent ?? ""))).toEqual([fine && enabled, fine && enabled]);
    if (!enabled) {
      fireEvent.keyDown(s.card(), { key: "a" }); expect(s.sent).toEqual([]);
      fireEvent.click(actions.querySelector<HTMLElement>("[role=button]")!);
    } else fireEvent.keyDown(s.card(), { key: "a" });
    expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
  } finally {
    cleanup();
    if (descriptor) Object.defineProperty(window, "matchMedia", descriptor); else Reflect.deleteProperty(window, "matchMedia");
  }
});

test.each([false, true])("dispatch drops an unoffered standing flag, tainted=%s", tainted => {
  const input = googleApproval("gmail.modify", tainted); input.offers = { allow_always: false, allow_for_session: false };
  const s = scene(input);
  act(() => { s.decide("google-card", true, !tainted || undefined, tainted || undefined); });
  expect(s.sent).toEqual([{ type: "tool_approval", toolUseId: "google-card", channel: "card" }]);
});

test("host tool_resolution withdraws a Google approval without needing its result", () => {
  const s = scene(googleApproval(), true, "ithaca");
  expect(s.card()).not.toBeNull();
  act(() => s.root.connection.handleServerMessage({ type: "tool_resolution", sessionId: "ithaca", turnId: "turn-ithaca", toolUseId: "google-card", outcome: "expired", channel: "card", reason: "turn_ended" }));
  expect(s.card()).toBeNull();
  expect(s.view.container.textContent).toContain("Expired");
  expect(s.decide("google-card", true)).toBe(false);
  expect(s.sent).toEqual([]);
});
