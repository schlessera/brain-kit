/** Disposable kernel locks describe live attempts; the UI DB owns accounting. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const memoryRuns = new WeakMap<Database, Set<string>>();

function guardPath(db: Database, runId: string): string | null {
  if (!db.filename || db.filename === ":memory:") return null;
  const directory = `${realpathSync(db.filename)}.inbox-live`;
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error("Inbox lifetime directory is redirected");
  return join(directory, `${createHash("sha256").update(runId).digest("hex")}.sqlite`);
}

/** An exclusive probe cannot succeed while the attempt holds its kernel lock.
 * Rollback-mode SQLite locks work between connections and processes. A killed
 * owner loses the kernel lock even if its file, Activity root and receipt remain.
 * See https://www.sqlite.org/lockingv3.html#locking. Never infer life from a PID,
 * an unexpired Queue lease, an open Activity root or the existence of this file.
 */
export function inboxRunIsLive(db: Database, runId: string): boolean {
  const path = guardPath(db, runId);
  if (!path) return memoryRuns.get(db)?.has(runId) ?? false;
  if (!existsSync(path)) return false;
  if (!lstatSync(path).isFile()) throw new Error("Inbox lifetime guard is not a regular file");
  let probe: Database | undefined;
  try {
    probe = new Database(path, { readwrite: true, create: false });
    probe.exec("PRAGMA busy_timeout = 0");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") return true;
    // Normal completion can remove its disposable guard between our stat/open.
    if (!existsSync(path)) return false;
    throw error;
  } finally { probe?.close(); }
}

/** Kernel ownership starts before budget acquisition and lasts through unwind.
 * This separate lock never holds the operational database's write lock
 * across asynchronous work. Its file contains no authoritative state and is
 * deliberately absent from operational backups: restored workers are lost.
 */
export function acquireInboxRunLifetime(db: Database, runId: string) {
  const path = guardPath(db, runId);
  if (!path) {
    let runs = memoryRuns.get(db);
    if (!runs) memoryRuns.set(db, runs = new Set());
    if (runs.has(runId)) throw new Error("Autonomous attempt is already live");
    runs.add(runId);
    return { release: () => { runs.delete(runId); }, close: () => { runs.delete(runId); } };
  }
  mkdirSync(`${realpathSync(db.filename)}.inbox-live`, { recursive: true, mode: 0o700 });
  let owner: Database | undefined, acquired = false;
  try {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(path).isFile()) throw new Error("Inbox lifetime guard is not a regular file");
    owner = new Database(path, { readwrite: true });
    owner.exec("PRAGMA busy_timeout = 0");
    owner.exec("PRAGMA journal_mode = DELETE");
    owner.exec("CREATE TABLE IF NOT EXISTS lifetime (id INTEGER PRIMARY KEY)");
    owner.exec("INSERT OR IGNORE INTO lifetime VALUES (1)");
    // Exclusive ownership also prevents a refused duplicate start from
    // acquiring a second shared handle and deleting the live owner's name.
    owner.exec("BEGIN EXCLUSIVE");
    owner.query("SELECT id FROM lifetime").get();
    acquired = true;
    const release = () => { owner?.close(); owner = undefined; };
    return { release, close: () => { release(); rmSync(path, { force: true }); } };
  } catch (error) {
    owner?.close();
    if (acquired) rmSync(path, { force: true });
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error("Autonomous attempt is already live");
    throw error;
  }
}

/** Status retirement cannot end an acquired attempt or erase unsettled spend. */
export function inboxThreadAwaitingSettlement(db: Database, threadId: string): boolean {
  const rows = db.query(`SELECT r.run_id, r.status FROM inbox_budget_reservations r
    JOIN inbox_items i ON i.id = r.item_id WHERE i.thread_id = ?
    AND r.runtime_acquired_at IS NOT NULL AND r.run_id IS NOT NULL`)
    .all(threadId) as { run_id: string; status: string }[];
  return rows.some(row => row.status === "active" || inboxRunIsLive(db, row.run_id));
}

/** Dead attempts' disposable files are reaped with compensation, outside the
 * operational write transaction. Their frozen accounting and receipts remain. */
export function reapInboxThreadLifetimes(db: Database, threadId: string): void {
  const rows = db.query(`SELECT r.run_id FROM inbox_budget_reservations r
    JOIN inbox_items i ON i.id = r.item_id WHERE i.thread_id = ?
    AND r.status != 'active' AND r.runtime_acquired_at IS NOT NULL AND r.run_id IS NOT NULL`)
    .all(threadId) as { run_id: string }[];
  for (const { run_id } of rows) {
    if (inboxRunIsLive(db, run_id)) continue;
    const path = guardPath(db, run_id);
    if (path) rmSync(path, { force: true });
  }
}
