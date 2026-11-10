/** Disposable broker-local index. Durable JSON intents retain identity authority. */
import { Database } from "bun:sqlite";
import { nativeCheckpointId } from "./native-brain-manager-protocol";

export class NativeRecoveryIndex {
  private db: Database;
  private failed = false;
  private closed = false;
  private diagnostic: { error: unknown } | undefined;

  constructor(ids: Iterable<string>, private readonly reload?: () => Iterable<string>,
    private readonly report?: (error: unknown) => void) {
    this.db = this.build(ids);
  }

  private build(ids: Iterable<string>): Database {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE identities (id TEXT PRIMARY KEY) WITHOUT ROWID");
      const insert = db.query("INSERT OR IGNORE INTO identities (id) VALUES (?)");
      db.transaction(() => {
        for (const id of ids) {
          if (!nativeCheckpointId.safeParse(id).success) throw Error("Invalid native recovery identity.");
          insert.run(id);
        }
      })();
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private rebuild(): void {
    if (!this.reload) throw Error("Native recovery index is unavailable; restart the manager to rebuild it.");
    // Publish only a complete replacement. A refused rebuild leaves admission
    // closed, and the next operation retries without needing a process restart.
    // If recording itself failed, keep the original cause and retry it before
    // reopening admission. A later successful rebuild cannot erase that cause.
    if (this.diagnostic) { this.report?.(this.diagnostic.error); this.diagnostic = undefined; }
    try {
      const replacement = this.build(this.reload());
      this.db.close(); this.db = replacement; this.failed = false;
    } catch (error) {
      this.failed = true; this.diagnostic = { error };
      try { this.report?.(error); this.diagnostic = undefined; } catch { /* Retry the durable cause before admission. */ }
      throw error;
    }
  }

  private use<T>(operation: () => T): T {
    if (this.closed) throw Error("Native recovery index is closed.");
    if (this.failed) this.rebuild();
    try { return operation(); }
    catch (error) {
      this.failed = true; this.diagnostic = { error };
      this.rebuild();
      try { return operation(); }
      catch (again) { this.failed = true; this.diagnostic = { error: again }; throw again; }
    }
  }

  /** Dependent admission waits for a complete rebuild after any failed write. */
  ensureAvailable(): void {
    if (this.closed) throw Error("Native recovery index is closed.");
    if (this.failed) this.rebuild();
  }

  /** Called only after the JSON rename and parent-directory fsync complete. */
  remember(id: string): void {
    if (!nativeCheckpointId.safeParse(id).success) { this.failed = true; throw Error("Invalid native recovery identity."); }
    this.use(() => { this.db.query("INSERT OR IGNORE INTO identities (id) VALUES (?)").run(id); });
  }

  /** Called only after the JSON intent was removed and its directory synced. */
  forget(id: string): void {
    this.use(() => { this.db.query("DELETE FROM identities WHERE id = ?").run(id); });
  }

  /** 64 response candidates and one lookahead; only recovery scans history. */
  page(after: string | null): string[] {
    if (after !== null && !nativeCheckpointId.safeParse(after).success) throw Error("Invalid native recovery cursor.");
    return this.use(() => this.db.query<{ id: string }, [string]>("SELECT id FROM identities WHERE id > ? ORDER BY id LIMIT 65")
      .all(after ?? "").map(row => row.id));
  }

  close(): void { this.closed = true; this.db.close(); }
}
