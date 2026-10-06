// A restored approval card the host no longer lists, and its turn shell's
// header time (#1072, D52 §4 R3), mounted. The frames and the recovery read
// go through one real root (its chat store, socket demux and tracker
// client); the shell it builds is rendered by the transcript's own
// `MessageBubble`. Queries come from `render()`, never `screen` — see
// tests/render/dom.ts for why.
import { unregisterRestoredApprovalDom } from "./restored-approval-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ClientMessage, ServerMessage, SessionRecovery, SessionRecoveryLatest, SessionRecoveryPending } from "@schlessera/brain-ui-sdk/protocol";

import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const r of roots.splice(0)) r.dispose();
});
afterAll(unregisterRestoredApprovalDom);

const A = "odysseus-sirens";
/** The host's clock when the turn started: hours before this page drew the shell. */
const STARTED_AT = Date.now() - (3 * 60 + 17) * 60_000;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function root(latest: Partial<SessionRecoveryLatest>, pending: SessionRecoveryPending[] = []) {
  const sent: ClientMessage[] = [];
  const body: SessionRecovery = {
    sessionId: A, backendId: "pi", revision: 2, pending,
    latest: { requestId: "req-2", turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null, ...latest },
  };
  const r = createBrainUiRoot({
    storage: null,
    request: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  });
  r.stores.connection.setState({ wsStatus: "connected" });
  const send = r.connection.send;
  r.connection.send = (msg) => { sent.push(msg); return send(msg); };
  roots.push(r);
  return Object.assign(r, { sent });
}

const frame = (r: BrainUiRoot, msg: Record<string, unknown>) => r.connection.handleServerMessage(msg as unknown as ServerMessage);
const settle = async () => { for (let i = 0; i < 3; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0))); };

/** A reload whose replay ends on the user's message, then the host's re-delivery. */
async function restore(r: BrainUiRoot) {
  frame(r, { type: "server_hello", protocolRev: 5, principalKey: "pk-ithaca", capabilities: { sessionRecovery: true } });
  r.stores.chat.getState().setActiveSession(A);
  frame(r, { type: "session_history", sessionId: A, messages: [{ role: "user", content: "Row past the Sirens", toolCalls: [] }] });
  frame(r, {
    type: "tool_approval_request", sessionId: A, turnId: "turn-2", toolUseId: "tool-wax", toolName: "Bash",
    input: { command: "seal --ears crew" }, description: "Seal the crew's ears with wax.", kind: "command",
  });
  await settle();
}

function mount(r: BrainUiRoot, decisions: unknown[]) {
  const shell = r.stores.chat.getState().buffers[A]!.messages.find((m) => m.turnShell);
  if (!shell) throw new Error("no turn shell was drawn");
  const view = render(
    <BrainUiProvider root={r}>
      <MessageBubble
        message={shell}
        onToolApproval={(...args) => { decisions.push(args); }}
        onAskUserSubmit={() => {}}
        onAskUserCancel={() => {}}
        onAskUserListSubmit={() => {}}
      />
    </BrainUiProvider>,
  );
  return { view, shell };
}

describe("a restored approval card the host no longer lists", () => {
  test("reads answered on another device, has no controls, and sends nothing", async () => {
    const r = root({ turnId: "turn-2", state: "running", startedAt: STARTED_AT });
    await restore(r);
    const decisions: unknown[] = [];
    const { view } = mount(r, decisions);
    const text = view.container.textContent ?? "";
    expect(text).toContain("restored");
    expect(text).toContain("answered on another device");
    expect(view.container.querySelector("[data-restored-closure]")?.getAttribute("data-restored-closure")).toBe("answered");
    expect(view.container.querySelector("[data-approval-card]")).toBeNull();
    expect(view.queryByRole("button", { name: /^(Allow|Deny|Always allow)/ })).toBeNull();
    // The single-key shortcuts have nowhere to land, and the entry itself answers nothing.
    for (const target of view.container.querySelectorAll("button, [tabindex]")) {
      fireEvent.keyDown(target, { key: "a" });
      fireEvent.keyDown(target, { key: "d" });
    }
    expect(decisions).toEqual([]);
    expect(r.sent.filter((m) => m.type === "tool_approval" || m.type === "tool_denial")).toEqual([]);
  });

  test("a card the envelope lists keeps its controls", async () => {
    const r = root({ turnId: "turn-2", state: "running", startedAt: STARTED_AT }, [{ kind: "approval", requestId: "tool-wax", turnId: "turn-2" }]);
    await restore(r);
    const { view } = mount(r, []);
    expect(view.getByRole("button", { name: /^Allow/ })).toBeTruthy();
    expect(view.container.querySelector("[data-restored-closure]")).toBeNull();
  });
});

describe("the turn shell's header time", () => {
  test("is the host's startedAt when the envelope's latest turn is the card's", async () => {
    const r = root({ turnId: "turn-2", state: "running", startedAt: STARTED_AT });
    await restore(r);
    const { view, shell } = mount(r, []);
    expect(view.container.querySelector("[data-turn-time]")?.textContent).toBe(clock(STARTED_AT));
    expect(clock(shell.timestamp)).not.toBe(clock(STARTED_AT));
  });

  test("is not printed when the envelope does not link the card's turn", async () => {
    const r = root({ requestId: "req-3", turnId: "turn-3", state: "running", startedAt: STARTED_AT });
    await restore(r);
    const { view } = mount(r, []);
    expect(view.container.querySelector("[data-turn-time]")).toBeNull();
    expect(view.container.textContent ?? "").toContain("ended with the turn");
  });
});
