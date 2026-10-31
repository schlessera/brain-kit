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
 * client-environment paths: Both backends replay the user's original text through host-owned message
 * provenance; current host facts are new tail content. Pi's history reader strips the
 * image notes pi appends to the stored text (`stripImageNotes`,
 * `packages/ui-backend-pi/src/history.ts:254-256`). It is not for a pi `/skill:` or
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
  effort?: { thinkingLevel?: ThinkingLevel; turnId: string; files?: SharedFileMeta[] },
  at = Date.now()
): void {
  const hash = messageTextHash(text);
  db.transaction(() => {
    const row = db
      .query("SELECT COUNT(*) AS n FROM message_sources WHERE session_id = ? AND text_hash = ?")
      .get(sessionId, hash) as { n: number };
    db.prepare(
      `INSERT INTO message_sources (session_id, text_hash, ordinal, source, created_at, thinking_level, turn_id, track_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, hash, row.n, source, at, effort?.thinkingLevel ?? null, effort?.turnId ?? null, effort?.files?.length ? JSON.stringify(effort.files) : null);
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
  messages: SessionHistoryMessage[],
  strict = false,
  latestTurnId?: string,
): SessionHistoryMessage[] {
  if (strict) return attachLiveSources(db,sessionId,messages,latestTurnId);
  const rows = db
    .query("SELECT text_hash AS hash, ordinal, source, thinking_level, effective_thinking_level, track_files FROM message_sources WHERE session_id = ?")
    .all(sessionId) as Array<{ hash: string; ordinal: number; source: string; thinking_level: string | null; effective_thinking_level: string | null; track_files: string | null }>;
  const stored = new Map<string, Partial<SessionHistoryMessage>>();
  const decode = (row: typeof rows[number]): Partial<SessionHistoryMessage> => {
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
    return metadata;
  };
  for (const row of rows) {
    const metadata = decode(row);
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

/** Positive provenance for live DATA. Unknown users remain unclassified.
 * Full native duplicate counts prevent a failed write shifting every ordinal.
 * Only bounded candidate rows reach JS; aggregates use the existing indexes.
 */
function attachLiveSources(db: Database, sessionId: string, messages: SessionHistoryMessage[], latestTurnId?: string): SessionHistoryMessage[] {
  const counts = new Map<string,number>();
  const identities = messages.map((m,i)=> {
    if(m.role!=="user") return undefined;
    const texts=[m.content],candidate=trackContextText(m.content);
    if(candidate!==null && candidate!==m.content)texts.push(candidate);
    const keys=texts.map(text=>{const hash=messageTextHash(text),ordinal=counts.get(hash)??0;counts.set(hash,ordinal+1);return {hash,ordinal,text};});
    // Never cross another user to infer this one's turn: it may have failed.
    let turnId: string | undefined;
    for(let j=i+1;j<messages.length;j++) {
      if(messages[j]!.role==="user") break;
      if(messages[j]!.role==="assistant") {turnId=messages[j]!.turnId;break;}
    }
    if(i===messages.length-1)turnId=latestTurnId;
    return {keys,turnId};
  });
  type Row={source:string;turn_id:string|null;track_files:string|null};
  const count=db.query("SELECT COUNT(*) AS n FROM message_sources WHERE session_id=? AND text_hash=?");
  const ordinalRow=db.query("SELECT source,turn_id,track_files FROM message_sources WHERE session_id=? AND text_hash=? AND ordinal=?");
  const turnCount=db.query("SELECT COUNT(*) AS n FROM message_sources WHERE session_id=? AND turn_id=? AND text_hash=?");
  const turnRow=db.query("SELECT source,turn_id,track_files FROM message_sources WHERE session_id=? AND turn_id=? AND text_hash=? ORDER BY ordinal LIMIT 1 OFFSET ?");
  return messages.map((m,i)=>{
    const id=identities[i];if(!id||i<messages.length-128)return m;
    const {source:_source,turnId:_turnId,...unknown}=m;
    for(const key of id.keys) {
      let row=ordinalRow.get(sessionId,key.hash,key.ordinal) as Row|null;
      const n=(count.get(sessionId,key.hash) as {n:number}).n;
      if(id.turnId) {
        // Exact native/active-turn identity survives a missing earlier row.
        const matching=identities.filter(x=>x?.keys.some(k=>k.hash===key.hash)&&x.turnId===id.turnId);
        const stored=(turnCount.get(sessionId,id.turnId,key.hash) as {n:number}).n;
        if(stored===matching.length) row=turnRow.get(sessionId,id.turnId,key.hash,matching.indexOf(id)) as Row|null;
        else if((row?.turn_id && row.turn_id!==id.turnId) || n!==counts.get(key.hash)) row=null;
      } else if(n!==counts.get(key.hash))row=null;
      const parsed=messageSourceSchema.safeParse(row?.source);
      if(!parsed.success || !["typed","voice-dictate","voice-conversation","voice-context"].includes(parsed.data))continue;
      if(key.text!==m.content) {
        let files: unknown;try{files=JSON.parse(row?.track_files ?? "null");}catch{continue;}
        if(!Array.isArray(files)||!files.length||files.length>10||!files.every(f=>sharedFileMetaSchema.safeParse(f).success)||withTrackFiles(key.text,files)!==m.content)continue;
      }
      return {...unknown,content:key.text,source:parsed.data,...(id.turnId && row?.turn_id===id.turnId?{turnId:id.turnId}:{})};
    }
    return unknown;
  });
}
