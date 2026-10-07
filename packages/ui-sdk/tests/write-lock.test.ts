import { describe, expect, test } from "bun:test";

import { createWriteLock } from "../src/server/write-lock";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createWriteLock", () => {
  test("serializes holders FIFO", async () => {
    const lock = createWriteLock();
    const order: string[] = [];

    const a = lock.withLock(async () => {
      order.push("a-start");
      await tick();
      await tick();
      order.push("a-end");
    });
    const b = lock.withLock(async () => {
      order.push("b-start");
      await tick();
      order.push("b-end");
    });
    const c = lock.withLock(() => {
      order.push("c");
    });

    await Promise.all([a, b, c]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end", "c"]);
  });

  test("releases on throw; later holders still run", async () => {
    const lock = createWriteLock();
    await expect(
      lock.withLock(() => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const ran = await lock.withLock(() => "after");
    expect(ran).toBe("after");
    expect(lock.locked).toBe(false);
  });

  test("manual acquire/release; double release is a no-op", async () => {
    const lock = createWriteLock();
    const release = await lock.acquire();
    expect(lock.locked).toBe(true);

    let finishSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { finishSecond = resolve; });
    let secondRan = false;
    const second = lock.withLock(async () => {
      secondRan = true;
      await secondGate;
    });
    await tick();
    expect(secondRan).toBe(false); // blocked while held

    release();
    release(); // no-op
    await tick();
    expect(secondRan).toBe(true);
    expect(lock.locked).toBe(true); // the second holder survives the duplicate release
    finishSecond();
    await second;
    expect(lock.locked).toBe(false);
  });
});
