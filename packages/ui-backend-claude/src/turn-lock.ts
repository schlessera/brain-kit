import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { LockBusyError } from "@schlessera/brain-ui-sdk/server";

import type { BackendLogFn } from "./options.js";

/** Per-turn mutable state tracked while a session's turn is running. */
export interface ActiveTurn {
  /**
   * Write-lock releases held by a mutating tool, keyed by the toolUseId that
   * acquired them; released when that tool's result frame streams, or all at
   * once by the turn-end backstop.
   */
  pendingReleases: Map<string, () => void>;
  /** Set in the turn's finally, so a lock acquired after teardown self-releases. */
  ended: boolean;
}

export interface TurnLockBinding {
  acquireForTool(
    toolUseId: string,
    lockKey: string | null
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  releaseForTool(toolUseId: string): void;
  close(): void;
}

export function createTurnLockBinding(options: {
  turn: ActiveTurn;
  writeLock: KeyedLock;
  lockWaitMs: number;
  log: BackendLogFn;
}): TurnLockBinding {
  const { turn, writeLock, lockWaitMs, log } = options;

  // Write-lock bookkeeping is keyed by toolUseId and idempotent per key: the
  // PreToolUse hook and the canUseTool re-acquire can both run for one tool
  // use, and a release must be safe when nothing is held.
  //
  // Resolves `ok: false` — never throws — when the bounded wait expires, so
  // callers turn it into a DENY with a reason the model can act on. Stalling
  // here instead would run into the CLI's own hook timeout, whose refusal
  // message ("hook did not respond") reads like a broken call.
  const acquireForTool: TurnLockBinding["acquireForTool"] = async (
    toolUseId,
    lockKey
  ) => {
    if (lockKey === null || turn.pendingReleases.has(toolUseId)) return { ok: true };
    const waitStarted = Date.now();
    let release: () => void;
    try {
      release = await writeLock.acquire(
        lockKey,
        lockWaitMs > 0 ? { timeoutMs: lockWaitMs } : undefined
      );
    } catch (err) {
      if (err instanceof LockBusyError) {
        log("warn", "lock wait exceeded the bound; denying with retry", {
          key: lockKey,
          toolUseId,
          waitedMs: err.waitedMs,
        });
        return {
          ok: false,
          reason:
            `The shared "${lockKey}" write lock is busy (another agent is mid-write). ` +
            `Nothing is wrong with this call and it was NOT executed — retry the identical call in a moment.`,
        };
      }
      throw err;
    }
    const waitedMs = Date.now() - waitStarted;
    if (waitedMs > 5_000) {
      // The watchdog: contention is expected to be rare and brief, so a
      // multi-second wait is a signal worth having in the log even when it
      // eventually succeeded.
      log("warn", "lock wait was unusually long", {
        key: lockKey,
        toolUseId,
        waitedMs,
      });
    }
    if (turn.ended || turn.pendingReleases.has(toolUseId)) {
      // Turn drained while queued, or a concurrent acquire won: never runs.
      release();
      return { ok: true };
    }
    turn.pendingReleases.set(toolUseId, release);
    return { ok: true };
  };

  const releaseForTool = (toolUseId: string): void => {
    const release = turn.pendingReleases.get(toolUseId);
    if (release) {
      release();
      turn.pendingReleases.delete(toolUseId);
    }
  };

  return {
    acquireForTool,
    releaseForTool,
    close() {
      turn.ended = true;
      for (const release of turn.pendingReleases.values()) release();
      turn.pendingReleases.clear();
    },
  };
}
