import { describe, expect, test } from "bun:test";
import { createKeyedLock, LockBusyError } from "../src/server/keyed-lock.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createKeyedLock", () => {
  test("same key serializes FIFO", async () => {
    const lock = createKeyedLock();
    const order: number[] = [];
    const r1 = await lock.acquire("k");
    const p2 = lock.acquire("k").then((r) => {
      order.push(2);
      return r;
    });
    const p3 = lock.acquire("k").then((r) => {
      order.push(3);
      return r;
    });
    await tick();
    expect(order).toEqual([]); // both parked behind the holder
    r1();
    (await p2)();
    (await p3)();
    expect(order).toEqual([2, 3]);
    expect(lock.locked).toBe(false);
  });

  test("different keys are fully independent", async () => {
    const lock = createKeyedLock();
    const ra = await lock.acquire("a");
    const rb = await lock.acquire("b"); // resolves immediately despite "a" held
    expect(lock.heldKeys.sort()).toEqual(["a", "b"]);
    ra();
    rb();
    expect(lock.heldKeys).toEqual([]);
  });

  test("double release is a no-op and cannot free the next holder's slot", async () => {
    const lock = createKeyedLock();
    const r1 = await lock.acquire("k");
    const p2 = lock.acquire("k");
    r1();
    r1(); // second call must not shift the new holder off the queue
    const r2 = await p2;
    expect(lock.locked).toBe(true);
    r2();
    expect(lock.locked).toBe(false);
  });

  test("a bounded wait rejects LockBusyError and leaves the queue intact", async () => {
    const lock = createKeyedLock();
    const r1 = await lock.acquire("k");
    const bounded = lock.acquire("k", { timeoutMs: 10 });
    const patient = lock.acquire("k"); // enqueued AFTER the bounded waiter
    await expect(bounded).rejects.toBeInstanceOf(LockBusyError);
    // The timed-out waiter left the queue: releasing grants the patient one,
    // not a dead slot.
    r1();
    const r3 = await patient;
    expect(lock.locked).toBe(true);
    r3();
    expect(lock.locked).toBe(false);
  });

  test("a waiter granted before its timeout keeps the lock (timer is disarmed)", async () => {
    const lock = createKeyedLock();
    const r1 = await lock.acquire("k");
    const p2 = lock.acquire("k", { timeoutMs: 30 });
    r1(); // grant well before the timer
    const r2 = await p2;
    await new Promise((r) => setTimeout(r, 40)); // outlive the timeout window
    expect(lock.locked).toBe(true); // still held — no late rejection fired
    r2();
  });

  test("an uncontended bounded acquire resolves immediately", async () => {
    const lock = createKeyedLock();
    const release = await lock.acquire("k", { timeoutMs: 1 });
    expect(lock.locked).toBe(true);
    release();
  });

  test("withLock releases on throw", async () => {
    const lock = createKeyedLock();
    await expect(
      lock.withLock("k", () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(lock.locked).toBe(false);
  });

  test("LockBusyError names the key and the wait", async () => {
    const lock = createKeyedLock();
    const release = await lock.acquire("repo-git");
    try {
      await lock.acquire("repo-git", { timeoutMs: 5 });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(LockBusyError);
      expect((err as LockBusyError).key).toBe("repo-git");
      expect((err as LockBusyError).waitedMs).toBe(5);
    } finally {
      release();
    }
  });
});
