/** Password-owner browser boundary; no model, voice or body-supplied authority. */
import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "../app-env.js";
import { requireJson } from "../middleware/origin.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { TrustSettingsError, type TrustSettings } from "../brain/trust-settings.js";
export function createTrustSettingsRoutes(deps: { settings: TrustSettings; trustProxy: boolean }) {
  const routes = new Hono<AppEnv>();
  const active = new Map<string, number>(); let total = 0;
  routes.use("/trust-settings*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (!c.get("principal")) return c.json({ code: "unauthorized", reason: "Authentication required", retryable: false }, 401);
    if (c.req.method !== "GET") {
      // Require the actual Origin, independent of spoofed fetch metadata and
      // the broader legacy API allowlist. Reverse-proxy TLS uses trusted proto.
      let expected: string;
      try {
        const proto = deps.trustProxy ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
        expected = new URL(`${proto ? `${proto}:` : new URL(c.req.url).protocol}//${c.req.header("host") ?? new URL(c.req.url).host}`).origin;
      } catch { return c.json({ code: "unauthorized", reason: "Same-origin request required", retryable: false }, 403); }
      if (c.req.header("origin") !== expected) return c.json({ code: "unauthorized", reason: "Same-origin request required", retryable: false }, 403);
    }
    const principal = c.get("principal")!.id, count = active.get(principal) ?? 0;
    if (count >= 32 || total >= 256) return c.json({ code: "busy", reason: "Too many Settings requests are active. Try again when one finishes.", retryable: true }, 503);
    active.set(principal, count + 1); total++;
    try { await next(); }
    finally { total--; const remaining = active.get(principal)! - 1; if (remaining) active.set(principal, remaining); else active.delete(principal); }
  });
  routes.onError((error, c) => error instanceof TrustSettingsError ? c.json({ code: error.code, reason: error.message, retryable: false }, error.status)
    : error instanceof ZodError ? c.json({ code: "request_conflict", reason: "Invalid request", retryable: false }, 400)
    : c.json({ code: "unavailable", reason: "Settings unavailable", retryable: false }, 503));
  routes.get("/trust-settings", async c => c.json(await deps.settings.list(c.get("principal")!.id)));
  routes.get("/trust-settings/:request", async c => c.json(await deps.settings.read(c.get("principal")!.id, c.req.param("request"))));
  for (const action of ["prepare", "commit"] as const) routes.post(`/trust-settings/${action}`, requireJson(), async c => {
    const body = await readJsonBody(c, 65536).catch(() => null); if (body instanceof Response) return body;
    return c.json(await deps.settings[action](c.get("principal")!.id, body, c.req.raw.signal));
  });
  return routes;
}
