import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { SessionHistoryMessage, TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { serverResultSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { SessionCatalog } from "./session-catalog.js";

export interface RecordedTurnFailure {
  turnId: string;
  assistantOrdinal: number;
  prefixDigest: string;
  failure: TurnFailure;
}

/** Position is among backend-normalized assistants, before local exchanges are inserted. */
export function assistantCount(messages: SessionHistoryMessage[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

/** Guard against an edited/truncated/rebranched transcript reusing an old position. */
export function updatePrefix(hash: Bun.CryptoHasher, message: SessionHistoryMessage): void {
  hash.update(JSON.stringify([message.role, message.content, message.thinking ?? null,
    message.toolCalls, message.attachmentCount ?? 0, message.failure?.message ?? null]));
  hash.update("\n");
}

export function prefixDigest(messages: SessionHistoryMessage[], end: number): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const message of messages.slice(0, end + 1)) updatePrefix(hash, message);
  return hash.digest("hex");
}

export function saveTurnFailure(db: Database, sessionId: string, backendId: string, record: RecordedTurnFailure): void {
  db.prepare(`INSERT INTO turn_failures (session_id, backend_id, assistant_ordinal, turn_id, prefix_digest, failure_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, backend_id, assistant_ordinal, prefix_digest) DO NOTHING`)
    .run(sessionId, backendId, record.assistantOrdinal, record.turnId, record.prefixDigest, JSON.stringify(record.failure));
}

export function attachTurnFailures(db: Database, sessionId: string, backendId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
  const rows = db.query("SELECT assistant_ordinal, prefix_digest, failure_json FROM turn_failures WHERE session_id = ? AND backend_id = ?")
    .all(sessionId, backendId) as Array<{ assistant_ordinal: number; prefix_digest: string; failure_json: string }>;
  if (rows.length === 0) return messages;
  const stored = new Map(rows.map((row) => [`${row.assistant_ordinal}:${row.prefix_digest}`, row]));
  let ordinal = 0;
  const hash = new Bun.CryptoHasher("sha256");
  return messages.map((message) => {
    updatePrefix(hash, message);
    if (message.role !== "assistant") return message;
    const row = stored.get(`${ordinal++}:${hash.copy().digest("hex")}`);
    if (!row || !message.failure) return message;
    try {
      const parsed = serverResultSchema.shape.failure.safeParse(JSON.parse(row.failure_json));
      return parsed.success && parsed.data && parsed.data.message === message.failure.message
        ? { ...message, failure: parsed.data } : message;
    } catch { return message; }
  });
}

/** How long a turn-boundary read may hold the session's next turn. */
const BOUNDARY_READ_MS = 10_000;

/** One concrete host's in-flight writes; never shared across apps or sessions. */
export class FailureReplay {
  private readonly pending = new Map<string, Set<Promise<void>>>();
  constructor(private readonly catalog: SessionCatalog, private readonly log: Logger) {}

  async wait(sessionId: string): Promise<void> {
    for (;;) {
      const writes = this.pending.get(sessionId);
      if (!writes) return;
      await Promise.all(writes);
    }
  }

  private report(sessionId: string | undefined, err: unknown): void {
    this.log.emit({ severityText: "WARN", body: "turn failure could not be recorded for replay",
      attributes: { ...(sessionId ? { "session.id": sessionId } : {}), error: err instanceof Error ? err.message : String(err) } });
  }

  private async history(backend: AgentBackend, sessionId: string, signal: AbortSignal): Promise<SessionHistoryMessage[]> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Turn aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([backend.getHistory(sessionId), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private track(sessionId: string, write: Promise<void>): void {
    const writes = this.pending.get(sessionId) ?? new Set<Promise<void>>();
    writes.add(write); this.pending.set(sessionId, writes);
    void write.then(() => { writes.delete(write); if (writes.size === 0) this.pending.delete(sessionId); });
  }

  /**
   * After a turn: if the transcript gained an assistant answer during it,
   * record that answer's position as the turn's boundary (#964). Waits on
   * the turn's failure write first, so both describe one transcript.
   */
  private boundary(backend: AgentBackend, sessionId: string, turnId: string, before: number): Promise<void> {
    const write = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The turn's own signal may be aborted (a cancel or timeout ends it),
        // so the read is bounded by its own timer instead.
        const messages = await Promise.race([
          backend.getHistory(sessionId),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("history read timed out")), BOUNDARY_READ_MS); }),
        ]);
        const count = assistantCount(messages);
        // Nothing answered during the turn: no message is this turn's.
        if (count <= before || messages.at(-1)?.role !== "assistant") return;
        this.catalog.recordTurnBoundary?.(sessionId, backend.id, {
          turnId, assistantOrdinal: count - 1, prefixDigest: prefixDigest(messages, messages.length - 1),
        });
      } catch (err) { this.report(sessionId, err); }
      finally { clearTimeout(timer); }
    })();
    this.track(sessionId, write);
    return write;
  }

  async begin(backend: AgentBackend, sessionId: string | undefined, turnId: string, signal: AbortSignal): Promise<{
    observe: (sessionId: string, failure: TurnFailure) => void;
    /** `sessionId` is the session the turn ran in, when it ran; boundaries are recorded only then. */
    finish: (sessionId?: string | null) => Promise<void>;
  }> {
    let before: number | null = null;
    if (this.catalog.recordTurnFailure || this.catalog.recordTurnBoundary) {
      try {
        if (sessionId) await this.wait(sessionId);
        before = sessionId ? assistantCount(await this.history(backend, sessionId, signal)) : 0;
      } catch (err) { this.report(sessionId, err); }
    }
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    let write: Promise<void> | undefined;
    let closed = false;
    return {
      observe: (sid, failure) => {
        if (closed || before === null || write) return;
        const live = { ...failure };
        write = (async () => {
          await settled;
          try {
            const messages = await this.history(backend, sid, signal);
            const last = messages.at(-1);
            const count = assistantCount(messages);
            // A refused prompt/no persisted answer must never relabel an older failure.
            if (count <= before! || last?.role !== "assistant" || last.failure?.message !== live.message) return;
            this.catalog.recordTurnFailure?.(sid, backend.id, {
              turnId, assistantOrdinal: count - 1, prefixDigest: prefixDigest(messages, messages.length - 1), failure: live,
            });
          } catch (err) { this.report(sid, err); }
        })();
        this.track(sid, write);
      },
      finish: async (sid) => {
        const first = !closed;
        closed = true; release(); await write;
        if (first && sid && before !== null && this.catalog.recordTurnBoundary) {
          await this.boundary(backend, sid, turnId, before);
        }
      },
    };
  }
}
