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
 * shared maintenance holders are not held back by a waiting exclusive one,
 * because a turn may need one to finish. A queued user revert explicitly holds
 * back new turn admissions, while that nested maintenance remains admissible.
 *
 * The server and the cron runner are separate processes, so the gate is a
 * table in the UI database. A row whose process has exited is stale and is
 * removed by the next acquisition.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createGovernancePolicyReader, providerFolderRoots } from "./governance-policy.js";

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
  /** Planned retained folders, including active peers. Not evidence that a worker mounted them. */
  readonly folderPaths?: readonly string[];
  /** Extend this held plan to the exact admitted policy; never removes active peer roots. */
  retainFolders?(paths: readonly string[]): readonly string[];
  /** Refuse known missing/unaccounted peer plans. Success is not mounted-worker attestation. */
  assertPeerFolderPlans?(paths: readonly string[]): void;
  release(): void;
}

export interface WriterGate {
  /** Waits until `mode` is admitted, then holds it until `release()`. */
  acquire(mode: GateMode, purpose: string, options?: { signal?: AbortSignal; turn?: boolean; queueTurns?: boolean }): Promise<GateHold>;
  /** Current holders, stale ones removed. */
  holders(): { mode: GateMode; purpose: string; pid: number }[];
}

/** How often a waiting acquisition looks again. */
export const GATE_POLL_MS = 200;


/** Derived folder plans only. NULL legacy rows are not mounted-topology proof. */
function mergeFolderPlans(rows: { folder_topology: string | null }[], additions: readonly string[]): readonly string[] {
  const roots = new Set<string>();
  const include = (parsed: unknown) => {
    if (!Array.isArray(parsed) || parsed.some(root => typeof root !== "string" || !root || root.startsWith("/") || root.startsWith("~") || /^[A-Za-z]:/.test(root) || root.includes("\\")
      || /[\u0000-\u001f\u007f*?[\]{}()!]/u.test(root) || root.split("/").some(part => !part || part === "." || part === "..")))
      throw new Error("Active writer folder topology is invalid; reconcile its admission before starting another writer");
    for (const root of parsed) roots.add(root);
  };
  include(additions);
  for (const row of rows) if (row.folder_topology !== null) include(JSON.parse(row.folder_topology));
  return Object.freeze([...roots].sort());
}

export function createWriterGate(db: Database, brainPath: string, options: { pollMs?: number } = {}): WriterGate {
  let brain: string;
  try { brain = realpathSync(brainPath); } catch { brain = brainPath; }
  const pollMs = options.pollMs ?? GATE_POLL_MS;
  const policyReader = createGovernancePolicyReader(brain);
  const prune = () => {
    const rows = db.query("SELECT id, pid, pid_start FROM writer_gate WHERE brain = ?").all(brain) as { id: string; pid: number; pid_start: string }[];
    for (const row of rows) if (!processAlive(row.pid, row.pid_start)) db.query("DELETE FROM writer_gate WHERE id = ?").run(row.id);
  };
  const tryAcquire = (mode: GateMode, purpose: string, turn: boolean, waiter: string | null): { id: string; folderPaths: readonly string[] } | null => db.transaction(() => {
    prune();
    const held = db.query("SELECT mode, folder_topology FROM writer_gate WHERE brain = ?").all(brain) as { mode: GateMode; folder_topology: string | null }[];
    const waiters = db.query("SELECT id, pid, pid_start FROM writer_gate_turn_waiters WHERE brain = ? ORDER BY queued_at, rowid").all(brain) as { id: string; pid: number; pid_start: string }[];
    for (const row of waiters) if (!processAlive(row.pid, row.pid_start)) db.query("DELETE FROM writer_gate_turn_waiters WHERE id = ?").run(row.id);
    const first = waiters.find(row => processAlive(row.pid, row.pid_start));
    const blocked = mode === "exclusive" ? held.length > 0 || (waiter !== null && first?.id !== waiter) : held.some(row => row.mode === "exclusive") || (turn && first !== undefined);
    if (blocked) return null;
    const id = randomUUID();
    if (waiter) db.query("DELETE FROM writer_gate_turn_waiters WHERE id = ?").run(waiter);
    const folderPaths = mergeFolderPlans(held, providerFolderRoots(policyReader.load().policy));
    db.query("INSERT INTO writer_gate (id, brain, mode, purpose, pid, pid_start, acquired_at, folder_topology) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, brain, mode, purpose, SELF.pid, SELF.start, Date.now(), JSON.stringify(folderPaths));
    return { id, folderPaths };
  }).immediate();
  return {
    async acquire(mode, purpose, { signal, turn = false, queueTurns = false } = {}) {
      signal?.throwIfAborted();
      const waiter = mode === "exclusive" && queueTurns ? randomUUID() : null;
      if (waiter) db.query("INSERT INTO writer_gate_turn_waiters (id, brain, pid, pid_start, queued_at) VALUES (?, ?, ?, ?, ?)").run(waiter, brain, SELF.pid, SELF.start, Date.now());
      try { for (;;) {
        signal?.throwIfAborted();
        const acquired = tryAcquire(mode, purpose, turn, waiter);
        if (acquired) {
          const { id } = acquired;
          let folderPaths = acquired.folderPaths;
          let released = false;
          return { id, mode, get folderPaths() { return folderPaths; }, retainFolders(paths) {
            if (released) throw new Error("Writer folder plan was already released");
            folderPaths = db.transaction(() => {
              prune();
              const own = db.query("SELECT id FROM writer_gate WHERE id = ? AND brain = ? AND pid = ? AND pid_start = ?").get(id, brain, SELF.pid, SELF.start);
              if (!own) throw new Error("Writer folder plan no longer has its admitted owner");
              const rows = db.query("SELECT folder_topology FROM writer_gate WHERE brain = ?").all(brain) as { folder_topology: string | null }[];
              const next = mergeFolderPlans(rows, [...folderPaths, ...paths]);
              db.query("UPDATE writer_gate SET folder_topology = ? WHERE id = ?").run(JSON.stringify(next), id);
              return next;
            }).immediate();
            return folderPaths;
          }, assertPeerFolderPlans(paths) {
            if (released) throw new Error("Writer folder plan was already released");
            const requested = mergeFolderPlans([], paths);
            if (!requested.length) return;
            if (requested.some(root => !folderPaths.includes(root))) throw new Error("Requested writer folder plan is not held");
            db.transaction(() => {
              prune();
              const own = db.query("SELECT id FROM writer_gate WHERE id = ? AND brain = ? AND pid = ? AND pid_start = ?").get(id, brain, SELF.pid, SELF.start);
              if (!own) throw new Error("Writer folder plan no longer has its admitted owner");
              const peers = db.query("SELECT folder_topology FROM writer_gate WHERE brain = ? AND id <> ?").all(brain, id) as { folder_topology: string | null }[];
              for (const peer of peers) {
                if (peer.folder_topology === null) throw new Error("An active peer has an unaccounted provider folder plan; finish that peer and retry admission");
                let roots: readonly string[];
                try { roots = mergeFolderPlans([peer], []); }
                catch { throw new Error("An active peer has an unverified provider folder plan; finish that peer and retry admission"); }
                // A descendant root also pins each ancestor. An ancestor root
                // alone does not retain an arbitrary child inside its subtree.
                if (requested.some(path => !roots.some(root => root === path || root.startsWith(`${path}/`))))
                  throw new Error("An active peer did not retain the requested provider folders; finish that peer and retry admission");
              }
            }).immediate();
          }, release() {
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
      } } finally {
        if (waiter) db.query("DELETE FROM writer_gate_turn_waiters WHERE id = ?").run(waiter);
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
