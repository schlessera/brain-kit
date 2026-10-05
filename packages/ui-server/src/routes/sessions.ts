import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { BackendRegistry } from "../agent/backend.js";

export function createSessionRoutes(deps: {
  registry: BackendRegistry;
  db: Database;
}): Hono {
  const { registry, db } = deps;
  const pending = new Map<AgentBackend, ReturnType<AgentBackend["listSessions"]>>();

  async function listSessions(backend: AgentBackend) {
    let work = pending.get(backend);
    if (!work) {
      work = Promise.resolve().then(() => backend.listSessions());
      pending.set(backend, work);
      const clear = () => { if (pending.get(backend) === work) pending.delete(backend); };
      void work.then(clear, clear);
    }
    // Backends have no cancellation API. Reuse unfinished work so retries
    // cannot pile up scans behind a stalled backend.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Session listing timed out")), 3_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

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
      // The catalog's accounting (total_cost_usd, num_turns) was write-only
      // for years on the default backend, whose listSessions hardcodes
      // zeros — merge the stored numbers in so the drawer's cost renders
      // from what the server actually recorded.
      const accounting = new Map(
        (
          db
            .query("SELECT id, title, total_cost_usd AS cost, num_turns AS turns, handoff_from AS handoffFrom, handoff_from_turns AS handoffFromTurns, backend_id AS backendId FROM sessions")
            .all() as Array<{ id: string; title: string | null; cost: number | null; turns: number | null; handoffFrom: string | null; handoffFromTurns: number | null; backendId: string | null }>
        ).map((r) => [r.id, r])
      );
      const results = await Promise.allSettled(
        backends.map(async (backend) =>
          (await listSessions(backend)).map((session) => {
            const stored = accounting.get(session.id);
            return {
              ...session,
              ...(stored?.cost && session.totalCostUsd === 0
                ? { totalCostUsd: stored.cost }
                : {}),
              ...(stored?.turns && session.numTurns === 0
                ? { numTurns: stored.turns }
                : {}),
              backendId: backend.id,
            };
          })
        )
      );
      const listed = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      // A handoff destination names its source (#61). The title is the one
      // the source's own backend lists, else the catalog's first prompt.
      const titles = new Map(listed.map((session) => [session.id, session.title]));
      const sessions = listed
        .map((session) => {
          const stored = accounting.get(session.id);
          const from = stored?.handoffFrom;
          if (!from) return session;
          const source = accounting.get(from);
          return {
            ...session,
            handoffFrom: {
              sessionId: from,
              title: titles.get(from) ?? source?.title ?? null,
              ...(source?.backendId ? { backendId: source.backendId } : {}),
              ...(typeof stored.handoffFromTurns === "number" ? { afterTurns: stored.handoffFromTurns } : {}),
            },
          };
        })
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      const unavailableBackends = results.flatMap((result, index) =>
        result.status === "rejected" ? [backends[index]!.id] : []);
      return c.json({ sessions, ...(unavailableBackends.length ? { unavailableBackends } : {}) });
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
