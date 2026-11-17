import type { Database } from "bun:sqlite";
export const url = import.meta.url;
export function setup(db: Database) {
  return {
    level() { return (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous; },
    hold(entered: Int32Array, release: Int32Array) {
      return db.transaction(() => {
        Atomics.store(entered, 0, 1); Atomics.notify(entered, 0);
        if (Atomics.wait(release, 0, 0, 5000) === "timed-out") throw new Error("Publication fixture release timed out");
        return true;
      }).immediate();
    },
  };
}
