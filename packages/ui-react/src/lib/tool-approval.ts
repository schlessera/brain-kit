import { GOOGLE_MAIL_APPROVAL_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";
import { awaitsDecision, offersAlwaysAllow } from "../stores/chat-store.js";

/** Existing card reply, guarded by the current shared request state. */
export function replyToToolApproval(root: BrainUiRoot, sessionId: string | null,
  send: (message: ClientMessage) => boolean, toolUseId: string, approved: boolean, always?: boolean, forSession?: boolean) {
  const chat = root.stores.chat.getState();
  const buffer = sessionId === null ? chat.draft : chat.buffers[sessionId];
  const pending = buffer?.messages.flatMap(message => message.toolCalls).find(tool => tool.id === toolUseId);
  if (!pending || !awaitsDecision(pending)) return false;
  const google = pending.approvalKind === "google" ? GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse(pending.input) : null;
  // Revalidate at dispatch against the current request. Generic Google cards
  // and invalid, unoffered or conflicting standing choices grant only once.
  const standing = google?.success && google.data.effect === "reversible" && !(always && forSession)
    ? google.data.tainted
      ? forSession && google.data.offers.allow_for_session ? { forSession: true as const } : {}
      : always && google.data.offers.allow_always ? { always: true as const } : {}
    : {};
  const sent = approved
    ? send({ type: "tool_approval", toolUseId, ...(pending.approvalKind === "google" ? standing : always && offersAlwaysAllow(pending) ? { always: true } : {}), channel: "card" })
    : send({ type: "tool_denial", toolUseId, message: "Denied by user", channel: "card" });
  // Preserve main's refused-send recovery: only accepted dispatch settles locally.
  if (sent) chat.resolveToolApproval(sessionId, toolUseId, approved);
  return sent;
}
