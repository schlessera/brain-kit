import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSignedCookie } from "hono/cookie";

import type { AppEnv } from "../src/app-env";
import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import { createPrincipal, revokePrincipal, type Principal } from "../src/db/principals";
import {
  coveringReferenceGrant,
  createReferenceGrant,
  isLiveReferenceGrant,
  MAX_LIVE_REFERENCE_GRANTS,
  referenceRepository,
  revokeReferenceGrant,
} from "../src/db/reference-grants";
import { authGuard, type AuthRuntime } from "../src/middleware/auth";
import { principalManagementRoutes } from "../src/middleware/principals";

const SECRET = "test-cookie-secret-0123456789abcdef";
const BRAIN = "ithaca-brain";
const DAY = 24 * 60 * 60;
const db = createUiDb(":memory:");
const config = resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-test-hash", COOKIE_SECRET: SECRET });
const auth: AuthRuntime = { ...config.auth, host: config.host };
let revoked: Array<{ grantIds: string[]; principalIds: string[] }>;

beforeEach(() => {
  db.exec("DELETE FROM reference_grants; DELETE FROM principals;");
  revoked = [];
});

const owner = (): Principal => createPrincipal(db, { authMethod: "password", label: "Penelope's loom", ttlSeconds: 30 * DAY });
const agent = (createdBy: string): Principal => createPrincipal(db, { authMethod: "delegated", label: "Telemachus", createdBy, ttlSeconds: 7 * DAY });
const grant = (principalId: string, createdBy: string, repositoryPrefix: unknown, credential: unknown = null, brain = BRAIN) =>
  createReferenceGrant(db, { brain, principalId, repositoryPrefix, credential, createdBy, now: Date.now() });
const covering = (principalId: string, repository: string, brain = BRAIN) =>
  coveringReferenceGrant(db, { brain, principalId, repository: referenceRepository(repository), now: Date.now() });

describe("reference repository locations", () => {
  test("canonicalize hosted locations and keep local paths exact", () => {
    expect(referenceRepository("https://GitHub.com/odysseus/ithaca.git/")).toMatchObject({ canonical: "https://github.com/odysseus/ithaca", url: "https://github.com/odysseus/ithaca.git", scheme: "https" });
    expect(referenceRepository("http://127.0.0.1:8418/odysseus/ithaca")).toMatchObject({ loopback: true, origin: "http://127.0.0.1:8418" });
    expect(referenceRepository("file:///srv/fixtures/ithaca.git")).toMatchObject({ canonical: "file:///srv/fixtures/ithaca.git", scheme: "file" });
    expect(referenceRepository("https://github.com", { prefix: true }).canonical).toBe("https://github.com");
  });

  test("refuse credentials, other schemes, non-loopback http, dot segments and encoded paths", () => {
    for (const input of ["https://token@github.com/odysseus/ithaca", "https://github.com/odysseus/ithaca?ref=main", "ssh://git@github.com/odysseus/ithaca",
      "git@github.com:odysseus/ithaca", "http://example.com/odysseus/ithaca", "https://github.com/odysseus/../penelope", "https://github.com/odysseus/%2e%2e/x",
      "https://github.com//ithaca", "file://host/srv/ithaca", "file:///", "https://github.com", "https://github.com/odysseus/ith aca", "https://github.com/odysseus\\ithaca"])
      expect(() => referenceRepository(input), input).toThrow();
  });
});

describe("reference grant records", () => {
  test("a live covering grant authorizes only its own brain, principal and path-segment prefix", () => {
    const penelope = owner(), telemachus = agent(penelope.id);
    const record = grant(telemachus.id, penelope.id, "https://github.com/odysseus", "BRAIN_UI_SYNC_GITHUB_TOKEN");
    expect(covering(telemachus.id, "https://github.com/odysseus/ithaca.git")?.id).toBe(record.id);
    expect(covering(telemachus.id, "https://github.com/odysseus")?.id).toBe(record.id);
    // Principal and domain substitution, sibling prefixes and other brains never match.
    expect(covering(penelope.id, "https://github.com/odysseus/ithaca"), "REFERENCE_GRANT_PRINCIPAL_SUBSTITUTION").toBeNull();
    expect(covering(telemachus.id, "https://github.com/odysseus-crew/ithaca"), "REFERENCE_GRANT_PREFIX_BOUNDARY").toBeNull();
    expect(covering(telemachus.id, "https://github.com.evil.example/odysseus/ithaca")).toBeNull();
    expect(covering(telemachus.id, "https://github.com/odysseus/ithaca", "another-brain"), "REFERENCE_GRANT_BRAIN_SUBSTITUTION").toBeNull();
  });

  test("the longest covering prefix wins", () => {
    const penelope = owner();
    grant(penelope.id, penelope.id, "https://github.com/odysseus", "GITHUB_TOKEN");
    const narrow = grant(penelope.id, penelope.id, "https://github.com/odysseus/ithaca", "BRAIN_UI_SYNC_GITHUB_TOKEN");
    expect(covering(penelope.id, "https://github.com/odysseus/ithaca")?.credential).toBe(narrow.credential);
  });

  test("revoking the grant or its principal removes authority immediately", () => {
    const penelope = owner(), telemachus = agent(penelope.id);
    const first = grant(telemachus.id, penelope.id, "file:///srv/fixtures");
    expect(isLiveReferenceGrant(db, first.id, Date.now())).toBe(true);
    expect(revokeReferenceGrant(db, { brain: BRAIN, principalId: telemachus.id, id: first.id, now: Date.now() })?.id).toBe(first.id);
    expect(covering(telemachus.id, "file:///srv/fixtures/ithaca"), "REFERENCE_GRANT_REVOCATION").toBeNull();
    expect(isLiveReferenceGrant(db, first.id, Date.now())).toBe(false);
    const second = grant(telemachus.id, penelope.id, "file:///srv/fixtures");
    revokePrincipal(db, telemachus.id, Date.now());
    expect(covering(telemachus.id, "file:///srv/fixtures/ithaca"), "REFERENCE_GRANT_PRINCIPAL_REVOCATION").toBeNull();
    expect(isLiveReferenceGrant(db, second.id, Date.now())).toBe(false);
  });

  test("an expired principal holds no authority", () => {
    const penelope = owner(), telemachus = agent(penelope.id);
    grant(telemachus.id, penelope.id, "file:///srv/fixtures");
    expect(coveringReferenceGrant(db, { brain: BRAIN, principalId: telemachus.id, repository: referenceRepository("file:///srv/fixtures/x"), now: Date.now() + 8 * DAY * 1000 })).toBeNull();
  });

  test("credentials are a fixed list, sent only to their own origin or loopback, never to file paths", () => {
    const penelope = owner();
    expect(() => grant(penelope.id, penelope.id, "https://gitlab.example/odysseus", "GITHUB_TOKEN")).toThrow("may only be sent to https://github.com");
    expect(() => grant(penelope.id, penelope.id, "https://github.com/odysseus", "BRAIN_UI_COOKIE_SECRET")).toThrow("credential must be null or one of");
    expect(() => grant(penelope.id, penelope.id, "file:///srv/fixtures", "GITHUB_TOKEN")).toThrow("without any credential");
    expect(() => grant(penelope.id, penelope.id, "https://github.com/odysseus", 7)).toThrow("string or null");
    expect(grant(penelope.id, penelope.id, "http://127.0.0.1:8418/odysseus", "GITHUB_TOKEN").credential).toBe("GITHUB_TOKEN");
  });

  test("grants require a live owner creator and a live cookie-bearing target, and refuse duplicates and overflow", () => {
    const penelope = owner(), telemachus = agent(penelope.id);
    expect(() => grant(penelope.id, telemachus.id, "file:///srv/fixtures")).toThrow("live owner or agent");
    expect(() => grant("no-such-principal", penelope.id, "file:///srv/fixtures")).toThrow("live owner or agent");
    grant(penelope.id, penelope.id, "file:///srv/fixtures");
    expect(() => grant(penelope.id, penelope.id, "file:///srv/fixtures")).toThrow("identical live reference grant");
    for (let index = 1; index < MAX_LIVE_REFERENCE_GRANTS; index++) grant(penelope.id, penelope.id, `file:///srv/fixtures/${index}`);
    expect(() => grant(penelope.id, penelope.id, "file:///srv/overflow")).toThrow("limit");
  });
});

describe("owner-only reference grant routes", () => {
  async function cookie(id: string) {
    const serialized = await generateSignedCookie("brain_ui_session", id, SECRET);
    return `brain_ui_session=${decodeURIComponent(serialized.slice(serialized.indexOf("=") + 1, serialized.indexOf(";")))}`;
  }
  function app() {
    const instance = new Hono<AppEnv>();
    instance.use("/api/*", authGuard("password", auth, db));
    instance.route("/api", principalManagementRoutes("password", auth, { db, brain: BRAIN, revoker: { revokePrincipals() {} },
      referenceAuthorityRevoked: (input) => { revoked.push(input); } }));
    return instance;
  }
  const json = (method: string, header: string, body?: unknown): RequestInit => ({ method, headers: { cookie: header, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("an owner creates, lists and revokes a principal's grants", async () => {
    const penelope = owner(), telemachus = agent(penelope.id), header = await cookie(penelope.id), instance = app();
    const created = await instance.request(`/api/auth/principals/${telemachus.id}/reference-grants`, json("POST", header,
      { repositoryPrefix: "https://github.com/odysseus/ithaca.git", credential: "BRAIN_UI_SYNC_GITHUB_TOKEN" }));
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string };
    expect(body).toMatchObject({ principal_id: telemachus.id, repository_prefix: "https://github.com/odysseus/ithaca", credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", created_by: penelope.id });
    expect(Object.keys(body).sort()).toEqual(["created_at", "created_by", "credential", "id", "principal_id", "repository_prefix"]);
    const listed = await instance.request(`/api/auth/principals/${telemachus.id}/reference-grants`, { headers: { cookie: header } });
    expect(((await listed.json()) as { grants: { id: string }[] }).grants.map(item => item.id)).toEqual([body.id]);
    expect((await instance.request(`/api/auth/principals/${penelope.id}/reference-grants/${body.id}`, json("DELETE", header))).status).toBe(404);
    expect((await instance.request(`/api/auth/principals/${telemachus.id}/reference-grants/${body.id}`, json("DELETE", header))).status).toBe(200);
    expect(revoked).toEqual([{ grantIds: [body.id], principalIds: [] }]);
    expect((await instance.request(`/api/auth/principals/${telemachus.id}/reference-grants/${body.id}`, json("DELETE", header))).status).toBe(404);
    expect(covering(telemachus.id, "https://github.com/odysseus/ithaca")).toBeNull();
  });

  test("principal revocation reports lost reference authority", async () => {
    const penelope = owner(), telemachus = agent(penelope.id), header = await cookie(penelope.id);
    expect((await app().request(`/api/auth/principals/${telemachus.id}`, json("DELETE", header))).status).toBe(200);
    expect(revoked).toEqual([{ grantIds: [], principalIds: [telemachus.id] }]);
  });

  test("validation, unknown principals, duplicates and non-owners refuse", async () => {
    const penelope = owner(), telemachus = agent(penelope.id), header = await cookie(penelope.id), instance = app();
    const post = (target: string, body: unknown, as = header) => instance.request(`/api/auth/principals/${target}/reference-grants`, json("POST", as, body));
    expect((await post(telemachus.id, { repositoryPrefix: "ssh://git@github.com/odysseus" })).status).toBe(400);
    expect((await post(telemachus.id, { repositoryPrefix: "https://github.com/odysseus", credential: "HOME" })).status).toBe(400);
    expect((await post(telemachus.id, [])).status).toBe(400);
    expect((await post("missing", { repositoryPrefix: "https://github.com/odysseus" })).status).toBe(404);
    expect((await instance.request("/api/auth/principals/missing/reference-grants", { headers: { cookie: header } })).status).toBe(404);
    expect((await post(telemachus.id, { repositoryPrefix: "https://github.com/odysseus" })).status).toBe(201);
    expect((await post(telemachus.id, { repositoryPrefix: "https://github.com/odysseus/" })).status).toBe(409);
    expect((await post(telemachus.id, { repositoryPrefix: "https://github.com/odysseus/crew" }, await cookie(telemachus.id))).status, "REFERENCE_GRANT_OWNER_ONLY").toBe(403);
  });
});
