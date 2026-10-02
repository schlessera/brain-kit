import { expect, test } from "bun:test";
import { createKeyedLock, LockBusyError } from "../src/server/keyed-lock.js";

function clock() {
  let at = 0, sequence = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => at,
    setTimeout(fn: () => void, ms: number) {
      const id = ++sequence;
      pending.set(id, { at: at + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id: ReturnType<typeof setTimeout>) { pending.delete(id as unknown as number); },
    advance(ms: number) {
      const until = at + ms;
      for (;;) {
        const next = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        at = next[1].at; pending.delete(next[0]); next[1].fn();
      }
      at = until;
    },
    size: () => pending.size,
  };
}

test("a contended autonomous holder yields once at 20s, and interactive work wins before the 30s denial", async () => {
  const time = clock(), lock = createKeyedLock(time);
  let signals = 0;
  let release!: () => void;
  release = await lock.acquire("path:harbor", { priority: "autonomous", onYield: () => { signals++; release(); } });
  // This autonomous request predates both interactive waiters. Priority, as
  // well as yield, is necessary: it would otherwise hold until their timeout.
  const background = lock.acquire("path:harbor", { priority: "autonomous" });
  const first = lock.acquire("path:harbor", { timeoutMs: 30_000 });
  const second = lock.acquire("path:harbor", { timeoutMs: 30_000 });
  const secondOutcome = second.then((free) => free, () => undefined);
  const acquired = first.then((free) => { free(); return "acquired"; }, (error) => error instanceof LockBusyError ? "denied" : "other-error");
  time.advance(19_999); expect(signals).toBe(0);
  time.advance(1);
  // Let the acquired interactive request release before advancing the clock.
  await Promise.resolve(); await Promise.resolve();
  time.advance(10_000);
  try {
    expect(await acquired).toBe("acquired");
    expect(signals).toBe(1);
  } finally {
    release(); (await secondOutcome)?.(); (await background)();
  }
  expect(lock.locked).toBe(false); expect(time.size()).toBe(0);
});

test("short holders and unrelated keys never yield", async () => {
  const time = clock(), lock = createKeyedLock(time); let signals = 0;
  const release = await lock.acquire("path:harbor", { priority: "autonomous", onYield: () => signals++ });
  const other = await lock.acquire("path:raft"); other();
  time.advance(30_000); expect(signals).toBe(0);
  const waiting = lock.acquire("path:harbor", { timeoutMs: 30_000 });
  time.advance(19_999); release(); (await waiting)();
  time.advance(30_000); expect(signals).toBe(0); expect(time.size()).toBe(0);
});

test("cancelled waiters cannot signal a holder or execute later", async () => {
  const time = clock(), lock = createKeyedLock(time); let signals = 0, executed = false;
  const release = await lock.acquire("path:harbor", { priority: "autonomous", onYield: () => signals++ });
  const controller = new AbortController();
  const pending = lock.withLock("path:harbor", () => { executed = true; }, { signal: controller.signal, timeoutMs: 30_000 });
  const rejected = pending.catch((error) => error);
  time.advance(19_999); controller.abort(); time.advance(30_000); release();
  expect((await rejected).name).toBe("AbortError");
  expect(executed).toBe(false); expect(signals).toBe(0); expect(time.size()).toBe(0);
});
