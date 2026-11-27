// The exact-Origin check both browser-mutation routes share (#4759). One table
// of requests runs against each route with the proxy trusted and untrusted.
// Each router is mounted alone behind a middleware that sets an owner
// principal; a request the origin check admits falls through to a 404.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnv } from "../src/app-env";
import type { Principal } from "../src/db/principals";
import type { OwnerSafetyReviews } from "../src/governance/owner-safety-reviews";
import type { TrustSettings } from "../src/brain/trust-settings";
import { createOwnerSafetyReviewRoutes } from "../src/routes/owner-safety-review";
import { createTrustSettingsRoutes } from "../src/routes/trust-settings";

const NOW = 1_783_814_400_000;
const OWNER: Principal = {
  id: "odysseus", kind: "owner", authMethod: "password", label: "Odysseus", credentialId: null, createdBy: null,
  createdAt: NOW, expiresAt: NOW + 60_000, lastSeenAt: null, revokedAt: null,
};

interface Route { name: string; app(trustProxy: boolean): Hono<AppEnv>; path: string; reason: string }

function withOwner(router: Hono<AppEnv>) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("principal", OWNER); await next(); });
  app.route("/", router);
  return app;
}

const ROUTES: Route[] = [
  {
    name: "trust-settings",
    app: trustProxy => withOwner(createTrustSettingsRoutes({ settings: {} as TrustSettings, trustProxy })),
    path: "/trust-settings/probe",
    reason: "Same-origin request required",
  },
  {
    name: "owner-safety-review",
    app: trustProxy => withOwner(createOwnerSafetyReviewRoutes({ authorized: () => true } as unknown as OwnerSafetyReviews, trustProxy)),
    path: "/sessions/ithaca/safety/reviews/probe",
    reason: "cross_origin_rejected",
  },
];

type Outcome = "accepted" | "refused";
interface Row {
  name: string;
  headers: Record<string, string>;
  /** Outcome with the proxy untrusted and trusted, the same at both routes unless `safetyReview` says otherwise. */
  off: Outcome;
  on: Outcome;
  safetyReview?: { off: Outcome; on: Outcome };
}

// Every request URL is http://ithaca.example; `host` is sent unless a row overrides it.
const HOST = { host: "ithaca.example" };
const ROWS: Row[] = [
  { name: "no Origin header", headers: { ...HOST }, off: "refused", on: "refused" },
  { name: "Origin: null", headers: { ...HOST, origin: "null" }, off: "refused", on: "refused" },
  { name: "a different host", headers: { ...HOST, origin: "http://troy.example" }, off: "refused", on: "refused" },
  { name: "the right host with the other scheme", headers: { ...HOST, origin: "https://ithaca.example" }, off: "refused", on: "refused" },
  { name: "a malformed Origin", headers: { ...HOST, origin: "http://[ithaca" }, off: "refused", on: "refused" },
  { name: "forwarded scheme ws", headers: { ...HOST, origin: "http://ithaca.example", "x-forwarded-proto": "ws" }, off: "accepted", on: "refused" },
  { name: "forwarded scheme wss", headers: { ...HOST, origin: "https://ithaca.example", "x-forwarded-proto": "wss" }, off: "refused", on: "refused" },
  { name: "forwarded ws with a ws Origin", headers: { ...HOST, origin: "ws://ithaca.example", "x-forwarded-proto": "ws" }, off: "refused", on: "refused" },
  { name: "forwarded HTTPS, http with a matching https Origin", headers: { ...HOST, origin: "https://ithaca.example", "x-forwarded-proto": "HTTPS, http" }, off: "refused", on: "accepted" },
  { name: "a forwarded scheme, ignored unless trusted", headers: { ...HOST, origin: "http://ithaca.example", "x-forwarded-proto": "https" }, off: "accepted", on: "refused" },
  { name: "an empty first forwarded value falls back to the URL scheme", headers: { ...HOST, origin: "http://ithaca.example", "x-forwarded-proto": ", https" }, off: "accepted", on: "accepted" },
  { name: "an unknown forwarded scheme", headers: { ...HOST, origin: "http://ithaca.example", "x-forwarded-proto": "foo" }, off: "accepted", on: "refused" },
  { name: "the matching Origin", headers: { ...HOST, origin: "http://ithaca.example" }, off: "accepted", on: "accepted" },
  { name: "no Host header: the request URL's host", headers: { origin: "http://ithaca.example" }, off: "accepted", on: "accepted" },
  // The request URL and the Host header disagree. Bun builds the request URL
  // from the Host header, so only an in-process request can construct this.
  { name: "Host names another host; Origin matches Host", headers: { host: "troy.example", origin: "http://troy.example" }, off: "accepted", on: "accepted" },
  { name: "Host names another host; Origin matches the URL", headers: { host: "troy.example", origin: "http://ithaca.example" }, off: "refused", on: "refused" },
];

async function outcome(route: Route, trustProxy: boolean, headers: Record<string, string>): Promise<Outcome> {
  const response = await route.app(trustProxy).request(`http://ithaca.example${route.path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}",
  });
  if (response.status !== 403) return "accepted";
  expect(await response.json()).toEqual({ code: "unauthorized", reason: route.reason, retryable: false });
  return "refused";
}

describe("exact-Origin refusals", () => {
  for (const route of ROUTES) for (const trustProxy of [false, true]) for (const row of ROWS) {
    test(`${route.name}, trustProxy ${trustProxy ? "on" : "off"}: ${row.name}`, async () => {
      const expected = (route.name === "owner-safety-review" && row.safetyReview) || row;
      expect(await outcome(route, trustProxy, row.headers)).toBe(trustProxy ? expected.on : expected.off);
    });
  }
});
