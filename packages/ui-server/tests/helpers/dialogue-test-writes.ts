import type { Database } from "bun:sqlite";
export const url = import.meta.url;
/** Native failure controls confined to the fixture's own database worker. */
export function setup(db: Database) {
  return {
    quota() {
      const row = db.query("PRAGMA page_count").get() as { page_count: number };
      db.exec(`PRAGMA max_page_count=${row.page_count + 2}`);
    },
    refuseClose() {
      db.exec("CREATE TRIGGER refuse_dialogue_close BEFORE UPDATE OF closed ON dialogue_conversations WHEN NEW.closed=1 BEGIN SELECT RAISE(ABORT,'R7 close refused'); END");
    },
    allowClose() { db.exec("DROP TRIGGER refuse_dialogue_close"); },
    hold(control: Int32Array) {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      Atomics.wait(control, 0, 0, 5000);
    },
  };
}
