import type { ChatAttachmentReference, ChatImageAttachment } from "@schlessera/brain-ui-sdk/protocol";
import type { AwaitableDraftStore } from "../drafts/store.js";
import type { MessageAttachment } from "./context.js";
import { readVerified } from "./files.js";
import { FILE_ID, toAttachmentFile } from "./store.js";

/**
 * Resolve a chat message's composer-original references against the host's
 * own records (#3153). The client supplies ids only: path, kind, size and
 * digest come from the record, and the bytes on disk must still match it.
 *
 * A message from a draft may name only files minted for that draft
 * (lineage) that its saved revision or outgoing snapshot still binds. A
 * retry, which has no draft, may name only files a message of its own session
 * already references. Anything else is refused; attaching a file grants no
 * path, ownership or execution authority.
 */
export async function resolveAttachmentRefs(
  brainRoot: string | undefined,
  store: Pick<AwaitableDraftStore, "attachments" | "attachmentRef" | "settled"> | undefined,
  refs: readonly ChatAttachmentReference[] | undefined,
  scope: { draftId?: string; sessionId?: string },
  images: readonly ChatImageAttachment[] = [],
): Promise<MessageAttachment[]> {
  const frameIds = images.flatMap((i) => i.fileId ? [i.fileId] : []);
  if (!refs?.length) {
    if (frameIds.length) throw Error("An image names an original the message does not attach.");
    return [];
  }
  if (!brainRoot || !store) throw Error("File attachments are unavailable on this host.");
  const ids = refs.map((r) => r.fileId);
  if (ids.some((id) => !FILE_ID.test(id)) || new Set(ids).size !== ids.length) throw Error("An attached file is listed twice or malformed.");
  // Read after every earlier save and acceptance on the write channel.
  await store.settled?.();
  const rows = store.attachments(ids);
  const result: MessageAttachment[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row || row.state !== "stored") throw Error("An attached file is no longer available. Attach it again.");
    const bound = scope.draftId
      ? row.draft_id === scope.draftId && (store.attachmentRef(id, "draft", scope.draftId) || store.attachmentRef(id, "outgoing", scope.draftId))
      : scope.sessionId !== undefined && store.attachmentRef(id, "message", scope.sessionId);
    if (!bound) throw Error("An attached file does not belong to this draft. Attach it again.");
    const read = await readVerified(brainRoot, row);
    if (!read.ok) throw Error(read.reason === "changed" ? "An attached original changed since it was stored. Attach it again." : "An attached original is missing. Attach it again.");
    result.push({ ...toAttachmentFile(row), ...(row.kind === "image" ? { inline: frameIds.includes(id) } : {}) });
  }
  for (const id of frameIds) {
    if (!result.some((f) => f.fileId === id && f.kind === "image")) throw Error("An image names an original the message does not attach.");
  }
  return result;
}
