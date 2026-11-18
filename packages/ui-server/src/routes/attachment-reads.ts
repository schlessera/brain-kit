import { Hono } from "hono";
import { SESSION_NOT_FOUND, type SessionAttachmentReadsResponse } from "@schlessera/brain-ui-sdk/protocol";

import type { AppEnv } from "../app-env.js";
import type { WsHost } from "../ws/host.js";
import { toAttachmentReadEntry } from "../attachments/store.js";

/**
 * `GET /api/sessions/:id/attachment-reads` (#3589). Mounted behind the auth
 * guard, and only where `server_hello` advertises `attachmentReads`. It
 * returns the recorded reads of the originals this session's messages name,
 * under the same authority a history replay of that session has: a usable
 * principal of this host. Outcome and scope only, never text, and nothing of
 * it is provider context. Responses are not cached.
 */
export function createAttachmentReadRoutes(host: WsHost): Hono<AppEnv> {
  return new Hono<AppEnv>().get("/sessions/:id/attachment-reads", async (c) => {
    c.header("Cache-Control", "no-store");
    const principal = c.get("principal");
    const unauthorized = () => c.json({ error: "Authentication required", authRequired: true }, 401);
    if (!principal || !host.isPrincipalValid(principal) || !host.drafts) return unauthorized();
    const sessionId = c.req.param("id");
    // A retired chat has nothing left to show (#3230).
    if (host.catalog.chatRetired?.({ sessionId })) return c.json({ error: SESSION_NOT_FOUND, message: "This host has no such session." }, 404);
    // Writes commit off the event loop: read what was submitted before this request.
    await host.drafts.settled?.();
    if (!host.isPrincipalValid(principal)) return unauthorized();
    const body: SessionAttachmentReadsResponse = { sessionId, reads: host.drafts.attachmentReads(sessionId).map(toAttachmentReadEntry) };
    return c.json(body);
  });
}
