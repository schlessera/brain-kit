/** Exact raw sends and card-only destructive Gmail preparation. */
import { GMAIL_LIMITS, type GmailTrashInput, type GoogleError } from "../catalog.js";
import { parseGmailRawDraft } from "../mime.js";
import type { GoogleCallFacts } from "../classify.js";
import { isGogPreRequestFailure } from "./errors.js";
import type { GogExecution } from "./transport.js";
import { gmailWriteReader, GooglePreparationError, type GmailWritePreparationContext } from "./reversible.js";

const fail = (code: GoogleError["code"], reason: string | null, message: string): never => { throw new GooglePreparationError({ code, reason, message }); };
const unknown = () => ({ ok: false as const, error: { code: "outcome_unknown" as const, reason: "write_unconfirmed", message: "The write may have happened; its response did not confirm the approved target." } });

async function readDraft(ctx: GmailWritePreparationContext, draftId: string) {
  const read = gmailWriteReader(ctx);
  const value = read.value(await ctx.transport.execute("gmail.draft.get", { draft_id: draftId }, read.execution));
  if (value.draft.id !== draftId || !value.raw) return fail("not_found", null, "No such Gmail thread, message or draft was found.");
  const raw = new Uint8Array(value.raw);
  const threadId = value.draft.message?.thread_id ?? null;
  let labels = value.draft.message?.label_ids ?? [];
  read.hidden(labels);
  if (ctx.hiddenLabels.length) {
    if (!threadId) return fail("not_found", null, "No such Gmail thread, message or draft was found.");
    const thread = await read.thread(threadId);
    if (!thread.messages.some(m => m.id === value.draft.message?.id)) return fail("not_found", null, "No such Gmail thread, message or draft was found.");
    labels = thread.messages.flatMap(m => m.label_ids);
  }
  return { raw, parsed: await parseGmailRawDraft(raw), threadId, labels, read };
}

export async function prepareGmailSend(ctx: GmailWritePreparationContext, draftId: string) {
  const { raw, parsed, threadId, labels, read } = await readDraft(ctx, draftId);
  if (!parsed.from || parsed.html_part || parsed.attachment || parsed.unreadable_headers || parsed.unreadable_body || parsed.body_text === null || parsed.body_text.length > GMAIL_LIMITS.draftBodyChars)
    return fail("draft_not_displayable", "draft_not_displayable", "The complete draft cannot be shown as plain text. Nothing was sent.");
  const { digest, bytes, from, to, cc, bcc, reply_to, subject, in_reply_to, references, body_text } = parsed;
  const payload = { draft_id: draftId, thread_id: threadId, send_as: from,
    message: { digest, bytes, from, to, cc, bcc, reply_to, subject, in_reply_to, references, body_text } };
  return { payload, sendLock: draftId, classificationFacts: {} as GoogleCallFacts,
    facts: { items: 1, target_label_ids: labels, recipients: [...to, ...cc, ...bcc].map(m => m.address), self_addresses: [ctx.accountIdentity] },
    send: (finalAdmission: NonNullable<GogExecution["finalAdmission"]>) => ctx.transport.execute("gmail.draft.send",
      { raw: new Uint8Array(raw), ...(threadId ? { thread_id: threadId } : {}) }, { ...read.execution, finalAdmission }),
    async deleteSentDraft(finalAdmission: NonNullable<GogExecution["finalAdmission"]>): Promise<boolean | null> {
      // Another client can edit the draft during the send. Never delete those new bytes.
      const current = await readDraft(ctx, draftId);
      if (current.parsed.digest !== digest || current.threadId !== threadId) return false;
      // A refused final admission spawns nothing: the draft was not deleted.
      let refused = false;
      const admit: typeof finalAdmission = () => { const denied = finalAdmission(); refused = denied !== null; return denied; };
      try {
        const answer = await ctx.transport.execute("gmail.draft.delete", { draft_id: draftId }, { ...read.execution, finalAdmission: admit });
        // gog retries a DELETE after a 5xx, so a final refusal can follow a
        // delete that happened. Only a refusal before any request proves it did not.
        if (!answer.ok) return refused || isGogPreRequestFailure(answer.error) ? false : null;
        return answer.value.draft_id === draftId ? true : null;
      } catch { return null; }
    } };
}

export async function prepareGmailDelete(ctx: GmailWritePreparationContext, draftId: string) {
  const { parsed, labels, read } = await readDraft(ctx, draftId);
  return { payload: { draft_id: draftId, digest: parsed.digest }, classificationFacts: {} as GoogleCallFacts,
    facts: { items: 1, target_label_ids: labels },
    async execute(finalAdmission: NonNullable<GogExecution["finalAdmission"]>) {
      const answer = await ctx.transport.execute("gmail.draft.delete", { draft_id: draftId }, { ...read.execution, finalAdmission });
      if (!answer.ok) return answer;
      return answer.value.draft_id === draftId ? { ok: true as const, result: { draft_id: draftId } } : unknown();
    } };
}

export async function prepareGmailTrash(ctx: GmailWritePreparationContext, input: GmailTrashInput) {
  const read = gmailWriteReader(ctx);
  // Pinned gog resolves exact IDs before lowercased names: uppercase TRASH
  // and INBOX cannot collide with user names (fetchLabelNameToID,
  // internal/cmd/gmail_labels.go:389-405; resolveLabelIDs,
  // internal/cmd/gmail_labels_utils.go:15-38, gog 44364d31).
  let ids = [...(input.message_ids ?? [])];
  if (input.thread_ids) {
    for (const id of input.thread_ids) {
      ids.push(...(await read.thread(id)).messages.map(m => m.id));
      ids = [...new Set(ids)];
      if (ids.length > GMAIL_LIMITS.idsPerCall) return fail("invalid_input", "items_per_call", "A trash can target at most 25 messages.");
    }
  }
  ids = [...new Set(ids)].sort();
  const labels: string[] = [];
  for (const id of ids) labels.push(...(await read.message(id)).message.label_ids);
  return { payload: { message_ids: ids }, classificationFacts: {} as GoogleCallFacts, facts: { items: ids.length, target_label_ids: labels },
    async execute(finalAdmission: NonNullable<GogExecution["finalAdmission"]>) {
      const answer = await ctx.transport.execute("gmail.trash", { message_ids: ids }, { ...read.execution, finalAdmission });
      if (!answer.ok) return answer;
      return answer.value.count === ids.length ? { ok: true as const, result: { message_ids: ids } } : unknown();
    } };
}
