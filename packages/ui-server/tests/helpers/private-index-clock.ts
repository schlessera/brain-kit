import type { PrivateIndexTimers } from "../../src/brain/private-index-cache";

/**
 * A test clock passed to the private index cache as its `now` and `timers`
 * options (#4852). The cache's idle timers register here and fire only when
 * `advance` delivers them; native IO and test deadlines keep running.
 */
export function privateIndexClock() {
  type Handle = ReturnType<typeof setTimeout>;
  const pending = new Map<Handle, { due: number; callback: () => void }>();
  let now = Date.parse("2026-07-12T00:00:00Z"), registrations = 0;
  const timers: PrivateIndexTimers = {
    setTimeout(callback, delay) {
      if (++registrations > 32) throw new Error("private-index timer registration budget exceeded");
      const handle = {} as Handle;
      pending.set(handle, { due: now + delay, callback });
      return handle;
    },
    clearTimeout(handle) {
      if (handle !== undefined) pending.delete(handle);
    },
  };
  return {
    /** What the cache under test is built with. */
    options: { now: () => now, timers },
    deadlines: () => [...pending.values()].map(timer => timer.due).sort((a, b) => a - b),
    get now() { return now; },
    async advance(ms: number) {
      const target = now + ms;
      for (let delivered = 0; ; delivered++) {
        const next = [...pending].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        if (delivered >= 32) throw new Error("private-index timer delivery budget exceeded");
        const [handle, timer] = next;
        now = timer.due;
        pending.delete(handle);
        timer.callback();
        // Fixture checkpoint release is synchronous; drain trim's promise chain
        // before delivering another callback or inspecting its released views.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      now = target;
    },
    /** Drop every timer still pending; nothing global was replaced. */
    restore() {
      pending.clear();
    },
  };
}
