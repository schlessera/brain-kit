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

    let third = false;
    const p3 = sem.acquire().then((r) => {
      third = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(third).toBe(false); // both slots held

    r1();
    const r3 = await p3;
    expect(third).toBe(true);

    r2();
    r3();
    // All slots free again: two immediate acquires succeed.
    (await sem.acquire())();
    (await sem.acquire())();
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
