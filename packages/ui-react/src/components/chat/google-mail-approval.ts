import { parseToolPayload, visibleToolName, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { GOOGLE_SEND_RECIPIENT_REFUSAL } from "@schlessera/brain-ui-kit";
import { GMAIL_SEND_CONTRACT, GMAIL_TOOL_NAMES, GOOGLE_RESULT_SCHEMAS, type GoogleMailApproval } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { GoogleMailApprovalCardProps, GoogleMailMessage } from "@schlessera/brain-ui-kit";

type Message = Extract<GoogleMailApproval, { operation: "gmail.draft.send" }>["payload"]["message"];
const mailbox = (m: Message["from"]) => ({ address: m.address, displayName: m.display_name });
const mail = (m: Message): GoogleMailMessage => ({
  from: mailbox(m.from), to: m.to.map(mailbox), cc: m.cc.map(mailbox), bcc: m.bcc.map(mailbox), replyTo: m.reply_to.map(mailbox),
  subject: m.subject, inReplyTo: m.in_reply_to, body: m.body_text,
});

/** The host's exact payload, with no lookups or invented mail metadata. */
export function googleMailApprovalProps(card: GoogleMailApproval): GoogleMailApprovalCardProps {
  const shared = { tainted: card.tainted };
  const offers = { allowAlways: card.offers.allow_always, allowForSession: card.offers.allow_for_session };
  // Chat has no account-scoped label cache. An id remains an id.
  const label = (id: string) => ({ id, name: null });
  switch (card.operation) {
    case "gmail.draft.send": return { ...shared, operation: card.operation, effect: card.effect,
      sendAs: mailbox(card.payload.send_as), accountAlias: card.payload.account_alias, recipientMatches: card.payload.recipient_matches,
      message: mail(card.payload.message), threadId: card.payload.thread_id };
    case "gmail.draft.save": return { ...shared, operation: card.operation, effect: card.effect, offers,
      action: card.payload.action, draftId: card.payload.draft_id, threadId: card.payload.thread_id, message: mail(card.payload.message) };
    case "gmail.draft.delete": return { ...shared, operation: card.operation, effect: card.effect, draftId: card.payload.draft_id };
    case "gmail.trash": return { ...shared, operation: card.operation, effect: card.effect, messages: card.payload.message_ids.map(messageId => ({ messageId })) };
    case "gmail.modify": return { ...shared, operation: card.operation, effect: card.effect, offers,
      messages: card.payload.message_ids.map(messageId => ({ messageId })), addLabels: card.payload.add_label_ids.map(label), removeLabels: card.payload.remove_label_ids.map(label) };
  }
}

const SEND_RESULT = { ...GMAIL_SEND_CONTRACT, payload: GOOGLE_RESULT_SCHEMAS[GMAIL_TOOL_NAMES.send] };
/** Display-only copy from an existing refusal code; never changes stored output. */
export function googleSendRefusal(tool: ToolCallView): string | null {
  if (![visibleToolName(GMAIL_TOOL_NAMES.send, "pi"), visibleToolName(GMAIL_TOOL_NAMES.send, "claude")].includes(tool.name)) return null;
  const result = parseToolPayload(SEND_RESULT, tool.output);
  return result && !result.ok && result.tool === GMAIL_TOOL_NAMES.send && result.error.code === "policy_denied" && result.error.reason === "recipient_not_allowed"
    ? GOOGLE_SEND_RECIPIENT_REFUSAL : null;
}
