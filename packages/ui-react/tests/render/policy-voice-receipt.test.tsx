/**
 * A policy card's own receipt outranks a voice-permission receipt (#4629).
 *
 * The voice permission router records a receipt for every approval request
 * and closes it at the turn's end ("Expired · denied"), or from the host's
 * `tool_resolution` ("Denied on screen"). Once the reply carries the turn
 * (#4565 stamps it for a tool-only reply, a text delta always did), that
 * receipt reaches the policy card's tool. The card has its own host-recorded
 * outcome, read from the policy proposal: that is what it says. A voice
 * receipt only speaks for a card nobody answered.
 *
 * Real frames, through the real connection, voice router, store and card.
 */
import { registerPolicyVoiceDom, unregisterPolicyVoiceDom } from "./policy-voice-receipt-dom.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as renderDom } from "@testing-library/react";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { useStore } from "zustand";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider, useBrainUiRoot } from "../../src/root-context.js";

const scoped = { sessionId: "s1", turnId: "turn-ithaca" };
const REQUEST = "proposal-ithaca";
const PENDING: PolicyChangeReview = {
  requestId: REQUEST, turnId: scoped.turnId, path: "context/policies/governance.md", state: "pending",
  rationale: "Keep the crew from the cattle of the sun.", baseHash: null, proposedHash: "a".repeat(64),
  frontmatterDiff: "+profiles.interactive: strict", bodyChanged: false, bodyDiff: "", sections: ["profiles.interactive"],
  message: "Policy change proposed. Review before approving.", warnings: [],
};
const DECLINED: PolicyChangeReview = { ...PENDING, state: "declined", message: "Policy change declined. Nothing was written." };

let root: BrainUiRoot;
/** What the host's receipt route answers; the card reads it on mount. */
let served: PolicyChangeReview = PENDING;
afterEach(cleanup);
afterEach(() => root.dispose());
beforeAll(registerPolicyVoiceDom);
afterAll(unregisterPolicyVoiceDom);
beforeEach(() => {
  served = PENDING;
  root = createBrainUiRoot({ storage: null, request: async (url) => {
    if (!String(url).includes("/policy-proposals/")) throw new Error(`Unexpected request ${String(url)}`);
    return new Response(JSON.stringify(served), { status: 200, headers: { "content-type": "application/json" } });
  } });
  root.stores.chat.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {}, deliveries: {} });
});

function Live() {
  const r = useBrainUiRoot();
  const message = useStore(r.stores.chat, (s) => s.buffers.s1?.messages.findLast((m) => m.role === "assistant"));
  // The transcript slot the chat draws a policy card in, as the layout proof renders it.
  return message ? <ToolCallTimeline live toolCalls={message.toolCalls} onApproval={() => true} /> : null;
}

const send = (frame: Record<string, unknown>) => act(() => { root.connection.handleServerMessage({ ...scoped, ...frame } as ServerMessage); });
async function settle() { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

/** A turn that proposes a policy change, drawn with its card ready to answer. */
async function proposed(withText: boolean) {
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", messages: [{ role: "user", content: "Tighten the policy before Thrinacia", toolCalls: [] }] });
  send({ type: "status", status: "thinking" });
  if (withText) send({ type: "text_delta", text: "Proposing a stricter policy. " });
  send({ type: "tool_use_start", toolUseId: REQUEST, toolName: "mcp__brain-ui__propose_policy_change" });
  send({ type: "tool_approval_request", toolUseId: REQUEST, toolName: "mcp__brain-ui__propose_policy_change",
    input: { content: "---\nprofiles:\n  interactive: strict\n---\n", rationale: PENDING.rationale, policyReview: PENDING }, kind: "policy", description: PENDING.message });
  const view = renderDom(<BrainUiProvider root={root}><Live /></BrainUiProvider>);
  await settle();
  const decline = [...view.container.querySelectorAll<HTMLElement>('[data-kit-approval-actions] [role="button"]')].find((b) => b.textContent?.includes("Decline"));
  if (!decline) throw new Error(`No Decline on the policy card: ${view.container.textContent}`);
  return { view, decline };
}

const tool = () => root.stores.chat.getState().buffers.s1!.messages.findLast((m) => m.role === "assistant")!.toolCalls.find((t) => t.id === REQUEST)!;
const receiptText = (view: ReturnType<typeof renderDom>) => view.container.querySelector("[data-policy-receipt] [role=status]")?.textContent ?? "";

/** Decline on the card; the host records it and the turn ends. */
async function declineAndEnd(decline: HTMLElement, resolution: boolean) {
  act(() => { fireEvent.click(decline); });
  // A connection that declared toolResolution (the shipped client does) hears the host settle the request.
  if (resolution) send({ type: "tool_resolution", toolUseId: REQUEST, outcome: "denied", channel: "card" });
  served = DECLINED;
  send({ type: "tool_result", toolUseId: REQUEST, output: JSON.stringify(DECLINED), isError: false, policyChange: DECLINED });
  send({ type: "result", durationMs: 1, numTurns: 1, isError: false });
  await settle();
}

test("a declined tool-only proposal keeps its own receipt when the turn's end expires the voice receipt", async () => {
  const { view, decline } = await proposed(false);
  await declineAndEnd(decline, false);
  // The precondition the incident needs: the expired voice receipt reached this tool.
  expect(tool().voicePermission?.phase, "EXPIRED_RECEIPT_ATTACHED").toBe("expired");
  expect(receiptText(view), "CARD_OUTCOME_OVER_EXPIRED_RECEIPT").toBe(DECLINED.message);
  expect(view.container.textContent).not.toContain("Expired · denied");
});

test("a declined proposal after text keeps its own receipt over the host's on-screen resolution", async () => {
  const { view, decline } = await proposed(true);
  await declineAndEnd(decline, true);
  expect(tool().voicePermission?.phase, "DENIED_RECEIPT_ATTACHED").toBe("denied");
  expect(receiptText(view), "CARD_OUTCOME_OVER_SCREEN_RECEIPT").toBe(DECLINED.message);
  expect(view.container.textContent).not.toContain("Denied on screen");
});

test("an unanswered proposal still shows the voice receipt that closed it and offers no decision", async () => {
  const { view } = await proposed(false);
  send({ type: "result", durationMs: 1, numTurns: 1, isError: false });
  await settle();
  expect(tool().voicePermission?.phase).toBe("expired");
  expect(receiptText(view), "UNANSWERED_CARD_SHOWS_VOICE_RECEIPT").toBe("Expired · denied · no answer before the turn ended");
  expect(view.container.querySelector("[data-kit-approval-actions]"), "UNANSWERED_CARD_LOCKED").toBeNull();
});
