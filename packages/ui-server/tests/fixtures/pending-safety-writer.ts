/** Holds one real writer's procedure without a SQLite lock, leaving peer writers usable. */
export const url = import.meta.url;
export function setup() {
  return { hold(entered:Int32Array,release:Int32Array,watchdog:number) {
    Atomics.store(entered,0,1);Atomics.notify(entered,0);
    if(Atomics.wait(release,0,0,watchdog)==="timed-out")throw new Error("Pending safety writer fixture was not released");
  } };
}
