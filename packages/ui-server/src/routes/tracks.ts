import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { Hono } from "hono";
import { ATTACHMENT_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { readStagedTrack } from "../tracks/read.js";
import { readAttachmentTrack } from "../attachments/track.js";
import type { AwaitableDraftStore } from "../drafts/store.js";

/** Read-only, behind createApp's existing authentication guard. */
export function createTrackRoutes(brainRoot: string, attachments?: Pick<AwaitableDraftStore, "attachments" | "attachmentReferenced" | "settled">): Hono {
  return new Hono().get("/tracks", async c => {
    const path = c.req.query("path");
    if (!path || path.length > 512) return c.json({ error: "invalid_track_path" }, 400);
    try {
      // A composer original (#3153) is read through its record; a staged share as before.
      if (attachments && isWithin(ATTACHMENT_DIR, path, { includeRoot: false })) {
        await attachments.settled?.();
        return c.json(await readAttachmentTrack(brainRoot, attachments, path));
      }
      return c.json(await readStagedTrack(brainRoot, path));
    }
    catch { return c.json({ error: "track_unavailable", message: "The staged file is unavailable or is not a supported track. The original may have expired." }, 422); }
  });
}
