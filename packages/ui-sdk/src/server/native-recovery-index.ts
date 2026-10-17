/** Disposable broker-local index. Durable JSON intents retain identity authority. */
import { Database } from "bun:sqlite";
import { nativeCheckpointId } from "./native-brain-manager-protocol";

export class NativeRecoveryIndex {
  private readonly db = new Database(":memory:");
  private readonly insert;
  private readonly select;
  private failed = false;

  constructor(ids: Iterable<string>) {
    try {
      this.db.exec("CREATE TABLE identities (id TEXT PRIMARY KEY) WITHOUT ROWID");
      this.insert = this.db.query("INSERT OR IGNORE INTO identities (id) VALUES (?)");
      this.select = this.db.query<{ id: string }, [string]>("SELECT id FROM identities WHERE id > ? ORDER BY id LIMIT 65");
      this.db.transaction(() => { for (const id of ids) this.remember(id); })();
    } catch (error) { this.db.close(); throw error; }
  }

  /** Called only after the JSON rename and parent-directory fsync complete. */
  remember(id: string): void {
    try {
      if (this.failed || !nativeCheckpointId.safeParse(id).success) throw Error("Native recovery index is unavailable; restart the manager to rebuild it.");
      this.insert.run(id);
    } catch (error) { this.failed = true; throw error; }
  }

  /** 64 response candidates and one lookahead; no complete-history scan. */
  page(after: string | null): string[] {
    if (this.failed) throw Error("Native recovery index is unavailable; restart the manager to rebuild it.");
    if (after !== null && !nativeCheckpointId.safeParse(after).success) throw Error("Invalid native recovery cursor.");
    return this.select.all(after ?? "").map(row => row.id);
  }

  close(): void { this.db.close(); }
}
