/**
 * `GET`/`PUT /api/settings/voice` (#3616): the saved brain-wide default live
 * service. It is independent of the ordinary model default and of dictation,
 * which keep their own routes and revisions.
 *
 * Reading needs any authenticated human session of the brain. Writing has its
 * own owner-only guard, enforced here rather than assumed from another route:
 * only the owner's human session (password or passkey) or the ambient human
 * principal passes. Delegated agent principals and anything else get 403 with
 * an empty body. Neither route reads a credential, opens a provider, captures
 * audio or reads history; a save only changes the next explicit Start.
 */

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { VoiceLiveSettings } from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../app-env.js";
import { getLiveDefaultProvider } from "../db/settings.js";
import type { SettingsWrites } from "../db/settings-writes.js";
import { isUsablePrincipal, type Principal } from "../db/principals.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import type { LiveProviderRegistry } from "../voice/live-providers.js";

interface LiveSettingsRoutesDeps {
  db: Database;
  settingsWrites: SettingsWrites;
  live: LiveProviderRegistry;
  /** Called after a save: tells open connections, retargets nothing. */
  changed?: () => void;
  now?: () => number;
}

/** Human readers only: the owner's sessions and the ambient principal. */
function isHuman(principal: Principal | undefined, now: number): boolean {
  if (!principal || !isUsablePrincipal(principal, now)) return false;
  return principal.kind === "ambient" || principal.kind === "owner";
}

/** The owner-only write guard (#3616 §3): a human owner session, never a delegated principal. */
export function isLiveSettingsWriter(principal: Principal | undefined, now: number): boolean {
  if (!principal || !isUsablePrincipal(principal, now)) return false;
  if (principal.kind === "ambient") return principal.authMethod === "ambient";
  return principal.kind === "owner" && (principal.authMethod === "password" || principal.authMethod === "passkey");
}

export function createLiveSettingsRoutes(deps: LiveSettingsRoutesDeps): Hono<AppEnv> {
  const { db, settingsWrites, live } = deps;
  const now = deps.now ?? Date.now;
  return new Hono<AppEnv>()
    .get("/settings/voice", (c) => {
      c.header("Cache-Control", "no-store");
      if (!isHuman(c.get("principal"), now())) return c.body(null, 403);
      const body: VoiceLiveSettings = getLiveDefaultProvider(db);
      return c.json(body);
    })
    .put("/settings/voice", async (c, next) => {
      // Refuse before the body is read, whatever its media type.
      c.header("Cache-Control", "no-store");
      if (!isLiveSettingsWriter(c.get("principal"), now())) return c.body(null, 403);
      await next();
    }, requireJson(), async (c) => {
      c.header("Cache-Control", "no-store");
      const body = await readJsonBody(c).catch(() => null);
      if (body instanceof Response) return body;
      const row = body as Record<string, unknown> | null;
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          !(row.defaultProvider === null || typeof row.defaultProvider === "string" && row.defaultProvider.length > 0) ||
          typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) {
        return c.json({ error: "LIVE_SETTINGS_INVALID", message: "Send { defaultProvider: string | null, revision: number }." }, 400);
      }
      const defaultProvider = row.defaultProvider as string | null;
      if (defaultProvider !== null && !live.get(defaultProvider)) {
        return c.json({ error: "LIVE_PROVIDER_UNKNOWN", message: "That live service isn't available on this host." }, 400);
      }
      const result = await settingsWrites.saveLiveDefaultProvider(row.revision, defaultProvider);
      if (!result.saved) return c.json({ error: "LIVE_SETTINGS_CHANGED", message: "Changed on another device.", current: result.current }, 409);
      deps.changed?.();
      const saved: VoiceLiveSettings = result.current;
      return c.json(saved);
    });
}
