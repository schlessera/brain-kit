/** Source-derived from gog 44364d31 (v0.48.1), never a live-account fixture:
 * internal/cmd/gmail_batch.go:130-137 and gmail_drafts.go:682-698.
 * Unknown envelope and message keys refuse. */
import { z } from "zod";
import { GMAIL_DRAFT_ID_PATTERN, GMAIL_MESSAGE_ID_PATTERN, GMAIL_THREAD_ID_PATTERN, isGmailLabelId } from "../ids.js";
import { GMAIL_LIMITS } from "../catalog.js";
import { GogShapeError } from "./codecs.js";

const messageId = z.string().regex(GMAIL_MESSAGE_ID_PATTERN);
const threadId = z.string().regex(GMAIL_THREAD_ID_PATTERN);
const labels = z.array(z.string().refine(isGmailLabelId)).max(GMAIL_LIMITS.labelChangesPerCall).nullable();
const modify = z.strictObject({ modified: z.array(messageId).min(1).max(GMAIL_LIMITS.idsPerCall), count: z.number().int(), addedLabels: labels, removedLabels: labels })
  .refine(v => v.count === v.modified.length && new Set(v.modified).size === v.count);
const draft = z.strictObject({
  draftId: z.string().regex(GMAIL_DRAFT_ID_PATTERN),
  message: z.strictObject({ id: messageId, threadId: threadId.optional(), labelIds: z.array(z.string().refine(isGmailLabelId)).optional() }),
  threadId: z.union([threadId, z.literal("")]),
  inReplyTo: z.string().max(GMAIL_LIMITS.headerChars).nullable(),
  references: z.string().max(GMAIL_LIMITS.headerChars).nullable(),
  replyContextSource: z.enum(["caller", "carried"]).nullable(),
});
export interface GogWriteResults {
  "gmail.modify": { message_ids: string[]; add_label_ids: string[]; remove_label_ids: string[] };
  "gmail.draft.save": { draft_id: string; message_id: string; thread_id: string | null };
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GogShapeError("$");
  return parsed.data;
}
export const GOG_WRITE_CODECS = {
  "gmail.modify": (value: unknown): GogWriteResults["gmail.modify"] => {
    const v = decode(modify, value);
    return { message_ids: v.modified, add_label_ids: v.addedLabels ?? [], remove_label_ids: v.removedLabels ?? [] };
  },
  "gmail.draft.save": (value: unknown): GogWriteResults["gmail.draft.save"] => {
    const v = decode(draft, value);
    if (v.message.threadId && v.threadId && v.message.threadId !== v.threadId) throw new GogShapeError("$.threadId");
    return { draft_id: v.draftId, message_id: v.message.id, thread_id: v.threadId || v.message.threadId || null };
  },
};
