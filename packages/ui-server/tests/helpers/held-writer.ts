/**
 * Hold the real `ui.db` write worker, see when a named procedure has been
 * posted to it behind the hold, and change rows from another connection while
 * it waits, as a concurrent request would (#4169, #4176).
 */
import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import type { SqliteWriter } from "../../src/db/write-worker.js";
import * as controls from "./dialogue-test-writes.js";

export async function heldWriter(writer: SqliteWriter, path: string) {
  const control = writer.channel({ url: controls.url, setup: controls.setup }, {});
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const restores: (() => void)[] = [];
  let held: Promise<unknown> | undefined;
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
  return {
    /** Resolves once the worker is inside the hold; a released hold can be taken again. */
    async hold() {
      await held;
      Atomics.store(gate, 0, 0); Atomics.store(gate, 1, 0);
      held = control.call("holdUntilReleased", gate);
      const deadline = Date.now() + 2000;
      while (!Atomics.load(gate, 1)) { if (Date.now() > deadline) throw Error("Ithaca writer did not hold"); await Bun.sleep(1); }
    },
    /** Resolves once every one of `names` has been posted to the worker, where they queue behind the hold. */
    posted(...names: string[]): Promise<void> {
      const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage")!, send = Worker.prototype.postMessage;
      const waiting = new Set(names);
      let seen!: () => void;
      const sent = new Promise<void>(resolve => { seen = resolve; });
      let restored = false;
      const restore = () => { if (restored) return; restored = true; spy.mockRestore(); Object.defineProperty(Worker.prototype, "postMessage", descriptor); };
      const spy = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: [message: unknown, options?: StructuredSerializeOptions | Transferable[]]) {
        const message = args[0] as { kind?: string; name?: string };
        const result = Reflect.apply(send, this, args);
        if (message.kind === "call" && message.name !== undefined && waiting.delete(message.name) && waiting.size === 0) { restore(); seen(); }
        return result;
      });
      restores.push(restore);
      return sent;
    },
    /** Change rows from another connection while the writer is held. */
    elsewhere(change: (other: Database) => void) {
      const other = new Database(path); other.exec("PRAGMA busy_timeout = 5000");
      try { change(other); } finally { other.close(); }
    },
    /**
     * Expire `principalId` one millisecond after the latest stamp the request
     * could have taken, then let the clock pass it: usable at the stamp, expired
     * when the held writer takes its turn. Returns that latest possible stamp.
     */
    async expireWhileQueued(principalId: string): Promise<number> {
      const stamped = Date.now();
      this.elsewhere(other => other.query("UPDATE principals SET expires_at = ? WHERE id = ?").run(stamped + 1, principalId));
      while (Date.now() <= stamped + 1) await Bun.sleep(1);
      return stamped;
    },
    release,
    async close() {
      release();
      for (const restore of restores.splice(0).reverse()) restore();
      await held; await control.close();
    },
  };
}
