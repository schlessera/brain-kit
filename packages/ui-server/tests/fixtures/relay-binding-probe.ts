import type { Database } from "bun:sqlite";
export const url = import.meta.url;
export function setup(db: Database) {
  return {
    hold(gate: Int32Array, entered: Int32Array) {
      db.transaction(() => {
        Atomics.store(entered, 0, 1); Atomics.notify(entered, 0);
        if (Atomics.wait(gate, 0, 0, 5000) === "timed-out") throw new Error("BINDING_PROBE_RELEASE_REQUIRED");
      }).immediate();
    },
    committed(done: Int32Array) { Atomics.store(done, 0, 1); Atomics.notify(done, 0); },
  };
}
