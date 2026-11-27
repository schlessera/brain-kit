/** Source-derived from gog 44364d31 (v0.48.1), never a live-account fixture:
 * internal/cmd/gmail_batch.go:130-137, gmail_drafts.go:259-262 and :682-698,
 * gmail_archive.go:243-248, gmail_send.go:259-293 and gmail_compose.go:282-290.
 * Unknown envelope and message keys refuse. */
import { z } from "zod";
import { GMAIL_DRAFT_ID_PATTERN, GMAIL_MESSAGE_ID_PATTERN, GMAIL_THREAD_ID_PATTERN, isGmailLabelId } from "../ids.js";
import { GMAIL_LIMITS } from "../catalog.js";
import { GogShapeError } from "./codecs.js";

/** gog echoes the whole written In-Reply-To/References: up to the 100 ids an
 * approval card holds, each at most one header long, separated by spaces. */
export const GOG_THREADING_HEADER_CHARS = 100 * (GMAIL_LIMITS.headerChars + 1);
const messageId = z.string().regex(GMAIL_MESSAGE_ID_PATTERN);
const threadId = z.string().regex(GMAIL_THREAD_ID_PATTERN);
const labels = z.array(z.string().refine(isGmailLabelId)).max(GMAIL_LIMITS.labelChangesPerCall).nullable();
const modify = z.strictObject({ modified: z.array(messageId).min(1).max(GMAIL_LIMITS.idsPerCall), count: z.number().int(), addedLabels: labels, removedLabels: labels })
  .refine(v => v.count === v.modified.length && new Set(v.modified).size === v.count);
const draft = z.strictObject({
  draftId: z.string().regex(GMAIL_DRAFT_ID_PATTERN),
  message: z.strictObject({ id: messageId, threadId: threadId.optional(), labelIds: z.array(z.string().refine(isGmailLabelId)).optional() }),
  threadId: z.union([threadId, z.literal("")]),
  inReplyTo: z.string().max(GOG_THREADING_HEADER_CHARS).nullable(),
  references: z.string().max(GOG_THREADING_HEADER_CHARS).nullable(),
  replyContextSource: z.enum(["caller", "carried"]).nullable(),
});
const send = z.strictObject({ messageId, threadId: z.union([threadId, z.literal("")]), from: z.string().min(1).max(GMAIL_LIMITS.headerChars) });
const deleted = z.strictObject({ deleted: z.literal(true), draftId: z.string().regex(GMAIL_DRAFT_ID_PATTERN) });
const trash = z.strictObject({ action: z.literal("trashed"), count: z.number().int().min(1).max(GMAIL_LIMITS.idsPerCall),
  addedLabels: z.tuple([z.literal("TRASH")]), removedLabels: z.tuple([z.literal("INBOX")]) });
export interface GogWriteResults {
  "gmail.draft.send": { message_id: string; thread_id: string | null };
  "gmail.draft.delete": { draft_id: string };
  "gmail.trash": { count: number };
  "gmail.modify": { message_ids: string[]; add_label_ids: string[]; remove_label_ids: string[] };
  "gmail.draft.save": { draft_id: string; message_id: string; thread_id: string | null };
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GogShapeError("$");
  return parsed.data;
}
export const GOG_WRITE_CODECS = {
  "gmail.draft.send": (value: unknown): GogWriteResults["gmail.draft.send"] => {
    const v = decode(send, value);
    return { message_id: v.messageId, thread_id: v.threadId || null };
  },
  "gmail.draft.delete": (value: unknown): GogWriteResults["gmail.draft.delete"] => ({ draft_id: decode(deleted, value).draftId }),
  "gmail.trash": (value: unknown): GogWriteResults["gmail.trash"] => ({ count: decode(trash, value).count }),
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
