/**
 * Cross-process mutual exclusion for compute state.
 *
 * A lock is an empty SQLite file held with `BEGIN IMMEDIATE`. The kernel's
 * advisory record lock under it is released when its process dies, however
 * it dies, so a dead owner never needs reclaiming and a live owner can never
 * be mistaken for a dead one (no PID reuse, no namespace guessing). The file
 * holds no data: it is a mutex, never state. Acquisition never blocks the
 * event loop: it polls with busy_timeout 0 up to a bounded wait.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

/** A held lock. `release` is idempotent. */
export interface HeldLock {
  release(): void;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked|busy/i.test(String((error as Error).message));
}

/** Try once. `undefined` when another holder has it. */
export function tryLock(path: string): HeldLock | undefined {
  const created = !existsSync(path);
  const db = new Database(path, { create: true });
  if (created) {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (isBusy(error)) return undefined;
    throw error;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    },
  };
}

/** Acquire within `waitMs`, polling; `undefined` when the holder kept it that long. */
export async function acquireLock(path: string, waitMs: number): Promise<HeldLock | undefined> {
  const until = performance.now() + waitMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    const lock = tryLock(path);
    if (lock || performance.now() >= until) return lock;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(1, until - performance.now()))));
  }
}
