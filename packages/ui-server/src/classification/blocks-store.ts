/**
 * Where classified blocks live between the turn and its replay (D42 §4).
 *
 * A text part is keyed by the session and a hash of its EXACT text: the
 * part arrives once as streamed deltas and again from the backend's
 * transcript on resume, both backends replay the text byte for byte, and
 * the stored spans are offsets into that exact text — a key that forgave
 * whitespace would let a differently laid-out part inherit spans that land
 * on unrelated prose. Two identical parts in one session share a
 * classification, which is the same text getting the same answer. The join
 * on replay rewrites each block's `partIndex` to the part's ordinal in the
 * replayed message.
 */

import type { Database } from "bun:sqlite";
import type { MessageBlock, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { messageBlockSchema } from "@schlessera/brain-ui-sdk/schemas";
import { rebaseMessageBlocks, rewriteLinkDestinationsWithEdits } from "@schlessera/brain-ui-sdk/internal/client";

/** The key one text part gets. Exported so the writer and the joiner agree by construction. */
export function partHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function saveMessageBlocks(
  db: Database,
  sessionId: string,
  partText: string,
  blocks: MessageBlock[]
): void {
  db.prepare(
    `INSERT INTO message_blocks (session_id, part_hash, blocks, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, part_hash) DO UPDATE SET blocks = excluded.blocks, created_at = excluded.created_at`
  ).run(sessionId, partHash(partText), JSON.stringify(blocks), Date.now());
}

export function loadMessageBlocks(db: Database, sessionId: string, partText: string): MessageBlock[] {
  const row = db
    .query("SELECT blocks FROM message_blocks WHERE session_id = ? AND part_hash = ?")
    .get(sessionId, partHash(partText)) as { blocks: string } | null;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.blocks) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Re-validated on the way out: a row written by a newer server with a
    // block kind this one cannot draw is dropped, not rendered blank.
    return parsed.flatMap((item) => {
      const result = messageBlockSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Keep the original join for other identical parts in the session, and save a
 * rebased join for this turn's promoted text. Always start from the streamed
 * text: a repeated promotion must not apply the same offset twice.
 */
export function rewriteMessageBlockLinks(
  db: Database,
  sessionId: string,
  textParts: readonly string[],
  links: ReadonlyMap<string, string>
): void {
  if (links.size === 0) return;
  db.transaction(() => {
    textParts.forEach((text, partIndex) => {
      const rewritten = rewriteLinkDestinationsWithEdits(text, link => links.get(link) ?? link);
      if (rewritten.text === text) return;
      const blocks = loadMessageBlocks(db, sessionId, text).map(block => ({ ...block, partIndex: 0 }));
      if (blocks.length === 0) return;
      const rebased = rebaseMessageBlocks(blocks, [rewritten.edits])
        .filter(block => block.start >= 0 && block.end <= rewritten.text.length)
        .map(block => ({ ...block, partIndex }));
      saveMessageBlocks(db, sessionId, rewritten.text, rebased);
    });
  })();
}

/** The text parts of a history message, in order, as the client will number them. */
export function textPartsOf(message: SessionHistoryMessage): string[] {
  if (message.parts) {
    return message.parts.filter((part) => part.kind === "text").map((part) => (part as { text: string }).text);
  }
  return message.content ? [message.content] : [];
}

/** Attach persisted blocks to replayed assistant messages. Messages without any are untouched. */
export function attachMessageBlocks(
  db: Database,
  sessionId: string,
  messages: SessionHistoryMessage[]
): SessionHistoryMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const blocks: MessageBlock[] = [];
    textPartsOf(message).forEach((text, partIndex) => {
      for (const block of loadMessageBlocks(db, sessionId, text)) {
        blocks.push({ ...block, partIndex });
      }
    });
    return blocks.length ? { ...message, blocks } : message;
  });
}
