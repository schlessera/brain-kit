import type { GoogleMailApproval } from "@schlessera/brain-ui-sdk/tool-contracts";

const mailbox = (local: string) => ({ address: `${local}@ithaca.example`, local, domain: "ithaca.example", display_name: null });
const message = {
  digest: "a".repeat(64), bytes: 240, from: mailbox("odysseus"), to: [mailbox("penelope")], cc: [], bcc: [], reply_to: [],
  subject: "The voyage home", in_reply_to: [], references: [], body_text: "Penelope,\n\nThe crew is ready to sail.\nOdysseus",
};
export function googleApproval(operation: GoogleMailApproval["operation"] = "gmail.modify", tainted = false): GoogleMailApproval {
  const base = { tainted, entities: [], offers: { allow_always: false, allow_for_session: false } };
  switch (operation) {
    case "gmail.draft.send": return { ...base, operation, effect: "irreversible", payload: { draft_id: "r123", thread_id: null, send_as: message.from, message, account_alias: "ithaca", recipient_matches: [{ field: "to", address: "penelope@ithaca.example", entry: "*@ithaca.example" }] } };
    case "gmail.draft.delete": return { ...base, operation, effect: "irreversible", payload: { draft_id: "r123", digest: message.digest } };
    case "gmail.trash": return { ...base, operation, effect: "irreversible", payload: { message_ids: ["18abc123"] } };
    case "gmail.draft.save": return { ...base, operation, effect: "reversible", offers: { allow_always: !tainted, allow_for_session: tainted }, payload: { action: "create", draft_id: null, thread_id: null, message } };
    case "gmail.modify": return { ...base, operation, effect: "reversible", offers: { allow_always: !tainted, allow_for_session: tainted }, payload: { message_ids: ["18abc123"], add_label_ids: ["Label_12"], remove_label_ids: ["INBOX"] } };
  }
}
