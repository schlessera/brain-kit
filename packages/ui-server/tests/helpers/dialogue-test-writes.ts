import type { Database } from "bun:sqlite";
export const url = import.meta.url;
/** Native failure controls confined to the fixture's own database worker. */
export function setup(db: Database) {
  return {
    holdUntilReleased(control: Int32Array) {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      while (!Atomics.load(control, 0)) Atomics.wait(control, 0, 0);
    },
    quota() {
      const row = db.query("PRAGMA page_count").get() as { page_count: number };
      db.exec(`PRAGMA max_page_count=${row.page_count + 2}`);
    },
    refuseOpen() {
      db.exec("CREATE TRIGGER refuse_dialogue_open BEFORE INSERT ON dialogue_conversations WHEN NEW.id='ithaca' BEGIN SELECT RAISE(ABORT,'R8 open refused'); END");
    },
    loseCloseMarker(id:string) { db.prepare("UPDATE dialogue_conversations SET closed=0 WHERE id=?").run(id); },
    allowOpen() { db.exec("DROP TRIGGER refuse_dialogue_open"); },
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
