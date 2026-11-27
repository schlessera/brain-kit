/** Card-only sends, draft deletion and trash. No standing grants or inverses. */
import { prepareGmailSend, prepareGmailDelete, prepareGmailTrash, GooglePreparationError, isGogPreRequestFailure } from "@schlessera/brain-common/internal/google-gog";
import { matchGoogleAllowList } from "@schlessera/brain-common/internal/google-operations";
import type { GoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import { GOOGLE_APPROVAL_CARD_BYTES, GOOGLE_MAIL_APPROVAL_SCHEMA, type GoogleMailApproval } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { GoogleCredential } from "./credential.js";
import type { GoogleWriteFactories } from "./write-engine.js";

const SEND_REFUSED_AFTER_RETRY = "Gmail refused this send, but gog retries a send after a server error, so an earlier attempt may have gone out. Check Gmail's Sent folder, or edit the draft to send new bytes. These bytes will not be sent again.";
/** A send whose bytes stay pending: it may have reached Google. */
export const SEND_MAY_HAVE_GONE = "This send may have gone out. Check Gmail's Sent folder, or edit the draft to send new bytes. These bytes will not be sent again.";

const storeError = () => new GooglePreparationError({ code: "unavailable", reason: "digest_store_unavailable", message: "Send replay protection is unavailable; nothing was sent." });
const replayError = (state: "pending" | "sent") => new GooglePreparationError(state === "sent"
  ? { code: "already_sent", reason: "digest_recorded", message: "These exact draft bytes have already been sent. They will not be sent again." }
  : { code: "outcome_unknown", reason: "digest_pending", message: "These exact draft bytes may already have been sent. Check Gmail’s Sent folder, or edit the draft to send new bytes. These bytes will not be sent again." });
function card(operation: GoogleMailApproval["operation"], payload: unknown) {
  const result = GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse({ operation, effect: "irreversible", tainted: false, entities: [],
    offers: { allow_always: false, allow_for_session: false }, payload });
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String) ?? [];
    const field = path.some(part => ["references", "in_reply_to", "thread_id"].includes(part)) ? "threading"
      : path.some(part => ["to", "cc", "bcc", "from", "send_as", "reply_to"].includes(part)) ? "mailbox"
      : path.includes("subject") ? "subject" : path.includes("body_text") ? "body" : "message";
    throw new GooglePreparationError({ code: "draft_not_displayable", reason: "card_schema", message: `The draft's ${field} fields cannot be represented on an approval card. Correct them and make a new request.` });
  }
  if (new TextEncoder().encode(JSON.stringify(result.data)).length > GOOGLE_APPROVAL_CARD_BYTES)
    throw new GooglePreparationError({ code: "draft_not_displayable", reason: "card_too_large", message: "This change cannot be shown completely on one approval card." });
  return result.data;
}
export function createGmailIrreversibleFactories(options: { credential: Pick<GoogleCredential, "transport">; ledger?: () => GoogleLedger }): GoogleWriteFactories {
  const factory: NonNullable<GoogleWriteFactories["gmail.draft.send"]> = async (turn, call, accountIdentity) => {
    const policy = turn.policy()!;
    const opened = options.credential.transport(policy.account!);
    if (!opened.ok) throw new GooglePreparationError({ code: "unavailable", reason: opened.status.reason, message: opened.status.detail });
    const context = { transport: opened.transport, accountIdentity, hiddenLabels: policy.gmail.hidden_labels };
    if (call.tool === "brain_google_gmail_trash") {
      const prepared = await prepareGmailTrash(context, call.input);
      return { ...prepared, operation: "gmail.trash", input: call.input, card: card("gmail.trash", prepared.payload) };
    }
    if (call.tool === "brain_google_gmail_draft" && call.input.action === "delete") {
      const prepared = await prepareGmailDelete(context, call.input.draft_id!);
      return { ...prepared, operation: "gmail.draft.delete", input: call.input, card: card("gmail.draft.delete", prepared.payload) };
    }
    if (call.tool !== "brain_google_gmail_send") throw new Error("Unexpected irreversible Gmail operation");
    const prepared = await prepareGmailSend(context, call.input.draft_id);
    const payload = { ...prepared.payload, account_alias: policy.account!,
      recipient_matches: (["to", "cc", "bcc"] as const).flatMap(field => matchGoogleAllowList(
        prepared.payload.message[field].map(m => m.address), policy.gmail.send_to, prepared.facts.self_addresses)
        .map(match => ({ field, address: match.input, entry: match.entry }))) };
    const digest = prepared.payload.message.digest;
    const ledger = () => { if (!options.ledger) throw storeError(); return options.ledger(); };
    let previous: "pending" | "sent" | null;
    try { previous = ledger().sentDigest(accountIdentity, digest); } catch { throw storeError(); }
    if (previous) throw replayError(previous);
    return { operation: "gmail.draft.send", input: call.input, facts: prepared.facts, classificationFacts: prepared.classificationFacts,
      card: card("gmail.draft.send", payload), sendLock: prepared.sendLock,
      async execute(finalAdmission, cleanupAdmission) {
        let reserved = false, notDispatched = false;
        const answer = await prepared.send(() => {
          const denied = finalAdmission();
          if (denied) return denied;
          // Synchronous and durable at the final spawn boundary. An ambiguous
          // dispatch retains pending forever; no retry can turn unknown clean.
          try {
            if (!ledger().reserveSentDigest(accountIdentity, digest, Date.now())) {
              notDispatched = true;
              return replayError(ledger().sentDigest(accountIdentity, digest) ?? "pending").error;
            }
            reserved = true;
          } catch { notDispatched = true; return storeError().error; }
          return null;
        });
        if (!answer.ok) {
          if (notDispatched) return { ...answer, notDispatched: true };
          if (reserved) {
            try { ledger().failSentDigest(accountIdentity, digest, `${answer.error.code}/${answer.error.reason}`); }
            catch { return { ok: false, error: { code: "outcome_unknown", reason: "digest_failure_recording_failed", message: "The send failure could not be recorded. Check Gmail's Sent folder, or edit the draft to send new bytes." } }; }
            // Only a failure proven pre-request releases these bytes, and keeps
            // its own answer. Anything else may follow a delivered attempt: a
            // final HTTP/auth refusal after gog retried internally, or a crash,
            // timeout or unreadable answer. Keep the bytes pending and say so.
            if (!isGogPreRequestFailure(answer.error)) {
              const refused = (answer.error.code === "unavailable" && answer.error.reason === "auth_required") ||
                ["not_found", "forbidden", "rate_limited"].includes(answer.error.code);
              return { ok: false, error: { code: "outcome_unknown", reason: answer.error.reason ?? answer.error.code,
                message: refused ? SEND_REFUSED_AFTER_RETRY : SEND_MAY_HAVE_GONE } };
            }
          }
          return answer;
        }
        // Pending already blocks replay, including a crash or failure here.
        try { ledger().confirmSentDigest(accountIdentity, digest); }
        catch { return { ok: false, error: { code: "outcome_unknown", reason: "digest_confirmation_failed", message: "Google confirmed the send, but its receipt could not be finalized. These bytes will not be resent." } }; }
        let deleted: boolean | null = false;
        try { deleted = await prepared.deleteSentDraft(cleanupAdmission); } catch { /* A confirmed send never becomes retryable on cleanup failure. */ }
        return { ok: true, result: { draft_id: call.input.draft_id, ...answer.value, draft_deleted: deleted } };
      } };
  };
  return { "gmail.draft.send": factory, "gmail.draft.delete": factory, "gmail.trash": factory };
}
