import { describe, expect, test } from "bun:test";

import { createRenderer, hostRequestAllowed, shouldAllowRequest } from "../src/renderer";
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
    // Drain continuations without a wall-clock delay, as above.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(third).toBe(false); // still only one slot
    r2();
    (await p)();
  });
});

describe("the image host allowlist (#2496)", () => {
  // Each entry becomes one `EXCLUDE` in Chrome's DNS blackhole. A wildcard, a
  // comma or anything but a plain host would widen or rewrite that rule.
  for (const bad of ["*", "a.test, MAP * 10.0.0.1", "a.test b.test", "https://a.test", "a.test:8080", "a,b.test", "*.ithaca.test", "a.test/path", ""]) {
    test(`createRenderer refuses ${JSON.stringify(bad)} before any launch`, () => {
      let launches = 0;
      expect(() => createRenderer({ allowHosts: [bad], executablePath: "/fake/chrome", launch: (async () => { launches++; throw new Error("no browser"); }) as never }))
        .toThrow("not a plain host name or IP address");
      expect(launches).toBe(0);
    });
  }

  test("a valid list becomes exactly one EXCLUDE per entry in the blackhole, and no other rule", async () => {
    const seen: string[][] = [];
    const renderer = createRenderer({
      allowHosts: ["img.example.test", "192.0.2.10"], executablePath: "/fake/chrome",
      launch: (async (args: { args: string[] }) => { seen.push(args.args); throw new Error("no browser"); }) as never,
    });
    await renderer.renderPdf({ html: "<p>Ithaca</p>" }).catch(() => {});
    await renderer.shutdown();
    expect(seen.length).toBe(1);
    expect(seen[0]!.filter((arg) => arg.startsWith("--host-resolver-rules="))).toEqual(["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE img.example.test, EXCLUDE 192.0.2.10"]);
  });

  test("plain hosts pass: mixed case is lowercased, and IPv4 and bracketed IPv6 literals are kept", async () => {
    const seen: string[][] = [];
    const renderer = createRenderer({
      allowHosts: ["IMG.Example.Test", "192.0.2.10", "[2001:db8::1]", "cdn_1.ithaca.test"], executablePath: "/fake/chrome",
      launch: (async (args: { args: string[] }) => { seen.push(args.args); throw new Error("no browser"); }) as never,
    });
    await renderer.renderPdf({ html: "<p>Ithaca</p>" }).catch(() => {});
    await renderer.shutdown();
    expect(seen[0]!.find((arg) => arg.startsWith("--host-resolver-rules="))).toBe("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE img.example.test, EXCLUDE 192.0.2.10, EXCLUDE [2001:db8::1], EXCLUDE cdn_1.ithaca.test");
  });

  test("an allowed host admits only its http and https requests", () => {
    const hosts = new Set(["img.example.test"]);
    expect(hostRequestAllowed("https://img.example.test/a.png", hosts)).toBe(true);
    expect(hostRequestAllowed("http://IMG.example.test/a.png", hosts)).toBe(true);
    for (const url of ["ws://img.example.test/live", "ftp://img.example.test/a.png", "file://img.example.test/etc/passwd", "wss://img.example.test/"]) {
      expect(hostRequestAllowed(url, hosts), url).toBe(false);
    }
    expect(hostRequestAllowed("https://other.example.test/a.png", hosts)).toBe(false);
    expect(hostRequestAllowed("https://img.example.test/a.png", new Set())).toBe(false);
  });
});
