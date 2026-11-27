/** Concrete reversible Gmail factories; no policy or approval shortcuts. */
import { createGmailIrreversibleFactories } from "./irreversible.js";
import type { GoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import type { Database } from "bun:sqlite";
import { prepareGmailModify, prepareGmailDraft, GooglePreparationError, type GmailDraftProvenance } from "@schlessera/brain-common/internal/google-gog";
import { GOOGLE_APPROVAL_CARD_BYTES, GOOGLE_MAIL_APPROVAL_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { GoogleCredential } from "./credential.js";
import type { GoogleWriteFactories } from "./write-engine.js";

/** A missing/corrupt/unknown latest record cannot authorize a card-less update.
 * Records are scoped to this chat's owner and real account; deletion removes them. */
function gmailDraftProvenance(db: Database, sessionId: string, principalId: string, brainId: string, account: string, draftId: string): GmailDraftProvenance {
  try {
    const rows = db.query<{ state: string; inverse_json: string }, [string, string, string, string, number]>(`SELECT state,inverse_json FROM google_inverses
      WHERE session_id=? AND principal_id=? AND brain_id=? AND account_identity=? AND operation='gmail.draft.save' AND expires_at>?
      ORDER BY decision_event_id DESC`).all(sessionId, principalId, brainId, account, Date.now());
    for (const row of rows) {
      const inverse = JSON.parse(row.inverse_json);
      if (inverse.draft_id !== draftId && inverse.result?.id !== draftId) continue;
      return { createdByBrainKit: inverse.created_by_brain_kit === true,
        fingerprint: row.state === "confirmed" && /^[a-f0-9]{64}$/.test(inverse.result?.fingerprint ?? "") ? inverse.result.fingerprint : null };
    }
  } catch { /* Unreadable provenance escalates this update only. */ }
  return { createdByBrainKit: false, fingerprint: null };
}
export function createGmailWriteFactories(options: { db: Database; credential: Pick<GoogleCredential, "transport">; brainId: string; ledger?: () => GoogleLedger }): GoogleWriteFactories {
  const factory: NonNullable<GoogleWriteFactories["gmail.modify"]> = async (turn, call, accountIdentity) => {
    const policy = turn.policy()!;
    const opened = options.credential.transport(policy.account!);
    if (!opened.ok) throw new GooglePreparationError({ code: "unavailable", reason: opened.status.reason, message: opened.status.detail });
    const context = { transport: opened.transport, accountIdentity, hiddenLabels: policy.gmail.hidden_labels };
    const operation = call.tool === "brain_google_gmail_modify" ? "gmail.modify" : "gmail.draft.save";
    const prepared = call.tool === "brain_google_gmail_modify" ? await prepareGmailModify(context, call.input)
      : call.tool === "brain_google_gmail_draft" ? await prepareGmailDraft(context, call.input,
        call.input.draft_id ? gmailDraftProvenance(options.db, turn.sessionId()!, turn.principalId, options.brainId, accountIdentity, call.input.draft_id)
          : { createdByBrainKit: false, fingerprint: null }) : null;
    if (!prepared) throw new Error("Unexpected Gmail factory operation");
    const parsedCard = GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse({ operation, effect: "reversible", tainted: false, entities: [],
      offers: { allow_always: false, allow_for_session: false }, payload: prepared.payload });
    if (!parsedCard.success) throw new GooglePreparationError({ code: "draft_not_displayable", reason: "draft_not_displayable", message: "This change cannot be represented completely on an approval card." });
    const card = parsedCard.data;
    // Bound the whole eventual card, including entities the decision adds. A
    // draft is displayable even when current policy happens to admit it silently.
    if (new TextEncoder().encode(JSON.stringify({ ...card, entities: operation === "gmail.draft.save" ? ["drafts"] : [] })).length > GOOGLE_APPROVAL_CARD_BYTES)
      throw new GooglePreparationError({ code: "draft_not_displayable", reason: "card_too_large", message: "This change is too large to show completely on one approval card." });
    const at = Date.now();
    return { ...prepared, operation, input: call.input, card, inverse: { ...prepared.inverse, snapshot: prepared.inverse.snapshot ? new Uint8Array(prepared.inverse.snapshot) : null, createdAt: at, expiresAt: at + 604_800_000 } };
  };
  return { "gmail.modify": factory, "gmail.draft.save": factory, ...createGmailIrreversibleFactories(options) };
}
