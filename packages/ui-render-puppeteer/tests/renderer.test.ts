import { describe, expect, test } from "bun:test";

import { shouldAllowRequest } from "../src/renderer";
import { Semaphore } from "../src/semaphore";

describe("shouldAllowRequest (default network policy)", () => {
  test("allows inline data: assets and the setContent document", () => {
    expect(shouldAllowRequest("data:image/png;base64,AAAA")).toBe(true);
    expect(shouldAllowRequest("about:blank")).toBe(true);
  });

  test("denies every network / filesystem scheme", () => {
    for (const url of [
      "https://example.com/pixel.png",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata SSRF
      "http://localhost:3000/api/status",
      "ws://localhost:3000/ws",
      "file:///etc/passwd",
      "blob:null/abc",
      "about:srcdoc",
      "chrome://settings",
    ]) {
      expect(shouldAllowRequest(url)).toBe(false);
    }
  });
});

describe("Semaphore", () => {
  test("bounds concurrency and wakes queued waiters in order", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();

    const entered: string[] = [];
    const p3 = sem.acquire().then((release) => {
      entered.push("third");
      return release;
    });
    const p4 = sem.acquire().then((release) => {
      entered.push("fourth");
      return release;
    });
    // Drain continuations without a wall-clock delay. Both slots stay held.
    const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
    await drain();
    expect(entered).toEqual([]);

    r1();
    await drain();
    // Assert before awaiting p3 so a LIFO regression fails instead of hanging.
    expect(entered).toEqual(["third"]);
    const r3 = await p3;
    await drain();
    expect(entered).toEqual(["third"]); // fourth is still blocked

    r3();
    await drain();
    expect(entered).toEqual(["third", "fourth"]);
    const r4 = await p4;

    r2();
    r4();
    // Recover both slots simultaneously, then prove no third slot was minted.
    const recovered1 = await sem.acquire();
    const recovered2 = await sem.acquire();
    let extra = false;
    const pending = sem.acquire().then((release) => {
      extra = true;
      return release;
    });
    await drain();
    expect(extra).toBe(false);
    recovered1();
    (await pending)();
    recovered2();
  });

  test("double-release is a no-op", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release(); // must not mint an extra slot
    const r2 = await sem.acquire();
    let third = false;
    const p = sem.acquire().then((r) => {
      third = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(third).toBe(false); // still only one slot
    r2();
    (await p)();
  });
});
