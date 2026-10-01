import { trackContextText, withTrackFiles } from "../tracks/read.js";
import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
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
import type { MessageSource, SessionHistoryMessage, ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import { isThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import { sharedFileMetaSchema, messageSourceSchema } from "@schlessera/brain-ui-sdk/schemas";

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
  source: MessageSource,
  effort?: { thinkingLevel?: ThinkingLevel; turnId: string; files?: SharedFileMeta[] }
): void {
  const hash = messageTextHash(text);
  db.transaction(() => {
    const row = db
      .query("SELECT COUNT(*) AS n FROM message_sources WHERE session_id = ? AND text_hash = ?")
      .get(sessionId, hash) as { n: number };
    db.prepare(
      `INSERT INTO message_sources (session_id, text_hash, ordinal, source, created_at, thinking_level, turn_id, track_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, hash, row.n, source, Date.now(), effort?.thinkingLevel ?? null, effort?.turnId ?? null, effort?.files?.length ? JSON.stringify(effort.files) : null);
  }).immediate();
}

export function saveEffectiveThinkingLevel(db: Database, sessionId: string, turnId: string, level: ThinkingLevel): void {
  db.prepare("UPDATE message_sources SET effective_thinking_level = ? WHERE session_id = ? AND turn_id = ? AND thinking_level IS NOT NULL")
    .run(level, sessionId, turnId);
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
    .query("SELECT text_hash AS hash, ordinal, source, thinking_level, effective_thinking_level, track_files FROM message_sources WHERE session_id = ?")
    .all(sessionId) as Array<{ hash: string; ordinal: number; source: string; thinking_level: string | null; effective_thinking_level: string | null; track_files: string | null }>;
  const stored = new Map<string, Partial<SessionHistoryMessage>>();
  for (const row of rows) {
    // Re-validated on the way out: a row written by a newer server with a
    // source this one does not know reads as typed.
    const parsed = messageSourceSchema.safeParse(row.source);
    const metadata: Partial<SessionHistoryMessage> = {};
    if (parsed.success && parsed.data !== "typed") metadata.source = parsed.data;
    if (isThinkingLevel(row.thinking_level)) {
      metadata.thinkingLevel = row.thinking_level;
      if (isThinkingLevel(row.effective_thinking_level)) metadata.effectiveThinkingLevel = row.effective_thinking_level;
    }
    if (row.track_files) {
      try {
        const raw: unknown = JSON.parse(row.track_files);
        if (Array.isArray(raw) && raw.length > 0 && raw.length <= 10) {
          const parsedFiles = raw.map(f => sharedFileMetaSchema.safeParse(f));
          // Validation must not reorder JSON keys: replay compares the original
          // server context byte for byte before removing it from user text.
          if (parsedFiles.every(f => f.success && f.data.detected && f.data.summary)) metadata.files = raw as SharedFileMeta[];
        }
      } catch { /* Corrupt operational metadata cannot become a claimed attachment. */ }
    }
    if (Object.keys(metadata).length) stored.set(`${row.hash}:${row.ordinal}`, metadata);
  }
  if (stored.size === 0) return messages;

  const seen = new Map<string, number>();
  return messages.map((message) => {
    if (message.role !== "user") return message;
    let content = message.content;
    let hash = messageTextHash(content);
    let ordinal = seen.get(hash) ?? 0;
    let metadata = stored.get(`${hash}:${ordinal}`);
    if (!metadata) {
      const candidate = trackContextText(content);
      if (candidate !== null) {
        const candidateHash = messageTextHash(candidate);
        const candidateOrdinal = seen.get(candidateHash) ?? 0;
        const recorded = stored.get(`${candidateHash}:${candidateOrdinal}`);
        if (recorded?.files && withTrackFiles(candidate, recorded.files) === content) {
          content = candidate; hash = candidateHash; ordinal = candidateOrdinal; metadata = recorded;
        }
      }
    }
    seen.set(hash, ordinal + 1);
    return metadata ? { ...message, content, ...metadata } : message;
  });
}
