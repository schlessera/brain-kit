// Router-level human-owner checks (#4757). `app.ts` gates these mounts with
// its own owner check, so a test through the whole app cannot tell whether a
// router's own check still refuses. Each router is mounted here alone, behind a
// middleware that sets the principal, and its stores are inert stubs.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnv } from "../src/app-env";
import type { Principal, PrincipalAuthMethod, PrincipalKind } from "../src/db/principals";
import { createApifyRoutes } from "../src/routes/apify";
import { createJournalRoutes } from "../src/routes/journal";
import { createStorageRoutes } from "../src/routes/storage";
import { createStorageMaintenanceRoutes } from "../src/routes/storage-maintenance";
import { createStorageRemovalRoutes } from "../src/routes/storage-removal";
import { createTurnRevertRoutes } from "../src/routes/turn-revert";

const NOW = 1_783_814_400_000;

function principal(kind: PrincipalKind, authMethod: PrincipalAuthMethod): Principal {
  return {
    id: `${kind}-${authMethod}`, kind, authMethod, label: "Odysseus", credentialId: null, createdBy: null,
    createdAt: NOW, expiresAt: NOW + 60_000, lastSeenAt: null, revokedAt: null,
  };
}

const AGENT = principal("agent", "delegated");
const OWNER = principal("owner", "password");

/** Any property read on a stub answers an inert function, so a route that passes its guard does not throw on a missing store method. */
function stub<T>(): T {
  return new Proxy({}, { get: () => () => ({}) }) as T;
}

function mount(router: Hono<AppEnv>, as: Principal | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (as) c.set("principal", as); await next(); });
  app.route("/", router);
  return app;
}

interface Site { name: string; router: () => Hono<AppEnv>; path: string; forbidden: unknown; unauthenticated?: unknown }

const AUTH_REQUIRED = { error: "Authentication required." };
const SITES: Site[] = [
  { name: "routes/storage.ts", router: () => createStorageRoutes(stub()), path: "/storage", forbidden: { error: "Storage requires human-owner access." }, unauthenticated: AUTH_REQUIRED },
  { name: "routes/storage-maintenance.ts", router: () => createStorageMaintenanceRoutes(stub()), path: "/storage/maintenance", forbidden: { error: "Maintenance requires human-owner access." }, unauthenticated: AUTH_REQUIRED },
  { name: "routes/storage-removal.ts", router: () => createStorageRemovalRoutes(stub()), path: "/storage/removals", forbidden: { error: "Attachment removal requires human-owner access." }, unauthenticated: AUTH_REQUIRED },
  { name: "routes/turn-revert.ts", router: () => createTurnRevertRoutes(stub()), path: "/sessions/s1/turns/t1/revert", forbidden: { error: "User history action unavailable." }, unauthenticated: AUTH_REQUIRED },
  // `authorized` is permissive so the route's own kind check is the only refusal.
  { name: "routes/apify.ts", router: () => createApifyRoutes({ authority: stub(), authorized: () => true }), path: "/apify", forbidden: { error: "Apify settings require human-owner access." }, unauthenticated: AUTH_REQUIRED },
  { name: "routes/journal.ts code preview", router: () => createJournalRoutes({ journal: stub() }), path: "/sessions/s1/turns/t1/journal/code/preview?checkout=c1", forbidden: { error: "Owner authorization required." } },
  { name: "routes/journal.ts code revert read", router: () => createJournalRoutes({ journal: stub(), codeHistory: stub() }), path: "/sessions/s1/turns/t1/journal/code/revert/r1", forbidden: { error: "Owner authorization required." } },
];

describe("router human-owner checks refuse a delegated agent with their own body", () => {
  for (const site of SITES) {
    test(site.name, async () => {
      const refused = await mount(site.router(), AGENT).request(site.path);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(site.forbidden);
      expect(refused.headers.get("cache-control")).toBe("private, no-store");
      const none = await mount(site.router(), undefined).request(site.path);
      if (site.unauthenticated) {
        expect(none.status).toBe(401);
        expect(await none.json()).toEqual(site.unauthenticated);
      } else {
        expect(none.status).toBe(403);
        expect(await none.json()).toEqual(site.forbidden);
      }
      const admitted = await mount(site.router(), OWNER).request(site.path);
      expect([401, 403]).not.toContain(admitted.status);
    });
  }

  test("routes/journal.ts code revert start", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    const refused = await mount(createJournalRoutes({ journal: stub(), codeHistory: stub() }), AGENT).request("/sessions/s1/turns/t1/journal/code/revert", init);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Owner authorization required." });
    const none = await mount(createJournalRoutes({ journal: stub(), codeHistory: stub() }), undefined).request("/sessions/s1/turns/t1/journal/code/revert", init);
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "Owner authorization required." });
  });
});
