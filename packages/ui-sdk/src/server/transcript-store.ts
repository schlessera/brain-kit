/**
 * Optional JSONL transcript store for backends whose runtime has no session
 * persistence of its own (a plain API tool-loop): list/history in ~10 lines
 * of backend code. Backends with native persistence (Claude SDK JSONL, pi
 * SessionManager) should NOT use this — no second source of truth.
 *
 * Layout: <dir>/<sessionId>.jsonl — line 1 is a `meta` record, every later
 * line is a `message` record. Append-only.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import type { ChatSession, SessionHistoryMessage } from "../protocol.js";

interface MetaRecord {
  kind: "meta";
  id: string;
  title: string | null;
  createdAt: number;
}

interface MessageRecord {
  kind: "message";
  ts: number;
  message: SessionHistoryMessage;
  costUsd?: number;
}

export interface TranscriptStore {
  /** Create a new session file; returns its id. */
  create(opts?: { title?: string }): string;
  append(sessionId: string, message: SessionHistoryMessage, opts?: { costUsd?: number }): void;
  list(): ChatSession[];
  history(sessionId: string): SessionHistoryMessage[];
}

export function createTranscriptStore(dir: string): TranscriptStore {
  mkdirSync(dir, { recursive: true });

  // Strictly monotonic per store instance: bursts of appends within one
  // millisecond would otherwise tie on Date.now() and make list() ordering
  // nondeterministic.
  let lastTs = 0;
  const nextTs = () => {
    const now = Date.now();
    lastTs = now > lastTs ? now : lastTs + 1;
    return lastTs;
  };

  const fileOf = (id: string) => join(dir, `${id}.jsonl`);

  const readRecords = (id: string): (MetaRecord | MessageRecord)[] => {
    const file = fileOf(id);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MetaRecord | MessageRecord);
  };

  return {
    create(opts = {}) {
      const id = crypto.randomUUID();
      const meta: MetaRecord = {
        kind: "meta",
        id,
        title: opts.title ?? null,
        createdAt: nextTs(),
      };
      appendFileSync(fileOf(id), `${JSON.stringify(meta)}\n`, "utf-8");
      return id;
    },

    append(sessionId, message, opts = {}) {
      if (!existsSync(fileOf(sessionId))) {
        throw new Error(`Unknown transcript session: ${sessionId}`);
      }
      const record: MessageRecord = {
        kind: "message",
        ts: nextTs(),
        message,
        ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
      };
      appendFileSync(fileOf(sessionId), `${JSON.stringify(record)}\n`, "utf-8");
    },

    list() {
      const sessions: ChatSession[] = [];
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const records = readRecords(entry.slice(0, -".jsonl".length));
        const meta = records.find((r): r is MetaRecord => r.kind === "meta");
        if (!meta) continue;
        const messages = records.filter((r): r is MessageRecord => r.kind === "message");
        sessions.push({
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          lastActiveAt: messages.length > 0 ? messages[messages.length - 1].ts : meta.createdAt,
          totalCostUsd: messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
          numTurns: messages.filter((m) => m.message.role === "user").length,
        });
      }
      return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    },

    history(sessionId) {
      return readRecords(sessionId)
        .filter((r): r is MessageRecord => r.kind === "message")
        .map((r) => r.message);
    },
  };
}
