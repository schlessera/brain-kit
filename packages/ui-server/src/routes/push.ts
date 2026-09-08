import { Hono } from "hono";
import { z } from "zod";

import type { PushSender } from "../activity/push-sender.js";
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
});

const unsubscribeSchema = z.object({
  endpoint: z.url().max(2048),
});

export function createPushRoutes(deps: { sender: PushSender }): Hono {
  const { sender } = deps;

  return new Hono()
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
          subscriptions: sender.subscriptions().map((s) => ({
            label: s.label,
            createdAt: s.createdAt,
            lastUsedAt: s.lastUsedAt,
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
        sender.subscribe(body.subscription, body.label);
        return c.json({ ok: true });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Bad subscription" },
          400
        );
      }
    })

    .post("/push/unsubscribe", requireJson(), async (c) => {
      try {
        const result = await readJsonBody(c);
        if (result instanceof Response) return result;
        const body = unsubscribeSchema.parse(result);
        return c.json({ removed: sender.unsubscribe(body.endpoint) });
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
