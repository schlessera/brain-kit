import type { ClientMessage, NetworkApprovalScope } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";
import { awaitsDecision, offersAlwaysAllow, type PendingNetworkApproval } from "../stores/chat-store.js";

/** Existing card reply, guarded by the current shared request state. */
export function replyToToolApproval(root: BrainUiRoot, sessionId: string | null,
  send: (message: ClientMessage) => boolean, toolUseId: string, approved: boolean, always?: boolean) {
  const chat = root.stores.chat.getState();
  const buffer = sessionId === null ? chat.draft : chat.buffers[sessionId];
  const pending = buffer?.messages.flatMap(message => message.toolCalls).find(tool => tool.id === toolUseId);
  if (!pending || !awaitsDecision(pending)) return false;
  const sent = approved
    ? send({
        type: "tool_approval",
        toolUseId,
        ...(always && offersAlwaysAllow(pending) ? { always: true } : {}),
        ...(pending.approvalRevision ? { revision: pending.approvalRevision } : {}),
        channel: "card",
      })
    : send({
        type: "tool_denial",
        toolUseId,
        message: "Denied by user",
        ...(pending.approvalRevision ? { revision: pending.approvalRevision } : {}),
        channel: "card",
      });
  // Preserve main's refused-send recovery: only accepted dispatch settles locally.
  if (sent) chat.resolveToolApproval(sessionId, toolUseId, approved);
  return sent;
}

/**
 * Host-owned network approval reply (#4967, #3595): echoes `revision` and
 * optional `networkScope`, marks the card `"sending"` (never optimistically
 * `"approved"`), and settles only when `tool_resolution` arrives from the host.
 */
export function replyToNetworkApproval(
  root: BrainUiRoot,
  sessionId: string | null,
  send: (message: ClientMessage) => boolean,
  item: Pick<PendingNetworkApproval, "toolUseId" | "turnId" | "revision" | "network" | "sending" | "readOnly">,
  decision: { approved: true; scope?: NetworkApprovalScope } | { approved: false; message?: string }
): boolean {
  if (item.sending || item.readOnly) return false;
  const chat = root.stores.chat.getState();
  const advertised = item.network?.scopes;
  let scope: NetworkApprovalScope | undefined;
  if (decision.approved && decision.scope !== undefined) {
    const valid =
      advertised !== undefined
      && advertised.includes(decision.scope)
      && !(item.network?.managedReference && decision.scope !== "once");
    if (!valid) return false;
    scope = decision.scope;
  }
  chat.markNetworkApprovalSending(sessionId, item.toolUseId, scope);
  const frame: ClientMessage = decision.approved
    ? {
        type: "tool_approval",
        toolUseId: item.toolUseId,
        ...(item.turnId ? { turnId: item.turnId } : {}),
        ...(item.revision ? { revision: item.revision } : {}),
        ...(scope ? { networkScope: scope } : {}),
        channel: "card",
      }
    : {
        type: "tool_denial",
        toolUseId: item.toolUseId,
        message: decision.message ?? "Denied by user",
        ...(item.turnId ? { turnId: item.turnId } : {}),
        ...(item.revision ? { revision: item.revision } : {}),
        channel: "card",
      };
  const sent = send(frame);
  if (!sent) {
    chat.resetNetworkApprovalSending(sessionId, item.toolUseId);
  }
  return sent;
}
