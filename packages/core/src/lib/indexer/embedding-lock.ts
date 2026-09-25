import { Database } from "bun:sqlite";
import { realpathSync } from "fs";

const memoryLocks = new WeakSet<Database>();

/**
 * One billable index run per database, across CLI/MCP processes. SQLite owns
 * the OS lock on a separate, empty sidecar, so a crash releases it without
 * stale PID records or lease timers. The content database stays writable
 * while the provider is away. Never unlink the sidecar: waiters must keep
 * addressing the same inode. It contains no authoritative state.
 */
/** Another embeddings run holds the lock on this database. */
export class EmbeddingRunActiveError extends Error {
  constructor() {
    super("An embedding index run is already active; retry when it finishes");
    this.name = "EmbeddingRunActiveError";
  }
}

export function acquireEmbeddingLock(db: Database): () => void {
  const busy = () => new EmbeddingRunActiveError();
  let lock: Database | undefined;
  if (!db.filename || db.filename === ":memory:") {
    if (memoryLocks.has(db)) throw busy();
    memoryLocks.add(db);
  } else {
    lock = new Database(`${realpathSync(db.filename)}.embedding-lock.db`, { create: true });
    try {
      lock.run("PRAGMA busy_timeout=0");
      lock.run("BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      if ((error as { code?: string }).code === "SQLITE_BUSY") throw busy();
      throw error;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock?.close();
    memoryLocks.delete(db);
  };
}
