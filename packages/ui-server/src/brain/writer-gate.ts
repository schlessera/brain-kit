/**
 * The brain's writer gate (#1648; docs/decisions/governed-writable-workers.md,
 * "The writer gate").
 *
 * Every writer of the brain holds it while it runs. `governed` and `strict`
 * turns and credential-free maintenance workers hold it shared, so they run
 * side by side. A maintenance worker that holds a credential holds it
 * exclusively, from validation through reconciliation, so no turn can be
 * running, or leave an unreconciled file, while code beside a credential runs.
 *
 * No deadlock: a running turn never waits for an exclusive holder. The work a
 * turn waits for (the index after a curated application) is credential-free
 * and shared; credentialed work waits until no shared holder remains. New
 * shared holders are not held back by a waiting exclusive one, because a turn
 * that already holds the gate may need a shared maintenance worker to finish.
 *
 * The server and the cron runner are separate processes, so the gate is a
 * table in the UI database. A row whose process has exited is stale and is
 * removed by the next acquisition.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type GateMode = "shared" | "exclusive";

/** The `starttime` field of `/proc/<pid>/stat`, which tells a reused pid apart from the one that wrote a row. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesised and may hold spaces; fields follow the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether the process that wrote a row is still the one running under its pid. */
export function processAlive(pid: number, start: string): boolean {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const now = processStart(pid);
  // Without procfs a live pid is the best evidence there is.
  return now === null || now === start;
}

export const SELF = { pid: process.pid, start: processStart(process.pid) ?? "" };

export interface GateHold {
  readonly id: string;
  readonly mode: GateMode;
  release(): void;
}

export interface WriterGate {
  /** Waits until `mode` is admitted, then holds it until `release()`. */
  acquire(mode: GateMode, purpose: string, options?: { signal?: AbortSignal }): Promise<GateHold>;
  /** Current holders, stale ones removed. */
  holders(): { mode: GateMode; purpose: string; pid: number }[];
}

/** How often a waiting acquisition looks again. */
export const GATE_POLL_MS = 200;

export function createWriterGate(db: Database, brainPath: string, options: { pollMs?: number } = {}): WriterGate {
  let brain: string;
  try { brain = realpathSync(brainPath); } catch { brain = brainPath; }
  const pollMs = options.pollMs ?? GATE_POLL_MS;
  const prune = () => {
    const rows = db.query("SELECT id, pid, pid_start FROM writer_gate WHERE brain = ?").all(brain) as { id: string; pid: number; pid_start: string }[];
    for (const row of rows) if (!processAlive(row.pid, row.pid_start)) db.query("DELETE FROM writer_gate WHERE id = ?").run(row.id);
  };
  const tryAcquire = (mode: GateMode, purpose: string): string | null => db.transaction(() => {
    prune();
    const held = db.query("SELECT mode FROM writer_gate WHERE brain = ?").all(brain) as { mode: GateMode }[];
    const blocked = mode === "exclusive" ? held.length > 0 : held.some(row => row.mode === "exclusive");
    if (blocked) return null;
    const id = randomUUID();
    db.query("INSERT INTO writer_gate (id, brain, mode, purpose, pid, pid_start, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, brain, mode, purpose, SELF.pid, SELF.start, Date.now());
    return id;
  }).immediate();
  return {
    async acquire(mode, purpose, { signal } = {}) {
      for (;;) {
        signal?.throwIfAborted();
        const id = tryAcquire(mode, purpose);
        if (id) {
          let released = false;
          return { id, mode, release() {
            if (released) return;
            released = true;
            db.query("DELETE FROM writer_gate WHERE id = ?").run(id);
          } };
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, pollMs);
          const stop = () => { clearTimeout(timer); reject(signal!.reason); };
          signal?.addEventListener("abort", stop, { once: true });
        });
      }
    },
    holders() {
      return db.transaction(() => {
        prune();
        return db.query("SELECT mode, purpose, pid FROM writer_gate WHERE brain = ? ORDER BY acquired_at").all(brain) as { mode: GateMode; purpose: string; pid: number }[];
      }).immediate();
    },
  };
}
