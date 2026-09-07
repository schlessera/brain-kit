/**
 * Provider sign-in over the pi backend's OAuth service — the Settings UI's
 * path to logging in to OpenAI (ChatGPT Plus/Pro, device-code flow) without a
 * shell on the host.
 *
 * The pi package is an OPTIONAL peer: it is reached only through
 * `loadBackendModule("pi")` and typed as a local structural mirror, per the
 * declaration-surface rules. The routes are live only when pi profiles are
 * configured (BRAIN_UI_PI_PROFILES, or AGENT_BACKEND=pi) — provider ids are
 * validated against the CONFIGURED roster's vendors, so an authenticated
 * client still cannot start login flows for arbitrary providers.
 *
 * Mount BEHIND the /api auth guard: an open login-start endpoint would let
 * anyone mint OpenAI device codes against this server.
 */

import { Hono } from "hono";
import type { AgentConfig } from "../config/env.js";
import { loadBackendModule, parsePiProfiles } from "../agent/backend.js";
import { requireJson } from "../middleware/origin.js";

/** Structural mirror of the pi package's PiLoginFlow (primitives only). */
export interface PiLoginFlowView {
  id: string;
  providerId: string;
  status: "pending" | "success" | "error" | "cancelled";
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
  error?: string;
  startedAt: number;
}

/** Structural mirror of the pi package's PiAuthProviderStatus. */
export interface PiAuthProviderStatusView {
  providerId: string;
  name: string;
  configured: boolean;
  source?: string;
  oauth: boolean;
}

/** Structural mirror of the pi package's PiAuth service. */
interface PiAuthMirror {
  status(providerIds: string[]): Promise<PiAuthProviderStatusView[]>;
  startLogin(providerId: string): Promise<PiLoginFlowView>;
  getFlow(id: string): PiLoginFlowView | null;
  cancelFlow(id: string): void;
  logout(providerId: string): Promise<void>;
}

export interface PiAuthRoutesDeps {
  agent: AgentConfig;
  /** Test seam — forwarded to loadBackendModule. */
  importer?: (specifier: string) => Promise<unknown>;
}

export function createPiAuthRoutes(deps: PiAuthRoutesDeps): Hono {
  const { agent } = deps;

  /**
   * Vendors the deployment actually configured — the only providers this
   * surface may touch. Empty when pi is not in play at all.
   */
  function allowedProviders(): string[] {
    const fromProfiles = parsePiProfiles(agent.piProfilesJson, agent.profilesJson).map(
      (profile) => profile.vendor
    );
    return [...new Set(fromProfiles)];
  }

  const piConfigured = () =>
    Boolean(agent.piProfilesJson) || (agent.backend || "claude") === "pi";

  // One service for the app's lifetime: it owns the pending-flow state.
  let authPromise: Promise<PiAuthMirror> | null = null;
  function getAuth(): Promise<PiAuthMirror> {
    if (!authPromise) {
      authPromise = (async () => {
        const mod = (await loadBackendModule("pi", deps.importer)) as {
          createPiAuth?: () => PiAuthMirror;
        };
        if (typeof mod.createPiAuth !== "function") {
          throw new Error(
            '"@schlessera/brain-backend-pi" does not export createPiAuth — update the package.'
          );
        }
        return mod.createPiAuth();
      })();
      authPromise.catch(() => {
        authPromise = null;
      });
    }
    return authPromise;
  }

  return new Hono()
    .get("/pi-auth/providers", async (c) => {
      // Not-configured is a normal state, not an error: the client hides the
      // whole card on an empty list.
      if (!piConfigured()) return c.json({ providers: [] });
      const providers = allowedProviders();
      if (providers.length === 0) return c.json({ providers: [] });
      const auth = await getAuth();
      return c.json({ providers: await auth.status(providers) });
    })
    .post("/pi-auth/login", requireJson(), async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        providerId?: unknown;
      } | null;
      const providerId = typeof body?.providerId === "string" ? body.providerId : "";
      if (!piConfigured()) {
        return c.json({ error: "The pi backend is not configured." }, 409);
      }
      if (!providerId || !allowedProviders().includes(providerId)) {
        return c.json({ error: "Unknown provider." }, 400);
      }
      const auth = await getAuth();
      try {
        const flow = await auth.startLogin(providerId);
        return c.json({ flow });
      } catch (err) {
        // e.g. a provider whose flow the web surface cannot drive.
        return c.json(
          { error: err instanceof Error ? err.message : "Could not start login." },
          400
        );
      }
    })
    .get("/pi-auth/login/:id", async (c) => {
      const auth = await getAuth();
      const flow = auth.getFlow(c.req.param("id"));
      if (!flow) return c.json({ error: "Unknown login flow." }, 404);
      return c.json({ flow });
    })
    .delete("/pi-auth/login/:id", async (c) => {
      const auth = await getAuth();
      auth.cancelFlow(c.req.param("id"));
      return c.json({ ok: true });
    })
    .post("/pi-auth/logout", requireJson(), async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        providerId?: unknown;
      } | null;
      const providerId = typeof body?.providerId === "string" ? body.providerId : "";
      if (!providerId || !allowedProviders().includes(providerId)) {
        return c.json({ error: "Unknown provider." }, 400);
      }
      const auth = await getAuth();
      await auth.logout(providerId);
      return c.json({ ok: true });
    });
}
