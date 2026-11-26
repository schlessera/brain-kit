import { beforeEach, expect, test } from "bun:test";
import type { ClientMessage, NetworkApprovalOffer, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { activeChat, useChatStore } from "../src/stores/chat-store";
import { defaultRoot } from "../src/default-root";
import { replyToToolApproval } from "../src/lib/tool-approval";
import { approvalOutcome } from "../src/components/activity/approval-card";
import { effectOf } from "../src/components/chat/tool-views";
import { readApprovalDecision } from "../src/components/activity/span-bits";

// A tainted Network card's scopes in the client (#3595): the store keeps the
// host's offer through a re-delivery, both surfaces reply with an offered
// scope only, the narrowest when none is named, and receipts name the scope.

const SID = "odysseus-aeaea";
const { flushChatDeltas, handleServerMessage } = defaultRoot.connection;
const OFFER: NetworkApprovalOffer = { transport: "http", host: "aeaea.invalid", port: 8080, scopes: ["once", "origin", "session"] };
// The host's tainted-destination wording (`taintedDestinationDescription`, #3430).
const DESCRIPTION = "This session fetched a web page, so content you did not write may be steering it. Allow it to connect to aeaea.invalid:8080? "
  + "Allowing lets it send data to aeaea.invalid for the rest of this session without asking again.";

function card(network: NetworkApprovalOffer | null = OFFER) {
  handleServerMessage({ type: "tool_approval_request", sessionId: SID, turnId: "turn-aeaea", toolUseId: "net-aeaea", toolName: "Network", kind: "command",
    input: { host: "aeaea.invalid", port: 8080, method: "GET", target: "aeaea.invalid:8080" }, description: DESCRIPTION, ...(network ? { network } : {}) } as ServerMessage);
}
const tool = () => activeChat(useChatStore.getState()).messages.flatMap(message => message.toolCalls).find(call => call.id === "net-aeaea");
beforeEach(() => {
  flushChatDeltas();
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {} });
  useChatStore.getState().setActiveSession(SID);
});

test("the card keeps the host's offer, also when the host re-delivers it", () => {
  card();
  expect(tool()?.approvalNetwork, "STORE_KEEPS_NETWORK_OFFER").toEqual(OFFER);
  card();
  expect(activeChat(useChatStore.getState()).messages.flatMap(message => message.toolCalls)).toHaveLength(1);
  expect(tool()?.approvalNetwork, "REDELIVERY_KEEPS_NETWORK_OFFER").toEqual(OFFER);
});

for (const [asked, sent] of [[undefined, "once"], ["once", "once"], ["origin", "origin"], ["session", "session"]] as const)
  test(`the transcript reply for ${asked ?? "a bare Allow"} sends ${sent} and keeps it for the receipt`, () => {
    card();
    const replies: ClientMessage[] = [];
    expect(replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, "net-aeaea", true, undefined, asked)).toBe(true);
    expect(replies, "TRANSCRIPT_REPLY_CARRIES_SCOPE").toEqual([{ type: "tool_approval", toolUseId: "net-aeaea", networkScope: sent, channel: "card" }]);
    expect(tool()).toMatchObject({ status: "approved", approvalNetworkScope: sent });
  });

test("a card the host offered only once never replies wider, and a card without an offer replies as before", () => {
  card({ ...OFFER, scopes: ["once"] });
  const replies: ClientMessage[] = [];
  replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, "net-aeaea", true, undefined, "session");
  expect(replies[0], "UNOFFERED_SCOPE_NEVER_SENT").toMatchObject({ networkScope: "once" });
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {} });
  useChatStore.getState().setActiveSession(SID);
  card(null);
  replies.length = 0;
  replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, "net-aeaea", true, undefined, "session");
  expect(replies, "UNSCOPED_CARD_REPLIES_AS_BEFORE").toEqual([{ type: "tool_approval", toolUseId: "net-aeaea", channel: "card" }]);
});

test("the Actions card's outcome names the scope it sends", () => {
  card();
  expect(approvalOutcome(tool(), "net-aeaea", true, false, "origin"), "ACTIONS_RECEIPT_NAMES_SCOPE").toMatchObject({
    networkScope: "origin", receipt: { text: "Allowed this origin for this session" },
    frame: { type: "tool_approval", toolUseId: "net-aeaea", networkScope: "origin", channel: "card" } });
  expect(approvalOutcome(tool(), "net-aeaea", true).receipt.text, "ACTIONS_BARE_ALLOW_IS_ONCE").toBe("Allowed once");
  expect(approvalOutcome(tool(), "net-aeaea", false).frame).toEqual({ type: "tool_denial", toolUseId: "net-aeaea", message: "Denied by user", channel: "card" });
  expect(approvalOutcome(undefined, "net-aeaea", true, false, "session").frame, "VANISHED_CARD_OFFERS_NOTHING").toEqual({ type: "tool_approval", toolUseId: "net-aeaea", channel: "card" });
});

test("a scoped card drops the legacy session-wide sentence; an unscoped one keeps it", () => {
  card();
  expect(DESCRIPTION).toContain("for the rest of this session without asking again.");
  expect(effectOf(tool()!), "SCOPED_CARD_DROPS_LEGACY_SENTENCE").toBe("This session fetched a web page, so content you did not write may be steering it. Allow it to connect to aeaea.invalid:8080?");
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {} });
  useChatStore.getState().setActiveSession(SID);
  card(null);
  expect(effectOf(tool()!)).toBe(DESCRIPTION);
});

test("the recorded decision names its scope, and an unknown scope is not guessed", () => {
  expect(readApprovalDecision({ principalId: "odysseus", decision: "allow", requestKind: "command", channel: "card", networkScope: "origin" })?.text, "DECISION_TEXT_NAMES_SCOPE")
    .toBe("Allowed for this origin, this session on the card");
  expect(readApprovalDecision({ principalId: "odysseus", decision: "allow", requestKind: "command", networkScope: "forever" })).toBeNull();
});
