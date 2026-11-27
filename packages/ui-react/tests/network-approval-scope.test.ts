import { beforeEach, expect, test } from "bun:test";
import type { ClientMessage, NetworkApprovalOffer, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { activeChat, useChatStore } from "../src/stores/chat-store";
import { defaultRoot } from "../src/default-root";
import { networkDestination, networkScopes, replyToToolApproval } from "../src/lib/tool-approval";
import { approvalOutcome } from "../src/components/activity/approval-card";
import { effectOf } from "../src/components/chat/tool-views";

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
  handleServerMessage({ type: "tool_approval_request", sessionId: SID, turnId: "turn-aeaea", toolUseId: TOOL, toolName: "Network", kind: "command",
    input: { host: "aeaea.invalid", port: 8080, method: "GET", target: "aeaea.invalid:8080" }, description: DESCRIPTION, ...(network ? { network } : {}) } as ServerMessage);
}
const tool = () => activeChat(useChatStore.getState()).messages.flatMap(message => message.toolCalls).find(call => call.id === TOOL);
// A fresh card id per test: the shared connection remembers the host's
// outcomes, so an id one test settled must never reach another, or a rerun.
let TOOL = "net-aeaea";
beforeEach(() => {
  TOOL = `net-aeaea-${crypto.randomUUID()}`;
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
    expect(replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, TOOL, true, undefined, asked)).toBe(true);
    expect(replies, "TRANSCRIPT_REPLY_CARRIES_SCOPE").toEqual([{ type: "tool_approval", toolUseId: TOOL, networkScope: sent, channel: "card" }]);
    expect(tool()).toMatchObject({ status: "approved", approvalNetworkScope: sent });
  });

test("a card the host offered only once never replies wider, and a card without an offer replies as before", () => {
  card({ ...OFFER, scopes: ["once"] });
  const replies: ClientMessage[] = [];
  replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, TOOL, true, undefined, "session");
  expect(replies[0], "UNOFFERED_SCOPE_NEVER_SENT").toMatchObject({ networkScope: "once" });
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {} });
  useChatStore.getState().setActiveSession(SID);
  card(null);
  replies.length = 0;
  replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, TOOL, true, undefined, "session");
  expect(replies, "UNSCOPED_CARD_REPLIES_AS_BEFORE").toEqual([{ type: "tool_approval", toolUseId: TOOL, channel: "card" }]);
});

test("the Actions card's outcome names the scope it sends", () => {
  card();
  expect(approvalOutcome(tool(), TOOL, true, false, "origin"), "ACTIONS_RECEIPT_NAMES_SCOPE").toMatchObject({
    networkScope: "origin", receipt: { text: "Allowed this origin for this session" },
    frame: { type: "tool_approval", toolUseId: TOOL, networkScope: "origin", channel: "card" } });
  expect(approvalOutcome(tool(), TOOL, true).receipt.text, "ACTIONS_BARE_ALLOW_IS_ONCE").toBe("Allowed once");
  expect(approvalOutcome(tool(), TOOL, false).frame).toEqual({ type: "tool_denial", toolUseId: TOOL, message: "Denied by user", channel: "card" });
  expect(approvalOutcome(undefined, TOOL, true, false, "session").frame, "VANISHED_CARD_OFFERS_NOTHING").toEqual({ type: "tool_approval", toolUseId: TOOL, channel: "card" });
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

test("a frame listing wider scopes first still makes Allow the narrowest", () => {
  card({ ...OFFER, scopes: ["session", "origin", "once"] });
  const replies: ClientMessage[] = [];
  replyToToolApproval(defaultRoot, SID, message => { replies.push(message); return true; }, TOOL, true);
  expect(replies[0], "BARE_ALLOW_IS_NARROWEST_WHATEVER_THE_ORDER").toMatchObject({ networkScope: "once" });
  expect(networkScopes(tool()!)).toEqual(["once", "origin", "session"]);
  expect(approvalOutcome(tool(), TOOL, true).receipt.text).toBe("Allowed once");
});

test("the Actions card names the transport, so HTTP and CONNECT origins read differently", () => {
  expect(networkDestination(OFFER), "HTTP_DESTINATION_NAMED").toBe("HTTP to aeaea.invalid:8080");
  expect(networkDestination({ ...OFFER, transport: "connect", port: 443 }), "CONNECT_DESTINATION_NAMED").toBe("CONNECT tunnel to aeaea.invalid:443");
});

test("the host's granted scope lands on the card, also when another client answered", () => {
  card();
  handleServerMessage({ type: "tool_resolution", sessionId: SID, turnId: "turn-aeaea", toolUseId: TOOL, outcome: "granted", networkScope: "origin" } as ServerMessage);
  expect(tool()?.approvalNetworkScope, "HOST_SCOPE_REACHES_THE_TRANSCRIPT").toBe("origin");
  handleServerMessage({ type: "tool_resolution", sessionId: SID, turnId: "turn-aeaea", toolUseId: TOOL, outcome: "expired" } as ServerMessage);
  expect(tool()?.approvalNetworkScope).toBe("origin");
});
