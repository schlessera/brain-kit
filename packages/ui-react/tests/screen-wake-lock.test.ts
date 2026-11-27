import { afterEach, describe, expect, test } from "bun:test";
import { createScreenWakeLock } from "../src/voice/screen-wake-lock.js";

class FakeWakeLockSentinel extends EventTarget {
  released = false;
  releaseCalls = 0;
  readonly type = "screen" as const;

  async release(): Promise<void> {
    this.releaseCalls++;
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }

  revokeExternally(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const restores: Array<() => void> = [];
function replaceGlobal(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

describe("createScreenWakeLock", () => {
  test("acquires screen wake lock once, deduplicates concurrent calls, re-acquires on visibility return, and cleans up on release", async () => {
    const doc = new FakeDocument();
    const sentinels: FakeWakeLockSentinel[] = [];
    const requestedTypes: string[] = [];

    replaceGlobal(globalThis, "document", doc);
    replaceGlobal(globalThis, "navigator", {
      wakeLock: {
        request: async (type: string) => {
          requestedTypes.push(type);
          const s = new FakeWakeLockSentinel();
          sentinels.push(s);
          return s;
        },
      },
    });

    const lock = createScreenWakeLock();
    lock.acquire();
    lock.acquire();
    await flushMicrotasks();

    expect(requestedTypes).toEqual(["screen"]);
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);

    // Simulate page hidden -> OS releases sentinel -> page visible again.
    doc.setVisibility("hidden");
    sentinels[0]!.revokeExternally();
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);

    doc.setVisibility("visible");
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
    expect(sentinels[1]!.released).toBe(false);

    // Explicit release drops sentinel and detaches visibility listener.
    lock.release();
    await flushMicrotasks();
    expect(sentinels[1]!.released).toBe(true);
    expect(sentinels[1]!.releaseCalls).toBe(1);

    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
  });

  test("immediately releases a sentinel that resolves after release() or after a newer acquire() generation", async () => {
    const doc = new FakeDocument();
    const pending: Array<(s: FakeWakeLockSentinel) => void> = [];

    replaceGlobal(globalThis, "document", doc);
    replaceGlobal(globalThis, "navigator", {
      wakeLock: {
        request: () =>
          new Promise<FakeWakeLockSentinel>((resolve) => {
            pending.push(resolve);
          }),
      },
    });

    const lock = createScreenWakeLock();

    // Case 1: release() before request resolves -> resolved sentinel is immediately released.
    lock.acquire();
    expect(pending).toHaveLength(1);
    lock.release();

    const stale1 = new FakeWakeLockSentinel();
    pending[0]!(stale1);
    await flushMicrotasks();
    expect(stale1.released).toBe(true);
    expect(stale1.releaseCalls).toBe(1);

    // Case 2: acquire() -> release() -> acquire() while first request is still pending.
    lock.acquire();
    expect(pending).toHaveLength(2);
    lock.release();
    lock.acquire();
    expect(pending).toHaveLength(3);

    // Stale request #2 resolves first: must be released and must NOT break request #3.
    const stale2 = new FakeWakeLockSentinel();
    pending[1]!(stale2);
    await flushMicrotasks();
    expect(stale2.released).toBe(true);

    // Current request #3 resolves: must be held until released.
    const current = new FakeWakeLockSentinel();
    pending[2]!(current);
    await flushMicrotasks();
    expect(current.released).toBe(false);

    lock.release();
    await flushMicrotasks();
    expect(current.released).toBe(true);
  });

  test("does not request while document is hidden and acquires once visible", async () => {
    const doc = new FakeDocument();
    doc.visibilityState = "hidden";
    const sentinels: FakeWakeLockSentinel[] = [];

    replaceGlobal(globalThis, "document", doc);
    replaceGlobal(globalThis, "navigator", {
      wakeLock: {
        request: async () => {
          const s = new FakeWakeLockSentinel();
          sentinels.push(s);
          return s;
        },
      },
    });

    const lock = createScreenWakeLock();
    lock.acquire();
    await flushMicrotasks();
    expect(sentinels).toHaveLength(0);

    doc.setVisibility("visible");
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);

    lock.release();
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(true);
  });

  test("degrades silently when navigator.wakeLock is absent or rejects", async () => {
    const doc = new FakeDocument();
    replaceGlobal(globalThis, "document", doc);

    // Missing wakeLock API
    replaceGlobal(globalThis, "navigator", {});
    const unsupported = createScreenWakeLock();
    expect(() => unsupported.acquire()).not.toThrow();
    expect(() => unsupported.release()).not.toThrow();

    // Rejecting wakeLock API (e.g. Low Power Mode)
    let attempts = 0;
    replaceGlobal(globalThis, "navigator", {
      wakeLock: {
        request: async () => {
          attempts++;
          throw new DOMException("Low Power Mode", "NotAllowedError");
        },
      },
    });
    const rejecting = createScreenWakeLock();
    rejecting.acquire();
    await flushMicrotasks();
    expect(attempts).toBe(1);

    // A later visibility return can retry once rejected request settled.
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await flushMicrotasks();
    expect(attempts).toBe(2);

    expect(() => rejecting.release()).not.toThrow();
  });
});
