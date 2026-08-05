import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { tailscaleGuard } from "../src/middleware/tailscale";

describe("tailscale guard on WebSocket route", () => {
  function createApp() {
    const app = new Hono();
    // trustProxy: true to exercise the x-forwarded-for path in app.request().
    app.use("/ws", tailscaleGuard({ trustProxy: true }));
    app.get("/ws", (c) => c.text("upgrade would happen here"));
    // Health remains unprotected
    app.get("/api/health", (c) => c.json({ ok: true }));
    return app;
  }

  const app = createApp();

  test("blocks /ws from non-Tailscale IP", async () => {
    const res = await app.request("/ws", {
      headers: { "x-forwarded-for": "192.168.1.1" },
    });
    expect(res.status).toBe(403);
  });

  test("allows /ws from Tailscale IP", async () => {
    const res = await app.request("/ws", {
      headers: { "x-forwarded-for": "100.100.1.1" },
    });
    expect(res.status).toBe(200);
  });

  test("allows /ws from localhost", async () => {
    const res = await app.request("/ws", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  test("health endpoint is not affected by ws guard", async () => {
    const res = await app.request("/api/health", {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    expect(res.status).toBe(200);
  });
});
