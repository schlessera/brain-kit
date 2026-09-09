import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { BackendBusyError } from "@schlessera/brain-ui-sdk/server";

import { capsOf, type PiSessionLike, type SessionEnv } from "./backend-options.js";
import type { SessionRuntime } from "./session-runtime.js";
import type { TurnContext } from "./turn-context.js";

/**
 * Max pi AgentSessions kept resident in memory. Beyond this, IDLE (not running)
 * sessions are disposed least-recently-used-first at the end of a turn; their
 * transcripts stay on disk and reopen on the next resume. Running sessions are
 * never evicted.
 */
const MAX_IN_MEMORY_SESSIONS = 5;
const BACKEND_ID = "pi";

/** One resident session: its pi runtime, its per-session tool plumbing, liveness. */
export interface SessionEntry {
  session: PiSessionLike;
  turnContext: TurnContext;
  /** True while a turn targeting this session is in flight (per-session busy). */
  running: boolean;
}

export interface SessionPool {
  sessions: Map<string, SessionEntry>;
  acquire(req: StartTurnRequest): Promise<{ entry: SessionEntry; isNew: boolean }>;
  finish(entry: SessionEntry): void;
}

export function createSessionPool(runtime: SessionRuntime): SessionPool {
  // Resident sessions, keyed by pi sessionId. Insertion order is the LRU order:
  // reused sessions are re-inserted at the tail, eviction drops the head.
  const sessions = new Map<string, SessionEntry>();

  /**
   * Resolve the session for this turn and claim it (entry.running = true). A
   * matching in-memory session is reused (and touched for LRU); an unknown
   * running session raises a per-session BackendBusyError; an unknown resume id
   * or bad profile raises BackendRequestError (both before anything is emitted).
   */
  async function acquire(
    req: StartTurnRequest
  ): Promise<{ entry: SessionEntry; isNew: boolean }> {
    const env: SessionEnv = {
      ...(req.client ? { client: req.client } : {}),
      caps: capsOf(req.bridge),
      ...(req.turnBudgetMs ? { turnBudgetMs: req.turnBudgetMs } : {}),
    };
    if (req.sessionId) {
      const existing = sessions.get(req.sessionId);
      if (existing) {
        if (existing.running) throw new BackendBusyError(BACKEND_ID, req.sessionId);
        existing.running = true;
        touch(req.sessionId);
        return { entry: existing, isNew: false };
      }
      // Not resident — reopen the transcript from disk.
      const opened = await runtime.openSession(req.sessionId, env);
      // A concurrent turn for the same id may have registered it while we opened.
      const raced = sessions.get(req.sessionId);
      if (raced) {
        disposeSession(opened.session);
        if (raced.running) throw new BackendBusyError(BACKEND_ID, req.sessionId);
        raced.running = true;
        touch(req.sessionId);
        return { entry: raced, isNew: false };
      }
      const entry: SessionEntry = { ...opened, running: true };
      sessions.set(entry.session.sessionId, entry);
      return { entry, isNew: false };
    }

    const created = await runtime.newSession(req.profileId, env);
    const existing = sessions.get(created.session.sessionId);
    if (existing) {
      // The runtime handed back an id we already track. In production pi ids are
      // unique so this never fires; the injected fake reuses ids, and either way
      // we must not clobber a running turn — surface per-session busy and drop
      // the duplicate.
      disposeSession(created.session);
      if (existing.running) {
        throw new BackendBusyError(BACKEND_ID, created.session.sessionId);
      }
      existing.running = true;
      touch(created.session.sessionId);
      return { entry: existing, isNew: false };
    }
    const entry: SessionEntry = { ...created, running: true };
    sessions.set(entry.session.sessionId, entry);
    return { entry, isNew: true };
  }

  /** Move a reused session to the LRU tail so eviction favours colder sessions. */
  function touch(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    sessions.set(sessionId, entry);
  }

  /** Dispose idle (not running) sessions, LRU-first, until back under the cap. */
  function evictIdle(): void {
    if (sessions.size <= MAX_IN_MEMORY_SESSIONS) return;
    for (const [id, entry] of sessions) {
      if (sessions.size <= MAX_IN_MEMORY_SESSIONS) break;
      if (entry.running) continue;
      disposeSession(entry.session);
      sessions.delete(id);
    }
  }

  return {
    sessions,
    acquire,
    finish(entry) {
      entry.running = false;
      evictIdle();
    },
  };
}

function disposeSession(session: PiSessionLike): void {
  try {
    session.dispose();
  } catch {
    // Best effort.
  }
}
