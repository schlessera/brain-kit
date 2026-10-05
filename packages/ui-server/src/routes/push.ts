import { Hono } from "hono";
import { z } from "zod";

import type { PushSender } from "../activity/push-sender.js";
import type { ActionNotifier } from "../inbox/notify.js";
import type { AppEnv } from "../app-env.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";

/**
 * Push subscription lifecycle. Behind the auth guard by mount position —
 * the public key is per-deployment (not build-time), and subscribing is a
 * write into the notification fan-out, which only the authenticated user
 * may do. The VAPID PRIVATE key has no route, here or anywhere.
 */
const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    }),
  }),
  label: z.string().max(120).optional(),
  /** Additive: the device's IANA zone for Action notice timing. Validated
   *  server-side; an unusable value is recorded as missing, never rejected. */
  timeZone: z.string().max(256).optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.url().max(2048),
});

const zoneSchema = z.object({
  timeZone: z.string().max(256),
  endpoint: z.url().max(2048).optional(),
});

export function createPushRoutes(deps: { sender: PushSender; notices?: ActionNotifier }) {
  const { sender, notices } = deps;

  return new Hono<AppEnv>()
    .get("/push/public-key", (c) => {
      try {
        return c.json({ publicKey: sender.publicKey() });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Push unavailable" },
          500
        );
      }
    })

    .get("/push/subscriptions", (c) => {
      try {
        // Endpoints are capability URLs — list only metadata.
        return c.json({
          subscriptions: sender.subscriptions(c.get("principal")!.id).map((s) => ({
            label: s.label,
            createdAt: s.createdAt,
            lastUsedAt: s.lastUsedAt,
            // Null means Action notices for this device wait for a zone report.
            timeZone: s.timeZone,
            // Enough for the client to recognize its own registration.
            endpointHash: hashEndpoint(s.endpoint),
          })),
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to list" },
          500
        );
      }
    })

    .post("/push/subscribe", requireJson(), async (c) => {
      try {
        const result = await readJsonBody(c);
        if (result instanceof Response) return result;
        const body = subscribeSchema.parse(result);
        const principal = c.get("principal")!;
        if (!sender.subscribe(body.subscription, principal.id, body.label)) {
          return c.json({ error: "Authentication required" }, 401);
        }
        // Omitted: an older client keeps the device's last reported zone.
        if (body.timeZone !== undefined) {
          notices?.reportZone(principal.id, body.timeZone, body.subscription.endpoint);
        }
        return c.json({ ok: true });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Bad subscription" },
          400
        );
      }
    })

    // Lifecycle refresh (reconnect, foreground, detected change) of the
    // caller's client-context zone and, when named, its own destination.
    .post("/push/zone", requireJson(), async (c) => {
      const result = await readJsonBody(c);
      if (result instanceof Response) return result;
      const parsed = zoneSchema.safeParse(result);
      if (!parsed.success) return c.json({ error: "Bad zone report" }, 400);
      if (!notices) return c.json({ error: "Action notices unavailable" }, 503);
      try {
        const { timeZone } = notices.reportZone(c.get("principal")!.id, parsed.data.timeZone, parsed.data.endpoint);
        return c.json({ ok: true, timeZone });
      } catch {
        return c.json({ error: "Authentication required" }, 401);
      }
    })

    .post("/push/unsubscribe", requireJson(), async (c) => {
      try {
        const result = await readJsonBody(c);
        if (result instanceof Response) return result;
        const body = unsubscribeSchema.parse(result);
        return c.json({
          removed: sender.unsubscribe(body.endpoint, c.get("principal")!.id),
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Bad request" },
          400
        );
      }
    });
}

function hashEndpoint(endpoint: string): string {
  return new Bun.CryptoHasher("sha256").update(endpoint).digest("hex").slice(0, 16);
}
