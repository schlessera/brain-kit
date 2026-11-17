/**
 * Apify enablement, host-owned authentication and account binding (#3159),
 * against a loopback fake of the fixed Apify API and a real governance file.
 * Tokens are synthetic sentinels; nothing here reaches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env.js";
import type { Principal } from "../src/db/principals.js";
import {
  ApifyAuthorityError, createApifyAuthority, governanceApifyPolicy,
  type ApifyAuthority, type ApifyAuthorityRecord,
} from "@schlessera/brain-common/internal/apify";
import { createApifyRoutes } from "../src/routes/apify.js";

const SENTINEL = "apify_api_ODYSSEUS_SENTINEL_0f1e2d3c";
const ROTATED = "apify_api_ODYSSEUS_SENTINEL_rotated_9a8b";
const SUITORS = "apify_api_ODYSSEUS_SENTINEL_suitors_7c6d";
const ACCOUNTS: Record<string, { id: string; username: string }> = {
  [SENTINEL]: { id: "IthacaHousehold01", username: "penelope" },
  [ROTATED]: { id: "IthacaHousehold01", username: "penelope" },
  [SUITORS]: { id: "SuitorsHall02", username: "antinous" },
};

interface Seen { method: string; url: string; authorization: string | null }
interface Fake {
  origin: string; seen: Seen[];
  mode: "ok" | "revoked" | "unavailable" | "incompatible" | "redirect";
  stop(): void;
}

function fakeApify(redirectTo?: string): Fake {
  const fake: Fake = { origin: "", seen: [], mode: "ok", stop: () => undefined };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    fake.seen.push({ method: request.method, url: request.url, authorization });
    if (fake.mode === "unavailable") return new Response("maintenance", { status: 503 });
    if (fake.mode === "redirect") return new Response(null, { status: 302, headers: { location: `${redirectTo}${url.pathname}` } });
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const account = ACCOUNTS[token];
    if (fake.mode === "revoked" || !account) return Response.json({ error: { type: "token-not-valid", message: `Token ${token} is not valid` } }, { status: 401 });
    if (url.pathname === "/v2/users/me") {
      if (fake.mode === "incompatible") return Response.json({ data: { username: account.username } });
      return Response.json({ data: { ...account, email: "penelope@ithaca.example", plan: { id: "FREE" } } });
    }
    if (/^\/v2\/actor-runs\/[A-Za-z0-9]+(\/abort)?$/.test(url.pathname)) return Response.json({ data: { id: "VoyageRun01", status: url.pathname.endsWith("/abort") ? "ABORTING" : "RUNNING" } });
    if (url.pathname === "/v2/acts/odysseus~sea-charts") return Response.json({ data: { id: "SeaCharts01" } });
    return Response.json({ error: { type: "record-not-found" } }, { status: 404 });
  } });
  fake.origin = `http://127.0.0.1:${server.port}`;
  fake.stop = () => { void server.stop(true); };
  return fake;
}

let brain: string;
let fake: Fake;
let elsewhere: Fake;
let token: string | undefined;
let stored: unknown;
const writes: ApifyAuthorityRecord[] = [];

function policy(text: string | null) {
  const path = join(brain, "context/policies/governance.md");
  if (text === null) rmSync(path, { force: true });
  else writeFileSync(path, `---\nschema_version: 1\n${text}\n---\nOdysseus decides what leaves Ithaca.\n`);
}
function authority(): ApifyAuthority {
  return createApifyAuthority({
    policy: governanceApifyPolicy(brain), token: () => token, origin: fake.origin,
    store: { read: () => stored === undefined ? null : JSON.parse(JSON.stringify(stored)), write: record => { stored = JSON.parse(JSON.stringify(record)); writes.push(record); } },
  });
}
async function refusal(promise: Promise<unknown>, label = "refusal"): Promise<ApifyAuthorityError> {
  try { await promise; } catch (error) { if (error instanceof ApifyAuthorityError) return error; throw error; }
  throw new Error(`${label}: expected an ApifyAuthorityError, but the call was admitted`);
}
/** Everything the authority produced or the fake observed, for the sentinel check. */
const disclosed = (...values: unknown[]) => JSON.stringify([values, stored, writes, fake.seen.map(s => s.url), elsewhere.seen]);

beforeEach(() => {
  brain = mkdtempSync(join(tmpdir(), "apify-ithaca-"));
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  elsewhere = fakeApify();
  fake = fakeApify(elsewhere.origin);
  token = SENTINEL; stored = undefined; writes.length = 0;
});
afterEach(() => { fake.stop(); elsewhere.stop(); rmSync(brain, { recursive: true, force: true }); });

describe("explicit enablement", () => {
  test("an ambient token leaves Apify disabled and contacts nothing, without a policy or with enabled: false", async () => {
    for (const text of [null, "profiles: { interactive: governed }", "apify: { enabled: false }"]) {
      policy(text);
      const apify = authority();
      const status = await apify.status({ refresh: true });
      expect(status, `APIFY_AMBIENT_TOKEN_DISABLED: ${text}`).toMatchObject({ state: "disabled", reason: "not_enabled", account: null });
      const error = await refusal(apify.admit());
      expect(error.code).toBe("provider_disabled");
      expect(error.message).toContain("apify.enabled: true");
      expect(disclosed(status, error.message)).not.toContain(SENTINEL);
    }
    expect(fake.seen, "APIFY_DISABLED_NO_PROBE").toEqual([]);
  });

  test("an invalid policy disables Apify rather than keeping an earlier enablement", async () => {
    policy("apify: { enabled: true }");
    const apify = authority();
    expect((await apify.status()).state).toBe("configured");
    const { binding } = await apify.admit();
    const seen = fake.seen.length;
    policy("apify: { enabled: true, token: smuggled }");
    expect(await apify.status()).toMatchObject({ state: "disabled", reason: "policy_invalid" });
    expect((await refusal(apify.request(binding, { method: "GET", path: "/v2/acts/odysseus~sea-charts" }))).code).toBe("provider_disabled");
    expect(fake.seen.length).toBe(seen);
  });
});

describe("host-owned authentication", () => {
  test("missing, rejected and unverifiable tokens refuse with actionable redacted errors and no fallback", async () => {
    policy("apify: { enabled: true }");
    token = undefined;
    expect(await authority().status()).toMatchObject({ state: "authentication_required", reason: "token_missing" });
    expect(fake.seen).toEqual([]);

    token = SENTINEL; fake.mode = "revoked";
    const rejected = authority();
    expect(await rejected.status()).toMatchObject({ state: "authentication_required", reason: "token_rejected", account: null });
    const error = await refusal(rejected.admit());
    expect(error.code).toBe("authentication_required");
    expect(error.message).toContain("APIFY_TOKEN");

    fake.mode = "unavailable";
    const down = await authority().status({ refresh: true });
    expect(down).toMatchObject({ state: "unavailable", reason: "upstream_unreachable" });
    fake.mode = "incompatible";
    const odd = authority();
    expect(await odd.status({ refresh: true })).toMatchObject({ state: "unavailable", reason: "upstream_incompatible" });
    expect((await refusal(odd.admit())).code).toBe("upstream_incompatible");
    expect(disclosed(error, down)).not.toContain(SENTINEL);
    expect(elsewhere.seen).toEqual([]);
  });

  test("the token travels only as a bearer header to the fixed origin; the account binds without email or plan", async () => {
    policy("apify: { enabled: true }");
    const apify = authority();
    const status = await apify.status();
    expect(status).toMatchObject({ state: "configured", reason: null, account: { id: "IthacaHousehold01", username: "penelope" } });
    expect(JSON.stringify(status)).not.toContain("ithaca.example");
    const { binding } = await apify.admit();
    const response = await apify.request(binding, { method: "GET", path: "/v2/acts/odysseus~sea-charts", query: { waitForFinish: 0 } });
    expect(response).toEqual({ status: 200, data: { data: { id: "SeaCharts01" } } });
    expect(fake.seen.length).toBeGreaterThan(0);
    for (const seen of fake.seen) {
      expect(seen.authorization, "APIFY_BEARER_ONLY").toBe(`Bearer ${SENTINEL}`);
      expect(seen.url).toStartWith(`${fake.origin}/v2/`);
    }
    expect(disclosed(status, response), "APIFY_SENTINEL_UNDISCLOSED").not.toContain(SENTINEL);
  });

  test("callers choose neither origin, query credentials nor redirect recipients", async () => {
    policy("apify: { enabled: true }");
    const apify = authority();
    const { binding } = await apify.admit();
    const before = fake.seen.length;
    for (const path of ["https://elsewhere.example/v2/acts", "//elsewhere.example/v2/acts", "/v2/acts/../../users/me", "/v1/acts", "/v2/acts?token=x", "/v2/acts#x"])
      await expect(apify.request(binding, { method: "GET", path }), `APIFY_FIXED_PATH: ${path}`).rejects.toThrow(TypeError);
    await expect(apify.request(binding, { method: "GET", path: "/v2/acts", query: { token: SENTINEL } })).rejects.toThrow(TypeError);
    await expect(apify.request(binding, { method: "GET", path: "/v2/acts", query: { Token: "x" } })).rejects.toThrow(TypeError);
    expect(fake.seen.length).toBe(before);

    fake.mode = "redirect";
    const outcome = await apify.request(binding, { method: "GET", path: "/v2/acts/odysseus~sea-charts" }).catch((error: unknown) => error);
    expect(elsewhere.seen, "APIFY_REDIRECT_NOT_FOLLOWED").toEqual([]);
    expect(outcome).toBeInstanceOf(ApifyAuthorityError);
    expect((outcome as ApifyAuthorityError).code).toBe("upstream_incompatible");
  });
});

describe("account binding and revocation", () => {
  test("a token rotated to the same account keeps authority across a restart", async () => {
    policy("apify: { enabled: true }");
    const { binding } = await authority().admit();
    token = ROTATED;
    const restarted = authority();
    expect(await restarted.status()).toMatchObject({ state: "configured", account: { id: "IthacaHousehold01" } });
    await restarted.check(binding);
    const response = await restarted.request(binding, { method: "GET", path: "/v2/acts/odysseus~sea-charts" });
    expect(response.status).toBe(200);
    expect(fake.seen.at(-1)?.authorization).toBe(`Bearer ${ROTATED}`);
  });

  test("a different account invalidates earlier authority until an owner confirms it", async () => {
    policy("apify: { enabled: true }");
    const household = authority();
    const { binding } = await household.admit();
    token = SUITORS;
    const status = await household.status();
    expect(status, "APIFY_ACCOUNT_CHANGE_REQUIRES_CONFIRMATION").toMatchObject({ state: "authentication_required", reason: "account_changed",
      account: { id: "IthacaHousehold01" }, pending_account: { id: "SuitorsHall02", username: "antinous" } });
    expect((await refusal(household.admit())).code).toBe("authentication_required");
    const stale = await refusal(household.request(binding, { method: "GET", path: "/v2/acts/odysseus~sea-charts" }));
    expect(stale.code, "APIFY_STALE_BINDING_REFUSED").toBe("proposal_stale");
    expect(fake.seen.filter(seen => !seen.url.endsWith("/v2/users/me"))).toEqual([]);

    expect((await refusal(household.confirmAccount("IthacaHousehold01"))).code).toBe("proposal_stale");
    expect(await household.confirmAccount("SuitorsHall02")).toMatchObject({ state: "configured", account: { id: "SuitorsHall02" } });
    const confirmed = await household.admit();
    expect(confirmed.binding.generation).not.toBe(binding.generation);
    expect((await refusal(household.check(binding))).code).toBe("proposal_stale");
    // Changing back is a change too: the first account's old authority stays stale.
    token = SENTINEL;
    expect((await household.status()).reason).toBe("account_changed");
    await household.confirmAccount("IthacaHousehold01");
    expect((await refusal(household.check(binding))).code).toBe("proposal_stale");
  });

  test("disablement stops new work, keeps owned cleanup, and re-enabling does not revive old authority", async () => {
    policy("apify: { enabled: true }");
    const apify = authority();
    const { binding } = await apify.admit();
    policy("apify: { enabled: false }");
    const before = fake.seen.length;
    expect((await refusal(apify.request(binding, { method: "GET", path: "/v2/acts/odysseus~sea-charts" }))).code, "APIFY_DISABLED_NO_NEW_CALL").toBe("provider_disabled");
    expect(fake.seen.length).toBe(before);
    const abort = await apify.cleanupRequest(binding, { method: "POST", path: "/v2/actor-runs/VoyageRun01/abort" });
    expect(abort.data).toEqual({ data: { id: "VoyageRun01", status: "ABORTING" } });
    expect((await apify.cleanupRequest(binding, { method: "GET", path: "/v2/actor-runs/VoyageRun01" })).status).toBe(200);
    await expect(apify.cleanupRequest(binding, { method: "POST", path: "/v2/acts/odysseus~sea-charts/runs" })).rejects.toThrow(TypeError);
    await expect(apify.cleanupRequest(binding, { method: "GET", path: "/v2/actor-runs/VoyageRun01/abort" })).rejects.toThrow(TypeError);

    policy("apify: { enabled: true }");
    expect((await apify.status()).state).toBe("configured");
    expect((await refusal(apify.check(binding), "APIFY_REENABLE_STALE")).code, "APIFY_REENABLE_STALE").toBe("proposal_stale");
    expect((await apify.admit()).binding.generation).not.toBe(binding.generation);
  });

  test("a revoked token mid-run invalidates authority and leaves cleanup unresolved", async () => {
    policy("apify: { enabled: true }");
    const apify = authority();
    const { binding } = await apify.admit();
    fake.mode = "revoked";
    const error = await refusal(apify.request(binding, { method: "GET", path: "/v2/actor-runs/VoyageRun01" }));
    expect(error.code).toBe("authentication_required");
    expect(error.reason).toBe("token_rejected");
    expect((await refusal(apify.check(binding))).code).toBe("proposal_stale");
    expect((await refusal(apify.cleanupRequest(binding, { method: "POST", path: "/v2/actor-runs/VoyageRun01/abort" }))).code).toBe("authentication_required");
    token = undefined;
    expect((await refusal(apify.cleanupRequest(binding, { method: "POST", path: "/v2/actor-runs/VoyageRun01/abort" }))).reason).toBe("token_missing");
    expect(disclosed(error)).not.toContain(SENTINEL);
  });

  test("unreadable host state vouches for no account and needs an owner's confirmation", async () => {
    policy("apify: { enabled: true }");
    stored = { version: 1, generation: 7 };
    const apify = authority();
    expect(await apify.status()).toMatchObject({ state: "authentication_required", reason: "account_changed", account: null, pending_account: { id: "IthacaHousehold01" } });
    await apify.confirmAccount("IthacaHousehold01");
    expect((await apify.status()).state).toBe("configured");
  });
});

describe("settings routes", () => {
  const owner = { id: "p-penelope", kind: "owner" } as Principal;
  const agent = { id: "p-athena", kind: "agent" } as Principal;
  function app(principal: Principal | null, live = true) {
    const routes = new Hono<AppEnv>().use("*", async (c, next) => { if (principal) c.set("principal", principal); await next(); });
    return routes.route("/api", createApifyRoutes({ authority: authority(), authorized: id => live && id === owner.id }));
  }
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" } });

  test("only a live human owner reads state or confirms an account, and no route returns a token", async () => {
    policy("apify: { enabled: true }");
    expect((await app(null).request("/api/apify")).status).toBe(401);
    expect((await app(agent).request("/api/apify")).status, "APIFY_ROUTE_AGENT_REFUSED").toBe(403);
    expect((await app(owner, false).request("/api/apify")).status, "APIFY_ROUTE_REVOKED_OWNER_REFUSED").toBe(403);
    expect((await app(agent).request("/api/apify/account", post({ account_id: "SuitorsHall02" }))).status).toBe(403);
    expect(fake.seen).toEqual([]);

    const read = await app(owner).request("/api/apify");
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    const body = await read.text();
    expect(JSON.parse(body)).toMatchObject({ state: "configured", account: { id: "IthacaHousehold01" } });
    expect(body).not.toContain(SENTINEL);

    token = SUITORS;
    const changed = app(owner);
    expect(await (await changed.request("/api/apify")).json()).toMatchObject({ reason: "account_changed", pending_account: { id: "SuitorsHall02" } });
    expect((await changed.request("/api/apify/account", post({ account_id: "SuitorsHall02", token: SUITORS }))).status).toBe(400);
    const wrong = await changed.request("/api/apify/account", post({ account_id: "IthacaHousehold01" }));
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: "proposal_stale" });
    const confirmed = await changed.request("/api/apify/account", post({ account_id: "SuitorsHall02" }));
    expect(confirmed.status).toBe(200);
    const text = await confirmed.text();
    expect(JSON.parse(text)).toMatchObject({ state: "configured", account: { id: "SuitorsHall02" } });
    expect(text).not.toContain(SUITORS);
  });

  test("confirming refuses while disabled and contacts nothing", async () => {
    policy(null);
    const response = await app(owner).request("/api/apify/account", post({ account_id: "IthacaHousehold01" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "provider_disabled", reason: "not_enabled" });
    expect(fake.seen).toEqual([]);
  });
});
