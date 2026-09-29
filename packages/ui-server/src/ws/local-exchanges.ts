/**
 * Commands the client answered itself, kept as part of the session (#582).
 *
 * `/stats` is answered by the client from REST, not by a turn, so neither
 * backend's transcript ever sees it. The host keeps each exchange beside the
 * session, the way it keeps message sources (`message-sources.ts`) and
 * classified blocks (`blocks-store.ts`), and does two things with it:
 *
 * - **Context.** The next prompt handed to the backend in that session
 *   carries the exchange's `context` in a `<local-answer>` block appended to
 *   the user's text. The agent sees the figures, and from then on they are
 *   in the backend's own transcript like anything else the user said.
 * - **Replay.** `prepareHistory` strips that block from the user message
 *   that carried it and puts the exchange back in front of it, as the
 *   `prompt` user message and an assistant message carrying `localAnswer`.
 *   An exchange no prompt has carried yet replays at the end.
 *
 * The block is appended, not prepended, so a prompt that is a backend
 * command (`/skill:…`) still starts with it. A block is only stripped when
 * its id names an exchange recorded for the session, so a user who types
 * one by hand gets their text back unchanged.
 */

import type { Database } from "bun:sqlite";
import type { LocalExchange, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { LOCAL_ANSWER_CLOSE } from "@schlessera/brain-ui-sdk/protocol";

/** One stored exchange, in the session's order. */
export interface LocalExchangeRecord extends LocalExchange {
  seq: number;
  /** A prompt has carried its context to the agent. */
  delivered: boolean;
}

/**
 * Record an exchange against a session. `delivered` is true when the prompt
 * carrying its context is being handed over in the same step (a new
 * conversation's first message). Recording an id twice keeps the first: a
 * client that retries has not asked for a second exchange.
 */
export function saveLocalExchange(
  db: Database,
  sessionId: string,
  exchange: LocalExchange,
  delivered: boolean
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO local_exchanges
       (session_id, exchange_id, command, prompt, answer, context, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, exchange_id) DO NOTHING`
  ).run(
    sessionId,
    exchange.id,
    exchange.command,
    exchange.prompt,
    JSON.stringify(exchange.answer),
    exchange.context,
    now,
    delivered ? now : null
  );
}

/**
 * The exchanges no prompt has carried yet, marked as carried. Called at the
 * moment a prompt is handed to the backend, so each context reaches the
 * agent once.
 */
export function takePendingLocalExchanges(db: Database, sessionId: string): LocalExchange[] {
  return db.transaction(() => {
    const rows = db
      .query(
        `SELECT seq, exchange_id, command, prompt, answer, context, delivered_at
         FROM local_exchanges WHERE session_id = ? AND delivered_at IS NULL ORDER BY seq`
      )
      .all(sessionId) as ExchangeRow[];
    if (rows.length === 0) return [];
    db.prepare(
      `UPDATE local_exchanges SET delivered_at = ? WHERE session_id = ? AND delivered_at IS NULL`
    ).run(Date.now(), sessionId);
    return rows.flatMap((row) => {
      const record = fromRow(row);
      return record ? [record] : [];
    });
  }).immediate();
}

/** Every exchange recorded for a session, in order. */
export function loadLocalExchanges(db: Database, sessionId: string): LocalExchangeRecord[] {
  const rows = db
    .query(
      `SELECT seq, exchange_id, command, prompt, answer, context, delivered_at
       FROM local_exchanges WHERE session_id = ? ORDER BY seq`
    )
    .all(sessionId) as ExchangeRow[];
  return rows.flatMap((row) => {
    const record = fromRow(row);
    return record ? [record] : [];
  });
}

interface ExchangeRow {
  seq: number;
  exchange_id: string;
  command: string;
  prompt: string;
  answer: string;
  context: string;
  delivered_at: number | null;
}

function fromRow(row: ExchangeRow): LocalExchangeRecord | null {
  let answer: unknown;
  try {
    answer = JSON.parse(row.answer);
  } catch {
    // Unreadable: replaying the prompt without its answer would be worse
    // than replaying neither.
    return null;
  }
  return {
    seq: row.seq,
    id: row.exchange_id,
    command: row.command,
    prompt: row.prompt,
    answer,
    context: row.context,
    delivered: row.delivered_at !== null,
  };
}

/** The block one exchange's context travels in. The replay pattern below must match it. */
function contextBlock(exchange: LocalExchange): string {
  return (
    `<local-answer command="${exchange.command}" id="${exchange.id}">\n` +
    `The user ran /${exchange.command} in the app before this message. The app answered it ` +
    `without you, and showed them this:\n` +
    `${exchange.context}\n` +
    LOCAL_ANSWER_CLOSE
  );
}

/** The prompt the backend receives: the user's text, then each pending exchange's context. */
export function withLocalContext(text: string, exchanges: readonly LocalExchange[]): string {
  let prompt = text;
  for (const exchange of exchanges) prompt += `\n\n${contextBlock(exchange)}`;
  return prompt;
}

/**
 * The last block on a prompt. A context never contains the closing line (the
 * schema refuses it), so the body cannot run across two blocks.
 */
const TRAILING_BLOCK =
  /\n\n<local-answer command="[a-z][a-z0-9-]*" id="([A-Za-z0-9_-]+)">\n(?:(?!<\/local-answer>)[\s\S])*<\/local-answer>$/;

/**
 * Remove the context blocks from the user messages that carried them, and
 * say which message carried which exchange (by index, which the joins that
 * run after this keep, because they map one message to one).
 */
export function stripLocalContext(
  messages: SessionHistoryMessage[],
  exchanges: readonly LocalExchangeRecord[]
): { messages: SessionHistoryMessage[]; carriers: Map<string, number> } {
  const known = new Set(exchanges.filter((exchange) => exchange.delivered).map((exchange) => exchange.id));
  const carriers = new Map<string, number>();
  if (known.size === 0) return { messages, carriers };
  const stripped = messages.map((message, index) => {
    if (message.role !== "user") return message;
    let content = message.content;
    for (let match = TRAILING_BLOCK.exec(content); match; match = TRAILING_BLOCK.exec(content)) {
      const id = match[1]!;
      if (!known.has(id)) break;
      carriers.set(id, index);
      content = content.slice(0, match.index);
    }
    return content === message.content ? message : { ...message, content };
  });
  return { messages: stripped, carriers };
}

/**
 * Put each exchange back where it happened: before the user message that
 * carried its context, or at the end when no replayed message did (not
 * carried yet, or the backend replays that prompt as other text).
 */
export function spliceLocalExchanges(
  messages: SessionHistoryMessage[],
  exchanges: readonly LocalExchangeRecord[],
  carriers: ReadonlyMap<string, number>
): SessionHistoryMessage[] {
  if (exchanges.length === 0) return messages;
  const before = new Map<number, LocalExchangeRecord[]>();
  const trailing: LocalExchangeRecord[] = [];
  for (const exchange of exchanges) {
    const index = carriers.get(exchange.id);
    if (index === undefined) {
      trailing.push(exchange);
    } else {
      before.set(index, [...(before.get(index) ?? []), exchange]);
    }
  }
  const out: SessionHistoryMessage[] = [];
  messages.forEach((message, index) => {
    for (const exchange of before.get(index) ?? []) out.push(...replayed(exchange));
    out.push(message);
  });
  for (const exchange of trailing) out.push(...replayed(exchange));
  return out;
}

function replayed(exchange: LocalExchangeRecord): SessionHistoryMessage[] {
  return [
    { role: "user", content: exchange.prompt, toolCalls: [] },
    {
      role: "assistant",
      content: "",
      toolCalls: [],
      localAnswer: { exchangeId: exchange.id, command: exchange.command, answer: exchange.answer },
    },
  ];
}
