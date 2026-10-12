import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { SessionProfileError, type SessionProfiles } from "../ws/session-profiles.js";

/** Mounted behind host auth; durable validity is checked again at every read/write. */
export function createSessionProfileRoutes(profiles: SessionProfiles) {
  const app = new Hono<AppEnv>();
  for (const [prefix, kind] of [["sessions", "session"], ["drafts", "draft"]] as const) {
    app.on(["GET", "PUT"], `/${prefix}/:id/profile`, async c => {
      c.header("Cache-Control", "no-store");
      try {
        const principal = c.get("principal");
        if (!principal) throw new SessionProfileError(401, "Authentication required.");
        const id = c.req.param("id");
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new SessionProfileError(400, "Invalid chat identity.");
        if (c.req.method === "GET" || c.req.method === "HEAD") return c.json(profiles.read(principal.id, kind, id));
        if (c.req.header("content-type")?.split(";", 1)[0] !== "application/json") return c.json({ error: "Use JSON." }, 415);
        const reader = c.req.raw.body?.getReader();
        const chunks: Uint8Array[] = []; let length = 0;
        if (reader) for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 4096) { await reader.cancel().catch(() => {}); return c.json({ error: "Profile request is too large." }, 413); }
          chunks.push(value);
        }
        let body: unknown;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new SessionProfileError(400, "Invalid JSON."); }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "preference")
          || !["governed", "strict"].includes((body as { preference: string }).preference)) throw new SessionProfileError(400, "Choose governed or strict.");
        return c.json(profiles.save(principal.id, kind, id, (body as { preference: "governed" | "strict" }).preference));
      } catch (error) {
        if (error instanceof SessionProfileError) return c.json({ error: error.message, ...(error.status === 401 ? { authRequired: true } : {}) }, error.status);
        throw error;
      }
    });
  }
  return app;
}
