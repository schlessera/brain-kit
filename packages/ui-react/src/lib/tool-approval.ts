import type { ClientMessage, NetworkApprovalOffer, NetworkApprovalScope } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";
import { awaitsDecision, offersAlwaysAllow, type ToolCall } from "../stores/chat-store.js";

/** The four authorized choices on a tainted Network card (#3595), as each scope's Allow reads. */
export const NETWORK_SCOPE_ALLOW_LABELS: Readonly<Record<NetworkApprovalScope, string>> = {
  once: "Allow once", origin: "Allow this origin for this session", session: "Allow all origins for this session",
};
/** What a granted scope's receipt says. */
export const NETWORK_SCOPE_RECEIPTS: Readonly<Record<NetworkApprovalScope, string>> = {
  once: "Allowed once", origin: "Allowed this origin for this session", session: "Allowed all origins for this session",
};

/**
 * A tainted Network card's scope as the reply may carry it (#3595): only one
 * the card offered. A card that offers scopes always answers with one, the
 * narrowest when the caller named none, so no answer on it is the legacy
 * host-wide grant.
 */
export function offeredNetworkScope(tool: Pick<ToolCall, "approvalNetwork">, scope?: NetworkApprovalScope): NetworkApprovalScope | undefined {
  const offered = networkScopes(tool);
  if (!offered.length) return undefined;
  return scope && offered.includes(scope) ? scope : offered[0];
}

const SCOPE_ORDER: readonly NetworkApprovalScope[] = ["once", "origin", "session"];
/**
 * The scopes a card offers, narrowest first whatever order the frame lists
 * them in, so Allow and its key are always the narrowest one (#3595).
 */
export function networkScopes(tool: Pick<ToolCall, "approvalNetwork">): NetworkApprovalScope[] {
  const offered = tool.approvalNetwork?.scopes ?? [];
  return SCOPE_ORDER.filter(scope => offered.includes(scope));
}

/** The destination a Network card names, with its transport: an HTTP request and an opaque CONNECT tunnel are different origins. */
export function networkDestination(offer: NetworkApprovalOffer): string {
  const host = offer.host.includes(":") ? `[${offer.host}]` : offer.host;
  return `${offer.transport === "connect" ? "CONNECT tunnel to" : "HTTP to"} ${host}:${offer.port}`;
}

/** Existing card reply, guarded by the current shared request state. */
export function replyToToolApproval(root: BrainUiRoot, sessionId: string | null,
  send: (message: ClientMessage) => boolean, toolUseId: string, approved: boolean, always?: boolean, networkScope?: NetworkApprovalScope) {
  const chat = root.stores.chat.getState();
  const buffer = sessionId === null ? chat.draft : chat.buffers[sessionId];
  const pending = buffer?.messages.flatMap(message => message.toolCalls).find(tool => tool.id === toolUseId);
  if (!pending || !awaitsDecision(pending)) return false;
  const scope = approved ? offeredNetworkScope(pending, networkScope) : undefined;
  const sent = approved
    ? send({ type: "tool_approval", toolUseId, ...(always && offersAlwaysAllow(pending) ? { always: true } : {}), ...(scope ? { networkScope: scope } : {}), channel: "card" })
    : send({ type: "tool_denial", toolUseId, message: "Denied by user", channel: "card" });
  // Preserve main's refused-send recovery: only accepted dispatch settles locally.
  if (sent) chat.resolveToolApproval(sessionId, toolUseId, approved, scope);
  return sent;
}
