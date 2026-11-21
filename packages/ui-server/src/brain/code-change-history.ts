/** Owner-confirmed checkout restoration; one durable identity, never a blind retry. */
import type { Database } from "bun:sqlite";
import type { CodeChangeReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { runMaintenanceWorker, prepareNativeWorkerStartupView, type MaintenanceHost, type createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { GIT_LOCK_KEY } from "@schlessera/brain-ui-sdk/internal";
import type { HostBoundary } from "./host-boundary.js";
import type { WriterGate } from "./writer-gate.js";
import type { TurnJournal } from "./turn-journal.js";
import type { ReferenceWorktrees } from "./reference-worktrees.js";
import { journalStatement } from "./journal-store.js";
import { processAlive, SELF } from "./writer-gate.js";
import { CODE_CHANGE_PROGRAM } from "./code-change-program.js";
import { CODE_CHECKOUT_BYTES } from "./code-change-worker.js";

type Result = { id: string; status: "restored" | "conflict" | "unknown" | "failed"; current?: Omit<CodeChangeReceipt, "checkout" | "state">; expected?: string; currentPreview?: { inline: boolean; diff?: string; reason?: string }; error?: string };
type Row = { id: string; principal_id: string; session_id: string; turn_id: string; checkout: string; state: string; result: string | null; pid: number; pid_start: string };
export function createCodeChangeHistory(db: Database, options: {
  brainPath: string; journal: TurnJournal; gate: WriterGate; lock: KeyedLock; boundary: HostBoundary;
  nativeManager: ReturnType<typeof createNativeBrainManagerClient>; maintenance: MaintenanceHost;
  worktrees?: ReferenceWorktrees; isAuthorized(principalId: string): boolean;
}) {
  const { journal } = options;
  const pending = new Map<string, Promise<Result>>();
  function read(id: string, principalId: string, sessionId: string, turnId: string): Result | null {
    const row = db.query("SELECT * FROM turn_journal_code_reverts WHERE id=? AND principal_id=? AND session_id=? AND turn_id=?").get(id, principalId, sessionId, turnId) as Row | null;
    if (!row) return null;
    if (row.result) return JSON.parse(row.result) as Result;
    return { id, status: "unknown", error: processAlive(row.pid, row.pid_start) ? "Operation is still settling; read this identity again." : "Interrupted restoration; review the checkout before another action." };
  }
  async function revert(id: string, principalId: string, sessionId: string, turnId: string, checkout: string): Promise<Result> {
    if (pending.has(id)) { await pending.get(id); return revert(id, principalId, sessionId, turnId, checkout); }
    const existing = db.query("SELECT * FROM turn_journal_code_reverts WHERE id=?").get(id) as Row | null;
    if (existing) {
      if (existing.principal_id !== principalId || existing.session_id !== sessionId || existing.turn_id !== turnId || existing.checkout !== checkout) throw Error("History operation identity belongs to another selection");
      return pending.get(id) ?? read(id, principalId, sessionId, turnId)!;
    }
    const work = perform(id, principalId, sessionId, turnId, checkout);
    pending.set(id, work);
    try { return await work; } finally { pending.delete(id); }
  }
  async function perform(id: string, principalId: string, sessionId: string, turnId: string, checkout: string): Promise<Result> {
    const hold = await options.gate.acquire("exclusive", `code-revert:${id}`, { queueTurns: true });
    let recorded = false;
    try {
      return await options.lock.withLock(BRAIN_LOCK_KEY, () => options.lock.withLock(GIT_LOCK_KEY, () => journal.withCodeEvidence(sessionId, turnId, checkout, async (receipt, pack) => {
        if (!["interactive", "user"].includes(journal.summary(turnId).actor ?? "")) throw Error("This turn is not available for a user history operation.");
        if (!options.isAuthorized(principalId) || receipt.state !== "complete" || journal.summary(turnId).state === "recording") throw Error("A current owner and a completed checkout receipt are required");
        // A lost response or process death leaves this operation unknown. Reusing
        // its identity can only read it, never dispatch its filesystem effect again.
        const started = JSON.stringify({ id, status: "unknown", error: "Operation started; reconcile this original identity before another action.".padEnd(512) });
        await journal.writeOperation([journalStatement("INSERT INTO turn_journal_code_reverts VALUES (?,?,?,?,?,'applying',?,?,?)", id, principalId, sessionId, turnId, checkout, started, SELF.pid, SELF.start)]);
        recorded = true;
        const request = JSON.stringify({ ...receipt, pack, operation: "revert", expected_tree: receipt.tree_after });
        let result: { stdout: string; stderr: string; exitCode: number; timedOut?: boolean; killed?: boolean };
        if (checkout.startsWith("reference-worktree://")) {
          if (!options.worktrees) throw Error("The reference pool is unavailable");
          const worktreeId = checkout.slice("reference-worktree://".length).replace(/\/$/, "");
          result = await options.worktrees.withHistoryCheckout(worktreeId, principalId, async (path, allowanceBytes) => {
            const startupView = await prepareNativeWorkerStartupView(options.brainPath, options.nativeManager);
            try { return await runMaintenanceWorker({ ...options.maintenance, brainPath: options.brainPath, startupView, credentials: false,
              env: { PATH: "/usr/bin:/bin" }, command: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, path, String(allowanceBytes)],
              readPaths: [path], writeDirectories: [path], stdin: request, tempKind: "git", timeoutMs: 60_000, outputBytes: 2 * 1024 * 1024 }, () => {
                if (!options.isAuthorized(principalId)) throw Error("Owner authorization changed");
              });
            } finally { await startupView.cleanup(); }
          });
        } else {
          if (!/^workspaces\/[^/\\\u0000]+$/.test(checkout) || checkout.endsWith("/..")) throw Error("Invalid checkout receipt identity");
          result = await options.boundary.run({ credentials: false, gate: "none", purpose: "code-revert", env: { PATH: "/usr/bin:/bin" },
            argv: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, `@output/${checkout}`, String(CODE_CHECKOUT_BYTES)],
            stdin: request, timeoutMs: 60_000, outputBytes: 2 * 1024 * 1024, outputAreas: [checkout],
            assertAuthorized() { if (!options.isAuthorized(principalId)) throw Error("Owner authorization changed"); } });
        }
        if (result.exitCode !== 0 || result.timedOut || result.killed) throw Error("Checkout restoration did not complete; review partial work");
        const outcome = JSON.parse(result.stdout) as Result;
        if (!["restored", "conflict"].includes(outcome.status)) throw Error("Invalid checkout restoration result");
        const response = { ...outcome, id };
        await journal.writeOperation([journalStatement("UPDATE turn_journal_code_reverts SET state='complete',result=? WHERE id=?", JSON.stringify(response), id)]);
        return response;
      })));
    } catch (error) {
      if (!recorded) throw error;
      const result: Result = { id, status: "unknown", error: `code-change-history.perform: ${error instanceof Error ? error.name : "UnknownError"}: ${String(error).slice(0, 256)}` };
      await journal.writeOperation([journalStatement("UPDATE turn_journal_code_reverts SET state='unknown',result=? WHERE id=?", JSON.stringify(result), id)]);
      return result;
    } finally { await hold.release(); }
  }
  return { read, revert, async settled() { await Promise.allSettled([...pending.values()]); } };
}
export type CodeChangeHistory = ReturnType<typeof createCodeChangeHistory>;
