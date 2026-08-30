/**
 * Management surface for the user's remembered "always allow" tool grants —
 * the Settings screen's view of what the approval cards' "Always allow"
 * button has accumulated, and the way to take a grant back.
 *
 * The grants themselves are consulted by the ws bridge (an auto-allowed tool
 * never raises a card); this surface only lists and removes. Mount BEHIND
 * the /api auth guard: the list shapes what the agent can do unprompted.
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import { getAutoAllowedTools, setAutoAllowedTools } from "../db/settings.js";

export function createToolPermissionRoutes(deps: {
  db: Database;
  log?: Logger;
}): Hono {
  const { db, log } = deps;
  return new Hono()
    .get("/tool-permissions", (c) =>
      c.json({ tools: getAutoAllowedTools(db, log) })
    )
    .delete("/tool-permissions/:tool", (c) => {
      const tool = decodeURIComponent(c.req.param("tool"));
      const current = getAutoAllowedTools(db, log);
      if (!current.includes(tool)) {
        return c.json({ error: "Not an auto-allowed tool." }, 404);
      }
      setAutoAllowedTools(
        db,
        current.filter((t) => t !== tool)
      );
      return c.json({ tools: getAutoAllowedTools(db, log) });
    });
}
