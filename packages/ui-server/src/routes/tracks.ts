import { Hono } from "hono";
import { readStagedTrack } from "../tracks/read.js";

/** Read-only, behind createApp's existing authentication guard. */
export function createTrackRoutes(brainRoot: string): Hono {
  return new Hono().get("/tracks", async c => {
    const path = c.req.query("path");
    if (!path || path.length > 512) return c.json({ error: "invalid_track_path" }, 400);
    try { return c.json(await readStagedTrack(brainRoot, path)); }
    catch { return c.json({ error: "track_unavailable", message: "The staged file is unavailable or is not a supported track. The original may have expired." }, 422); }
  });
}
