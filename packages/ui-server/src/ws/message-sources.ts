/**
 * How each user message was produced, kept between the turn and its replay.
 *
 * The client says `typed`, `voice-dictate` or `voice-conversation` on
 * `chat_message`; neither backend's transcript has anywhere to put it, so
 * the host keeps it, the same way it keeps classified blocks
 * (`blocks-store.ts`). A message is keyed by its session, a hash of its
 * EXACT text, and its ordinal among identical texts in that session, because
 * two "yes" messages can differ in source and the text is all a replayed
 * message carries.
 *
 * The key is the text the backend REPLAYS, so it only holds where that is
 * the text the client sent. It is for both backends' attachment and
 * client-environment paths: Claude replays the text block verbatim and puts
 * the environment in the system prompt, and pi's history reader strips the
 * image notes pi appends to the stored text (`stripImageNotes`,
 * `packages/ui-backend-pi/src/history.ts:218-220`). It is not for a pi `/skill:` or
 * prompt-template command, which pi stores expanded: that message matches
 * no row and replays as `typed`. Its row is orphaned, and because every
 * message with the same text expands the same way, the orphan can only
 * shift ordinals among messages that would not have matched anyway.
 */

import type { Database } from "bun:sqlite";
import type { MessageSource, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { messageSourceSchema } from "@schlessera/brain-ui-sdk/schemas";

/** The key one message's text gets. Exported so the writer and the joiner agree by construction. */
export function messageTextHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Record one user message as it is handed to the backend, in the order the
 * backend will store it. Its ordinal is the number of messages with the same
 * text already recorded for the session.
 */
export function saveMessageSource(
  db: Database,
  sessionId: string,
  text: string,
  source: MessageSource
): void {
  const hash = messageTextHash(text);
  db.transaction(() => {
    const row = db
      .query("SELECT COUNT(*) AS n FROM message_sources WHERE session_id = ? AND text_hash = ?")
      .get(sessionId, hash) as { n: number };
    db.prepare(
      `INSERT INTO message_sources (session_id, text_hash, ordinal, source, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(sessionId, hash, row.n, source, Date.now());
  }).immediate();
}

/**
 * Attach the recorded source to replayed user messages. A message recorded as
 * `typed`, or not recorded at all, is returned untouched: absent means typed.
 */
export function attachMessageSources(
  db: Database,
  sessionId: string,
  messages: SessionHistoryMessage[]
): SessionHistoryMessage[] {
  const rows = db
    .query("SELECT text_hash AS hash, ordinal, source FROM message_sources WHERE session_id = ?")
    .all(sessionId) as Array<{ hash: string; ordinal: number; source: string }>;
  const stored = new Map<string, MessageSource>();
  for (const row of rows) {
    // Re-validated on the way out: a row written by a newer server with a
    // source this one does not know reads as typed.
    const parsed = messageSourceSchema.safeParse(row.source);
    if (parsed.success && parsed.data !== "typed") {
      stored.set(`${row.hash}:${row.ordinal}`, parsed.data);
    }
  }
  if (stored.size === 0) return messages;

  const seen = new Map<string, number>();
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const hash = messageTextHash(message.content);
    const ordinal = seen.get(hash) ?? 0;
    seen.set(hash, ordinal + 1);
    const source = stored.get(`${hash}:${ordinal}`);
    return source ? { ...message, source } : message;
  });
}
