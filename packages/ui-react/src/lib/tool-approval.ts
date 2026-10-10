import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";
import { awaitsDecision, offersAlwaysAllow } from "../stores/chat-store.js";

/** Existing card reply, guarded by the current shared request state. */
export function replyToToolApproval(root: BrainUiRoot, sessionId: string | null,
  send: (message: ClientMessage) => boolean, toolUseId: string, approved: boolean, always?: boolean) {
  const chat = root.stores.chat.getState();
  const buffer = sessionId === null ? chat.draft : chat.buffers[sessionId];
  const pending = buffer?.messages.flatMap(message => message.toolCalls).find(tool => tool.id === toolUseId);
  if (!pending || !awaitsDecision(pending)) return false;
  const sent = approved
    ? send({ type: "tool_approval", toolUseId, ...(always && offersAlwaysAllow(pending) ? { always: true } : {}), channel: "card" })
    : send({ type: "tool_denial", toolUseId, message: "Denied by user", channel: "card" });
  // Preserve main's refused-send recovery: only accepted dispatch settles locally.
  if (sent) chat.resolveToolApproval(sessionId, toolUseId, approved);
  return sent;
}
