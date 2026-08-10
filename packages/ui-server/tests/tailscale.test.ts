import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { tailscaleGuard } from "../src/middleware/tailscale";

function createApp() {
  const app = new Hono();
  // trustProxy: true so these tests exercise the x-forwarded-for path. The
  // default (proxy trust off) uses the real socket address, which Hono's
  // app.request() does not provide — see the trust-off suite below.
  app.use("/api/*", tailscaleGuard({ trustProxy: true }));
  app.get("/api/test", (c) => c.json({ ok: true }));
  return app;
}

describe("tailscaleGuard middleware (trustProxy)", () => {
  const app = createApp();

  test("allows requests from Tailscale CGNAT range (100.64-127.x.x.x)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.100.50.1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("allows 100.64.0.1 (lower bound)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.64.0.1" },
    });
    expect(res.status).toBe(200);
  });

  test("allows 100.127.255.254 (upper bound)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.127.255.254" },
    });
    expect(res.status).toBe(200);
  });

  test("allows localhost (127.0.0.1)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  test("allows IPv6 localhost (::1)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "::1" },
    });
    expect(res.status).toBe(200);
  });

  test("blocks non-Tailscale IPs", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "192.168.1.1" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("VPN access required");
  });

  test("blocks 100.63.x.x (below CGNAT range)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.63.0.1" },
    });
    expect(res.status).toBe(403);
  });

  test("blocks 100.128.x.x (above CGNAT range)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.128.0.1" },
    });
    expect(res.status).toBe(403);
  });

  test("blocks public IPs", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    expect(res.status).toBe(403);
  });

  test("blocks requests with no IP headers", async () => {
    const res = await app.request("/api/test");
    expect(res.status).toBe(403);
  });

  test("uses the client IP from the right of the x-forwarded-for chain (hops=1)", async () => {
    // The fronting proxy appends the address it saw last, so the rightmost entry
    // (for a single trusted hop) is the real client; the leftmost is untrusted.
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "10.0.0.1, 192.168.1.1, 100.100.1.1" },
    });
    expect(res.status).toBe(200);
  });

  test("a client-spoofed leftmost Tailscale IP does not bypass the check", async () => {
    // Client forges a Tailscale IP on the left; the real IP the proxy saw is the
    // rightmost (non-Tailscale), so the request is still blocked.
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.100.1.1, 10.0.0.1" },
    });
    expect(res.status).toBe(403);
  });

  test("falls back to x-real-ip header", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-real-ip": "100.100.1.1" },
    });
    expect(res.status).toBe(200);
  });
});

describe("tailscaleGuard middleware (proxy trust off)", () => {
  function createApp() {
    const app = new Hono();
    app.use("/api/*", tailscaleGuard({ trustProxy: false }));
    app.get("/api/test", (c) => c.json({ ok: true }));
    return app;
  }
  const app = createApp();

  test("ignores a spoofable x-forwarded-for and blocks (no socket in app.request)", async () => {
    const res = await app.request("/api/test", {
      headers: { "x-forwarded-for": "100.100.1.1" },
    });
    // With header trust off, a forged Tailscale IP no longer grants access.
    expect(res.status).toBe(403);
  });
});
