import type { Database } from "bun:sqlite";
export const url = import.meta.url;
export function setup(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS ithaca_receipt_barrier (value INTEGER)");
  return {
    // An unrelated write: idle and read snapshots must finish before release.
    hold(gate: Int32Array, watchdogMs: number) {
      try {
        db.transaction(() => {
          db.query("INSERT INTO ithaca_receipt_barrier VALUES (1)").run();
          Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
          Atomics.wait(gate, 1, 0, watchdogMs);
        }).immediate();
      } finally { Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); }
    },
  };
}
