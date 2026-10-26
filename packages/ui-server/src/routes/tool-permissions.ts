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
import { getAutoAllowedTools } from "../db/settings.js";

import { createSettingsWrites, type SettingsWrites } from "../db/settings-writes.js";

export function createToolPermissionRoutes(deps: {
  db: Database;
  settingsWrites?: SettingsWrites;
  log?: Logger;
}): Hono {
  const { db, log } = deps;
  const writes = deps.settingsWrites ?? createSettingsWrites(db, undefined, log);
  return new Hono()
    .get("/tool-permissions", (c) =>
      c.json({ tools: getAutoAllowedTools(db, log) })
    )
    .delete("/tool-permissions/:tool", async (c) => {
      const tool = decodeURIComponent(c.req.param("tool"));
      const tools = await writes.removeAutoAllowedTool(tool);
      if (tools === null) return c.json({ error: "Not an auto-allowed tool." }, 404);
      return c.json({ tools });
    });
}
