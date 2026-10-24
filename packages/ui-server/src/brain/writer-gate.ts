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
 * removed by the next acquisition. The folders a policy's type selectors last
 * translated to live there too, so every process plans them, across restarts
 * (#2836).
 */
import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGovernancePolicyReader, providerFolderRoots, retainedFolderRoots, type TurnGovernancePolicy } from "./governance-policy.js";
import { ensureIndexDirectory } from "./index-directory.js";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";

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
  /**
   * `assertPeerFolderPlans`, but wait up to `timeoutMs` for peers admitted
   * before this hold retained `paths` to finish (#2832); every other refusal,
   * and a peer still active at the bound, refuses as before.
   */
  waitForPeerFolderPlans?(paths: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  release(): void;
}

export interface WriterGate {
  /** Waits until `mode` is admitted, then holds it until `release()`. */
  acquire(mode: GateMode, purpose: string, options?: { signal?: AbortSignal; turn?: boolean; queueTurns?: boolean }): Promise<GateHold>;
  /** Current holders, stale ones removed. */
  holders(): { mode: GateMode; purpose: string; pid: number }[];
  /** Refuse an ungated host process beside retained or unknown folder plans, or under a folder policy. */
  assertUngatedHostFallback(): void;
  /**
   * Record the folders admission translated the policy's type selectors to,
   * under that policy's hash (#2836). Every later acquisition under the same
   * hash plans them, in any process. It replaces the brain's earlier record.
   */
  rememberTypeFolders(policyHash: string | null, folders: readonly string[]): void;
}

/** How often a waiting acquisition looks again. */
export const GATE_POLL_MS = 200;

/**
 * How long provider folder admission waits for a peer whose plan predates the
 * folders it retains (#2832). A type selector's folders are known only once a
 * turn has translated it, so writers admitted at server start, before the first
 * provider-policy turn, plan without them. The boot-time scratch prune is one;
 * on the native fixture it finishes within a second of the turn reaching it.
 */
export const PEER_FOLDER_PLAN_WAIT_MS = 30_000;

const UNRETAINED_PEER = "An active peer did not retain the requested provider folders; finish that peer and retry admission";

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * The legacy host fallback refused because a provider folder policy is active
 * or its state is unknown (#2284, ruling (c)). Nothing bounds a host child's
 * descendants, so no host process may start beside folders a governed worker
 * can pin.
 */
export class HostFallbackRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "HostFallbackRefusedError"; }
}

/**
 * Refuse host fallback under an active provider folder policy, a retained
 * folder plan, or an invalid policy. A policy without provider folders keeps
 * the legacy host path.
 */
export function refuseHostFallback(policy: TurnGovernancePolicy, roots: readonly string[] = []): void {
  if (policy.errors.length) throw new HostFallbackRefusedError("Host fallback is refused: context/policies/governance.md cannot be read or parsed, so whether a provider folder policy is active is unknown, and brain code requires the qualified worker boundary until it is fixed. Check it with `brain policy check`.");
  const folders = [...new Set([...roots, ...providerFolderRoots(policy.policy)])].sort();
  if (folders.length) throw new HostFallbackRefusedError(`Host fallback is refused while a provider folder policy is active (${folders.join(", ")}): brain code beside protected folders requires the qualified worker boundary, because nothing bounds a host process's descendants. Run the server where the worker boundary is available, or remove the provider folders from the policy.`);
}

// Only a concrete, still-owned hold can record negative host provenance.
// This never attests mounts or upgrades a plan into qualified authority.
const hostWriterMarkers = new WeakMap<GateHold, () => void>();
export function markUnpinnedHostWriter(hold: GateHold): void {
  const mark = hostWriterMarkers.get(hold);
  if (!mark) throw new Error("Host writer folder provenance cannot be recorded with this gate");
  mark();
}

function folderPlan(raw: string): { roots: readonly string[]; unpinnedHost: boolean } {
  const parsed: unknown = JSON.parse(raw);
  const unpinnedHost = parsed !== null && !Array.isArray(parsed) && typeof parsed === "object"
    && Object.keys(parsed).length === 2 && Object.hasOwn(parsed, "roots")
    && (parsed as { kind?: unknown }).kind === "unpinned_host";
  const roots = unpinnedHost ? (parsed as { roots: unknown }).roots : parsed;
  if (!Array.isArray(roots) || roots.some(root => typeof root !== "string" || !root || root.startsWith("/") || root.startsWith("~") || /^[A-Za-z]:/.test(root) || root.includes("\\")
    || /[\u0000-\u001f\u007f*?[\]{}()!]/u.test(root) || root.split("/").some(part => !part || part === "." || part === "..")))
    throw new Error("Active writer folder topology is invalid; reconcile its admission before starting another writer");
  return { roots, unpinnedHost };
}

/**
 * The type folders last translated under `hash`. A missing, unreadable or
 * other-hash record plans none: it only ever adds retention, and admission
 * still checks what it actually masks. A recorded folder that is no longer an
 * unaliased directory, as after the taxonomy moved a type under the same
 * policy, is dropped: it cannot be pinned, and retaining it would refuse
 * every governed worker that inherits it.
 */
function recordedTypeFolders(db: Database, brain: string, hash: string | null): readonly string[] {
  if (hash === null) return [];
  try {
    const row = db.query("SELECT folders FROM provider_type_folders WHERE brain = ? AND policy_hash = ?").get(brain, hash) as { folders: string } | null;
    if (!row || !Array.isArray(JSON.parse(row.folders))) return [];
    return folderPlan(row.folders).roots.filter(root => root.split("/").every((_, i, parts) =>
      lstatSync(join(brain, ...parts.slice(0, i + 1)), { throwIfNoEntry: false })?.isDirectory() === true));
  } catch { return []; }
}

/** Derived folder plans only. NULL legacy rows are not mounted-topology proof. */
function mergeFolderPlans(rows: { folder_topology: string | null }[], additions: readonly string[]): readonly string[] {
  const roots = new Set<string>();
  for (const root of folderPlan(JSON.stringify(additions)).roots) roots.add(root);
  for (const row of rows) if (row.folder_topology !== null) for (const root of folderPlan(row.folder_topology).roots) roots.add(root);
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
    const policy = policyReader.load();
    const folderPaths = mergeFolderPlans(held, retainedFolderRoots(policy.policy, recordedTypeFolders(db, brain, policy.hash)));
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
          // A plan retaining the index directory needs it to exist; the
          // protection resolver stays the authority when it cannot.
          if (acquired.folderPaths.includes(INDEX_DIR)) { try { ensureIndexDirectory(brain); } catch { /* resolver refuses */ } }
          let folderPaths = acquired.folderPaths;
          let released = false, unpinnedHost = false;
          // Throws for a peer that is unsafe whatever it does next; returns
          // whether some peer's plan lacks a requested root.
          const checkPeerFolderPlans = (paths: readonly string[]): boolean => {
            if (released) throw new Error("Writer folder plan was already released");
            const requested = mergeFolderPlans([], paths);
            if (!requested.length) return false;
            if (unpinnedHost) throw new Error("An unpinned host writer cannot qualify provider folder admission");
            if (requested.some(root => !folderPaths.includes(root))) throw new Error("Requested writer folder plan is not held");
            return db.transaction(() => {
              prune();
              const own = db.query("SELECT id FROM writer_gate WHERE id = ? AND brain = ? AND pid = ? AND pid_start = ?").get(id, brain, SELF.pid, SELF.start);
              if (!own) throw new Error("Writer folder plan no longer has its admitted owner");
              const peers = db.query("SELECT folder_topology FROM writer_gate WHERE brain = ? AND id <> ?").all(brain, id) as { folder_topology: string | null }[];
              let unretained = false;
              for (const peer of peers) {
                if (peer.folder_topology === null) throw new Error("An active peer has an unaccounted provider folder plan; finish that peer and retry admission");
                let plan: ReturnType<typeof folderPlan>;
                try { plan = folderPlan(peer.folder_topology); }
                catch { throw new Error("An active peer has an unverified provider folder plan; finish that peer and retry admission"); }
                if (plan.unpinnedHost) throw new Error("An active peer is an unpinned host writer; finish that peer and retry admission");
                // A descendant root also pins each ancestor. An ancestor root
                // alone does not retain an arbitrary child inside its subtree.
                if (requested.some(path => !plan.roots.some(root => root === path || root.startsWith(`${path}/`)))) unretained = true;
              }
              return unretained;
            }).immediate();
          };
          const hold: GateHold = { id, mode, get folderPaths() { return folderPaths; }, retainFolders(paths) {
            if (released) throw new Error("Writer folder plan was already released");
            if (unpinnedHost) throw new Error("An unpinned host writer cannot upgrade its folder plan");
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
            if (checkPeerFolderPlans(paths)) throw new Error(UNRETAINED_PEER);
          }, async waitForPeerFolderPlans(paths, { signal, timeoutMs = PEER_FOLDER_PLAN_WAIT_MS } = {}) {
            // Every writer admitted after this hold retained `paths` merges
            // them into its own plan, so only earlier ones can lack them, and
            // their number only falls while this hold is held.
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              signal?.throwIfAborted();
              if (!checkPeerFolderPlans(paths)) return;
              if (Date.now() >= deadline) throw new Error(UNRETAINED_PEER);
              await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
            }
          }, release() {
            if (released) return;
            released = true;
            hostWriterMarkers.delete(hold);
            db.query("DELETE FROM writer_gate WHERE id = ?").run(id);
          } };
          hostWriterMarkers.set(hold, () => {
            if (released) throw new Error("Writer folder plan was already released");
            if (unpinnedHost) return;
            db.transaction(() => {
              prune();
              const own = db.query("SELECT id FROM writer_gate WHERE id = ? AND brain = ? AND pid = ? AND pid_start = ?").get(id, brain, SELF.pid, SELF.start);
              if (!own) throw new Error("Host writer folder plan no longer has its admitted owner");
              const peers = db.query("SELECT folder_topology FROM writer_gate WHERE brain = ? AND id <> ?").all(brain, id) as { folder_topology: string | null }[];
              for (const peer of peers) {
                if (peer.folder_topology === null) throw new Error("Host fallback cannot enter beside an active peer with unknown folder provenance");
                const plan = folderPlan(peer.folder_topology);
                if (!plan.unpinnedHost && (folderPaths.length || plan.roots.length))
                  throw new Error("Host fallback cannot enter beside an active peer that may depend on retained provider folders");
              }
              // Ruling (c) on #2284: no host process starts while folders may
              // be pinned. The current policy is reread inside this transaction.
              refuseHostFallback(policyReader.load(), mergeFolderPlans(peers, folderPaths));
              // Serialize this downgrade against governed admission, before
              // the host process exists. The recorded roots are always empty.
              db.query("UPDATE writer_gate SET folder_topology = ? WHERE id = ?").run(JSON.stringify({ kind: "unpinned_host", roots: folderPaths }), id);
            }).immediate();
            unpinnedHost = true;
          });
          return hold;
        }
        await pause(pollMs, signal);
      } } finally {
        if (waiter) db.query("DELETE FROM writer_gate_turn_waiters WHERE id = ?").run(waiter);
      }
    },
    assertUngatedHostFallback() {
      db.transaction(() => {
        prune();
        const rows = db.query("SELECT folder_topology FROM writer_gate WHERE brain = ?").all(brain) as { folder_topology: string | null }[];
        if (rows.some(row => row.folder_topology === null))
          throw new HostFallbackRefusedError("Host fallback is refused beside an active writer with unknown folder provenance; finish that writer and retry.");
        let roots: readonly string[];
        try { roots = mergeFolderPlans(rows, []); }
        catch { throw new HostFallbackRefusedError("Host fallback is refused beside an active writer with an unverified folder plan; finish that writer and retry."); }
        refuseHostFallback(policyReader.load(), roots);
      }).immediate();
    },
    rememberTypeFolders(policyHash, folders) {
      if (policyHash === null) return;
      const roots = folderPlan(JSON.stringify([...new Set(folders)].sort())).roots;
      db.query("INSERT INTO provider_type_folders (brain, policy_hash, folders, translated_at) VALUES (?, ?, ?, ?) ON CONFLICT (brain) DO UPDATE SET policy_hash = excluded.policy_hash, folders = excluded.folders, translated_at = excluded.translated_at")
        .run(brain, policyHash, JSON.stringify(roots), Date.now());
    },
    holders() {
      return db.transaction(() => {
        prune();
        return db.query("SELECT mode, purpose, pid FROM writer_gate WHERE brain = ? ORDER BY acquired_at").all(brain) as { mode: GateMode; purpose: string; pid: number }[];
      }).immediate();
    },
  };
}
