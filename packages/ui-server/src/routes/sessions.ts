import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { BackendRegistry } from "../agent/backend.js";

export function createSessionRoutes(deps: {
  registry: BackendRegistry;
  db: Database;
}): Hono {
  const { registry, db } = deps;

  function getStoredBackendId(sessionId: string): string | null {
    const row = db
      .query("SELECT backend_id AS backendId FROM sessions WHERE id = ?")
      .get(sessionId) as { backendId: string | null } | null;
    return row?.backendId ?? null;
  }

  return new Hono()
  .get("/sessions", async (c) => {
    try {
      const backends = await registry.getBackends();
      const sessions = (
        await Promise.all(
          backends.map(async (backend) =>
            (await backend.listSessions()).map((session) => ({
              ...session,
              backendId: backend.id,
            }))
          )
        )
      )
        .flat()
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return c.json({ sessions });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to list sessions" },
        500
      );
    }
  })

  .get("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const backend = await registry.getBackendForSession(getStoredBackendId(id));
      const messages = await backend.getHistory(id);
      return c.json({ id, messages });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to get session" },
        500
      );
    }
  });
}
