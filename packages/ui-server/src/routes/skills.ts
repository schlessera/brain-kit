/**
 * Custom-skill management routes — the Settings pane's CRUD over the brain
 * repo's canonical skill home (see skills/manager.ts for the store contract).
 *
 * Every mutation is followed by `brain skills sync`, which re-materializes
 * the per-agent integration dirs (.claude/skills, .pi/skills, codex, gemini)
 * and the AGENTS.md index block — so a change here reaches EVERY backend's
 * next turn/session with no restart. A failed sync degrades to a `warning`
 * in the response (the canonical write already happened; the next nightly
 * sync repairs the links) instead of failing the request.
 *
 * Mount BEHIND the /api auth guard: skills instruct the agent.
 */

import { Hono } from "hono";
import type { Logger } from "@opentelemetry/api-logs";
import {
  createSkillManager,
  SkillConflictError,
  SkillNotFoundError,
  SkillValidationError,
} from "../skills/manager.js";

export interface SkillRoutesDeps {
  brainPath: string;
  /** Runs `brain skills sync`; resolves with a human-readable summary. */
  syncSkills: () => Promise<string>;
  log?: Logger;
}

export function createSkillRoutes(deps: SkillRoutesDeps): Hono {
  const manager = createSkillManager(deps.brainPath);

  function errorResponse(err: unknown): { status: 400 | 404 | 409 | 500; message: string } {
    if (err instanceof SkillValidationError) return { status: 400, message: err.message };
    if (err instanceof SkillNotFoundError) return { status: 404, message: err.message };
    if (err instanceof SkillConflictError) return { status: 409, message: err.message };
    return { status: 500, message: err instanceof Error ? err.message : "Skill operation failed." };
  }

  async function syncAfterMutation(): Promise<string | undefined> {
    try {
      await deps.syncSkills();
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.emit({
        severityText: "WARN",
        body: "brain skills sync failed after a skill mutation; agent links may lag until the next sync",
        attributes: { error: message },
      });
      return `Skill saved, but \`brain skills sync\` failed: ${message}`;
    }
  }

  return new Hono()
    .get("/skills", (c) => c.json({ skills: manager.list() }))
    .get("/skills/:name", (c) => {
      try {
        return c.json(manager.get(c.req.param("name")));
      } catch (err) {
        const { status, message } = errorResponse(err);
        return c.json({ error: message }, status);
      }
    })
    .post("/skills", async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        name?: unknown;
        content?: unknown;
      } | null;
      if (typeof body?.name !== "string" || typeof body?.content !== "string") {
        return c.json({ error: "Body needs string `name` and `content`." }, 400);
      }
      try {
        const entry = manager.create(body.name, body.content);
        const warning = await syncAfterMutation();
        return c.json({ skill: entry, ...(warning ? { warning } : {}) }, 201);
      } catch (err) {
        const { status, message } = errorResponse(err);
        return c.json({ error: message }, status);
      }
    })
    .put("/skills/:name", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
      if (typeof body?.content !== "string") {
        return c.json({ error: "Body needs string `content`." }, 400);
      }
      try {
        const entry = manager.update(c.req.param("name"), body.content);
        const warning = await syncAfterMutation();
        return c.json({ skill: entry, ...(warning ? { warning } : {}) });
      } catch (err) {
        const { status, message } = errorResponse(err);
        return c.json({ error: message }, status);
      }
    })
    .post("/skills/:name/enabled", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
      if (typeof body?.enabled !== "boolean") {
        return c.json({ error: "Body needs boolean `enabled`." }, 400);
      }
      try {
        const entry = manager.setEnabled(c.req.param("name"), body.enabled);
        const warning = await syncAfterMutation();
        return c.json({ skill: entry, ...(warning ? { warning } : {}) });
      } catch (err) {
        const { status, message } = errorResponse(err);
        return c.json({ error: message }, status);
      }
    })
    .delete("/skills/:name", async (c) => {
      try {
        manager.remove(c.req.param("name"));
        const warning = await syncAfterMutation();
        return c.json({ ok: true, ...(warning ? { warning } : {}) });
      } catch (err) {
        const { status, message } = errorResponse(err);
        return c.json({ error: message }, status);
      }
    });
}
