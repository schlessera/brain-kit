import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressProxy } from "../../ui-sdk/src/server/egress-proxy";
import { createGitHubReferenceAccess } from "../src/brain/github-reference-access";
import { createUiDb } from "../src/db/client";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import type { ReferenceTransport } from "../src/brain/reference-transport";
import { fixtureTls } from "./fixtures/fixture-tls";

let root: string, tls: ReturnType<typeof fixtureTls>;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "odysseus-reference-access-")); tls = fixtureTls(root, ["api.github.com"]); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const brain = "ithaca-brain", token = "odysseus-fixture-token", commit = "a".repeat(40);
const identity = (privateSource = false) => ({ id: 101, owner: { id: 201, login: "Odysseus" }, name: "Ithaca", full_name: "Odysseus/Ithaca",
  clone_url: "https://github.com/Odysseus/Ithaca.git", url: "https://api.github.com/repos/Odysseus/Ithaca", private: privateSource });

async function fixture(options: {
  private?: boolean;
  metadata?: (request: Request) => Response | Promise<Response>;
  lookup?: (hostname: string, input: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
  credentials?: Readonly<Record<string, string | undefined>>;
  fetchCommit?: string;
} = {}) {
  const db = createUiDb(":memory:"), owner = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Telemachus", createdBy: owner.id, ttlSeconds: 3600 });
  const received: { path: string; authorization: string | null }[] = [], git: unknown[] = [], connections: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    received.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    if (options.metadata) return options.metadata(request);
    if (options.private && !request.headers.has("authorization")) return new Response(null, { status: 404 });
    return Response.json(identity(options.private));
  } });
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 1048576, observe() {} });
  const credentials = options.credentials ?? { GITHUB_TOKEN: token };
  const transport: ReferenceTransport = {
    async resolve(input) { git.push(input); return { ok: true, commit, ref: "refs/heads/main" }; },
    async fetch(input) { git.push(input); return { commit: options.fetchCommit ?? commit }; },
    async checkout() { throw new Error("The scripted network binding control must not check out source"); },
  };
  const service = (servedBrain = brain) => createGitHubReferenceAccess({ db, brain: servedBrain, credentials, transport, wireTransport: {
    ca: readFileSync(tls.ca, "utf8"), lookup: options.lookup ?? (async () => [{ address: "93.184.216.34", family: 4 }]),
    connect: ((input: unknown) => { connections.push(input); return connect({ host: "127.0.0.1", port: server.port! }); }) as typeof connect,
  } });
  const bounds = { egress, maxBytes: 1048576 };
  const open = (principalId = agent.id, servedBrain = brain) => service(servedBrain).open({ ...bounds, repository: "odysseus/ithaca", revision: "main", principalId });
  const grant = (extra: Partial<Parameters<typeof createReferenceGrant>[1]> = {}) => createReferenceGrant(db, {
    brain, principalId: agent.id, createdBy: owner.id, repositoryPrefix: "https://github.com/odysseus", credential: "GITHUB_TOKEN",
    metadataCredentialRecipient: "https://api.github.com", now: Date.now(), ...extra,
  });
  return { db, owner, agent, egress, service, bounds, open, grant, received, git, connections,
    async close() { egress.stop(); server.stop(true); db.close(); } };
}

test("a missing suffix repository cannot dispatch metadata credentials to its neighbor", async () => {
  const f = await fixture({ metadata: request => {
    if (new URL(request.url).pathname === "/repos/odysseus/ithaca.git" || !request.headers.has("authorization")) return new Response(null, { status: 404 });
    return Response.json(identity(true));
  } });
  f.grant({ repositoryPrefix: "https://github.com/odysseus/ithaca.git.git" });
  try {
    const pending = f.service().open({ ...f.bounds, principalId: f.agent.id, repository: "odysseus/ithaca.git.git", revision: "main" });
    try { await expect(pending, "SUFFIX_GRANT_CANNOT_OPEN_NEIGHBOR_METADATA").rejects.toMatchObject({ reason: "denied" }); }
    finally { await pending.then(value => value.close(), () => {}); }
    expect(f.received, "SUFFIX_CREDENTIAL_DISPATCH_RETAINS_REQUESTED_REPOSITORY").toEqual([
      { path: "/repos/odysseus/ithaca.git", authorization: null },
      { path: "/repos/odysseus/ithaca.git", authorization: `Bearer ${token}` },
    ]);
    expect(f.git).toEqual([]);
  } finally { await f.close(); }
});

test("a literal suffix stays bound across metadata, Git wiring and final validation", async () => {
  const f = await fixture({ metadata: request => !request.headers.has("authorization") ? new Response(null, { status: 404 })
    : Response.json({ ...identity(true), name: "Ithaca.git", full_name: "Odysseus/Ithaca.git",
      clone_url: "https://github.com/Odysseus/Ithaca.git.git", url: "https://api.github.com/repos/Odysseus/Ithaca.git" }) });
  f.grant({ repositoryPrefix: "https://github.com/odysseus/ithaca.git.git" });
  try {
    const pending = f.service().open({ ...f.bounds, principalId: f.agent.id, repository: "odysseus/ithaca.git.git", revision: "main" });
    await expect(pending, "SUFFIX_ACQUISITION_RETAINS_LITERAL_IDENTITY").resolves.toMatchObject({ identity: { repository: "ithaca.git" } });
    const access = await pending;
    try {
      await access.resolve(); await access.fetch("/unused");
      await expect(access.revalidate(), "SUFFIX_FINAL_METADATA_RETAINS_LITERAL_IDENTITY").resolves.toBeUndefined();
      expect(f.received.every(value => value.path === "/repos/odysseus/ithaca.git"), "SUFFIX_METADATA_NEVER_SELECTS_NEIGHBOR").toBe(true);
      for (const input of f.git) expect(input, "SUFFIX_GIT_WIRE_MATCHES_REQUESTED_REPOSITORY").toMatchObject({
        repository: { canonical: "https://github.com/odysseus/ithaca.git", url: "https://github.com/odysseus/ithaca.git.git" },
        wire: { repository: "https://github.com/odysseus/ithaca.git" },
      });
    } finally { await access.close(); }
  } finally { await f.close(); }
});

test("public identity and scripted Git binding stay anonymous even with a host token and covering private grant", async () => {
  const f = await fixture(); f.grant();
  try {
    const access = await f.open();
    try {
      expect(access.domain).toBe("public"); expect(access.grantId).toBeNull();
      expect(access.identity).toMatchObject({ repositoryId: "101", ownerId: "201", private: false });
      expect(access.identity).not.toHaveProperty("verifiedBy");
      expect(access).not.toHaveProperty("wire"); expect(access).not.toHaveProperty("token");
      expect(access).not.toHaveProperty("metadata"); expect(access).not.toHaveProperty("gitProxyUrl");
      await access.resolve(); await access.fetch("/unused"); await access.revalidate();
      expect(f.received.map(value => value.authorization), "REFERENCE_PUBLIC_METADATA_ALWAYS_ANONYMOUS").toEqual([null, null]);
      expect(f.git).toHaveLength(2);
      for (const input of f.git) expect(input).toMatchObject({ token: null, wire: { repository: "https://github.com/odysseus/ithaca" } });
    } finally { await access.close(); }
  } finally { await f.close(); }
});

test("private metadata and scripted Git bind one selected grant and independent API recipient permission", async () => {
  const f = await fixture({ private: true }), grant = f.grant();
  try {
    const access = await f.open();
    try {
      expect(access.domain).toBe("private"); expect(access.grantId).toBe(grant.id);
      await access.resolve(); await access.fetch("/unused"); await access.revalidate();
      expect(f.received.map(value => value.authorization), "REFERENCE_PRIVATE_RECIPIENT_SEPARATELY_AUTHORIZED").toEqual([null, `Bearer ${token}`, `Bearer ${token}`]);
      for (const input of f.git) expect(input).toMatchObject({ token, wire: { repository: "https://github.com/odysseus/ithaca" } });
    } finally { await access.close(); }
  } finally { await f.close(); }
});

for (const kind of ["absent", "legacy", "other-brain", "other-principal", "sibling-repository", "revoked", "credentialless"] as const)
  test(`private metadata refuses ${kind} authority before reading or dispatching the host credential`, async () => {
    let tokenReads = 0;
    const f = await fixture({ private: true, credentials: { get GITHUB_TOKEN() { tokenReads++; return token; } } });
    try {
      if (kind !== "absent") {
        const grant = f.grant(kind === "legacy" ? { metadataCredentialRecipient: null }
          : kind === "other-brain" ? { brain: "troy-brain" }
          : kind === "other-principal" ? { principalId: f.owner.id }
          : kind === "sibling-repository" ? { repositoryPrefix: "https://github.com/odysseus-crew" }
          : kind === "credentialless" ? { credential: null, metadataCredentialRecipient: null } : {});
        if (kind === "revoked") revokeReferenceGrant(f.db, { brain, principalId: f.agent.id, id: grant.id, now: Date.now() });
      }
      await expect(f.open(), "REFERENCE_PRIVATE_LIVE_GRANT_AND_API_PERMISSION_REQUIRED").rejects.toMatchObject({ reason: "denied" });
      expect(tokenReads, "REFERENCE_NO_GRANT_NEVER_PROBES_CREDENTIAL").toBe(0);
      expect(f.received.map(value => value.authorization)).toEqual([null]); expect(f.git).toEqual([]);
    } finally { await f.close(); }
  });

for (const kind of ["revoke", "replace", "narrower", "principal", "recipient", "credential"] as const)
  test(`private acquisition refuses ${kind} change after opening and before later Git dispatch`, async () => {
    const credentials: Record<string, string> = { GITHUB_TOKEN: token };
    const f = await fixture({ private: true, credentials }), grant = f.grant();
    try {
      const access = await f.open();
      try {
        if (kind === "revoke" || kind === "replace") {
          revokeReferenceGrant(f.db, { brain, principalId: f.agent.id, id: grant.id, now: Date.now() });
          if (kind === "replace") f.grant();
        } else if (kind === "narrower") f.grant({ repositoryPrefix: "https://github.com/odysseus/ithaca" });
        else if (kind === "principal") revokePrincipal(f.db, f.agent.id, Date.now());
        else if (kind === "recipient") f.db.query("UPDATE reference_grants SET metadata_credential_recipient=NULL WHERE id=?").run(grant.id);
        else credentials.GITHUB_TOKEN = "another-fixture-token";
        expect(() => access.assertCurrent(), "REFERENCE_SELECTED_AUTHORITY_CANNOT_BE_REPLACED").toThrow();
        await expect(access.resolve()).rejects.toThrow(); await expect(access.fetch("/unused")).rejects.toThrow();
        expect(f.git, "REFERENCE_CHANGED_AUTHORITY_NEVER_DISPATCHES_GIT").toEqual([]);
      } finally { await access.close(); }
    } finally { await f.close(); }
  });

test("private grant revocation while credentialed DNS waits stops before the second TCP connection", async () => {
  let release!: () => void, ready!: () => void, lookups = 0;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ private: true, lookup: async () => { if (++lookups === 2) { ready(); await held; } return [{ address: "93.184.216.34", family: 4 }]; } });
  const grant = f.grant(), pending = f.open();
  try {
    await reached; revokeReferenceGrant(f.db, { brain, principalId: f.agent.id, id: grant.id, now: Date.now() }); release();
    await expect(pending, "REFERENCE_ACTUAL_GRANT_RECHECKED_AFTER_DNS").rejects.toThrow();
    expect(f.connections, "REFERENCE_REVOKED_CREDENTIAL_NEVER_REACHES_TCP").toHaveLength(1);
    expect(f.received.map(value => value.authorization)).toEqual([null]);
  } finally { release(); await pending.then(value => value.close(), () => {}); await f.close(); }
});

test("changed remote identity and unknown metadata never become an unchanged acquisition", async () => {
  for (const change of [{ id: 102 }, { owner: { id: 202, login: "Odysseus" } }, { private: true }, { full_name: "Penelope/Loom" }]) {
    let reads = 0;
    const f = await fixture({ metadata: () => Response.json({ ...identity(), ...(reads++ ? change : {}) }) });
    try {
      const access = await f.open();
      try {
        await expect(access.revalidate(), "REFERENCE_LIVE_REMOTE_IDENTITY_CANNOT_CHANGE").rejects.toThrow();
        expect(() => access.assertCurrent(), "REFERENCE_IDENTITY_REFUSAL_INVALIDATES_ACQUISITION").toThrow();
        await expect(access.resolve()).rejects.toThrow(); expect(f.git).toEqual([]);
      }
      finally { await access.close(); }
    } finally { await f.close(); }
  }
  for (const status of [302, 403, 429, 500]) {
    const f = await fixture({ metadata: () => new Response(null, { status }) }); f.grant();
    try {
      await expect(f.open(), "REFERENCE_UNKNOWN_METADATA_NO_CREDENTIAL_FALLBACK").rejects.toThrow();
      expect(f.received.map(value => value.authorization)).toEqual([null]);
    } finally { await f.close(); }
  }
});

test("owner Settings identity is anonymous and owner-scoped, without approval or trust claims", async () => {
  const f = await fixture({ metadata: () => Response.json({ id: 201, login: "Odysseus", type: "User",
    url: "https://api.github.com/users/Odysseus", html_url: "https://github.com/Odysseus" }) });
  try {
    const result = await f.service().owner({ ...f.bounds, principalId: f.owner.id, owner: "odysseus" });
    expect(result).toMatchObject({ ownerId: "201", canonical: "https://github.com/odysseus" });
    expect(result).not.toHaveProperty("approvedOwnerBoundary"); expect(result).not.toHaveProperty("verifiedBy");
    await expect(f.service().owner({ ...f.bounds, principalId: f.agent.id, owner: "odysseus" }), "REFERENCE_OWNER_SETTINGS_STILL_OWNER_ONLY").rejects.toThrow();
    expect(f.received).toEqual([{ path: "/users/odysseus", authorization: null }]);
  } finally { await f.close(); }
});

test("Settings repository identity has no Git phase or revision and stays anonymous", async () => {
  const f = await fixture(); f.grant({ principalId: f.owner.id });
  try {
    const pending = Promise.resolve().then(() => f.service().repository({ ...f.bounds, principalId: f.owner.id, repository: "odysseus/ithaca" }));
    await expect(pending, "SETTINGS_REPOSITORY_RESOLVES_WITHOUT_GIT_OR_AGENT_TURN").resolves.toEqual({
      owner: "odysseus", repository: "ithaca", canonical: "https://github.com/odysseus/ithaca", cloneUrl: "https://github.com/odysseus/ithaca.git",
      metadataUrl: "https://api.github.com/repos/odysseus/ithaca", repositoryId: "101", ownerId: "201", private: false,
      assertAuthority: expect.any(Function),
    });
    expect(f.received).toEqual([{ path: "/repos/odysseus/ithaca", authorization: null }]);
    expect(f.git, "SETTINGS_METADATA_NEVER_DISPATCHES_GIT").toEqual([]);
    await expect(f.service().repository({ ...f.bounds, principalId: f.agent.id, repository: "odysseus/ithaca" }),
      "SETTINGS_PUBLIC_METADATA_REQUIRES_OWNER").rejects.toMatchObject({ reason: "denied" });
    expect(f.received).toHaveLength(1);
  } finally { await f.close(); }
});

test("owner metadata rechecks the Settings operation after its actual DNS wait", async () => {
  let release!: () => void, ready!: () => void, current = true;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ lookup: async () => { ready(); await held; return [{ address: "93.184.216.34", family: 4 }]; },
    metadata: () => Response.json({ id: 201, login: "Odysseus", type: "User", url: "https://api.github.com/users/Odysseus", html_url: "https://github.com/Odysseus" }) });
  const pending = f.service().owner({ ...f.bounds, principalId: f.owner.id, owner: "odysseus", current: () => current });
  try {
    await reached; current = false; release();
    const result = await pending.then(value => ({ ok: true, value }), () => ({ ok: false }));
    expect(result, "SETTINGS_OWNER_OPERATION_RECHECKED_AFTER_DNS").toEqual({ ok: false });
    expect(f.connections, "SETTINGS_ENDED_OWNER_OPERATION_NEVER_CONNECTS").toEqual([]);
    expect(f.received).toEqual([]);
  } finally { release(); await pending.catch(() => {}); await f.close(); }
});

test("private Settings metadata uses the owner's own live grant and separately permitted API recipient", async () => {
  const f = await fixture({ private: true });
  f.grant({ principalId: f.owner.id });
  try {
    await expect(f.service().repository({ ...f.bounds, principalId: f.owner.id, repository: "odysseus/ithaca" }),
      "SETTINGS_PRIVATE_METADATA_USES_OWN_GRANT").resolves.toMatchObject({ repositoryId: "101", ownerId: "201", private: true });
    expect(f.received).toEqual([{ path: "/repos/odysseus/ithaca", authorization: null },
      { path: "/repos/odysseus/ithaca", authorization: `Bearer ${token}` }]);
    await expect(f.service().repository({ ...f.bounds, principalId: f.agent.id, repository: "odysseus/ithaca" }),
      "SETTINGS_METADATA_REQUIRES_OWNER").rejects.toMatchObject({ reason: "denied" });
    expect(f.received).toHaveLength(2);
    expect(f.git).toEqual([]);
  } finally { await f.close(); }
});

for (const kind of ["grant", "replace", "narrower", "recipient", "credential", "principal", "operation", "cancel"] as const)
  test(`Settings metadata retains a final synchronous ${kind} authority fence after wire cleanup`, async () => {
    let current = true;
    const credentials: Record<string, string> = { GITHUB_TOKEN: token }, controller = new AbortController();
    const f = await fixture({ private: true, credentials }), grant = f.grant({ principalId: f.owner.id });
    try {
      const result = await f.service().repository({ ...f.bounds, principalId: f.owner.id, repository: "odysseus/ithaca",
        current: () => current, signal: controller.signal });
      expect(() => result.assertAuthority(), "SETTINGS_FRESH_METADATA_AUTHORITY_REMAINS_USABLE_AFTER_CLEANUP").not.toThrow();
      if (kind === "grant" || kind === "replace") {
        revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: grant.id, now: Date.now() });
        if (kind === "replace") f.grant({ principalId: f.owner.id });
      } else if (kind === "narrower") f.grant({ principalId: f.owner.id, repositoryPrefix: "https://github.com/odysseus/ithaca" });
      else if (kind === "recipient") f.db.query("UPDATE reference_grants SET metadata_credential_recipient=NULL WHERE id=?").run(grant.id);
      else if (kind === "credential") credentials.GITHUB_TOKEN = "changed-fixture-token";
      else if (kind === "principal") revokePrincipal(f.db, f.owner.id, Date.now());
      else if (kind === "operation") current = false;
      else controller.abort();
      expect(() => result.assertAuthority(), "SETTINGS_FINAL_PUBLICATION_FENCE_RETAINS_LOOKUP_AUTHORITY").toThrow();
      expect(f.received).toHaveLength(2); expect(f.git).toEqual([]);
    } finally { await f.close(); }
  });

for (const kind of ["absent", "legacy", "other-brain", "other-principal", "sibling-repository", "revoked", "credentialless"] as const)
  test(`Settings private metadata refuses ${kind} authority without credential probing`, async () => {
    let tokenReads = 0;
    const f = await fixture({ private: true, credentials: { get GITHUB_TOKEN() { tokenReads++; return token; } } });
    try {
      if (kind !== "absent") {
        const grant = f.grant({ principalId: f.owner.id, ...(kind === "legacy" ? { metadataCredentialRecipient: null }
          : kind === "other-brain" ? { brain: "troy-brain" }
          : kind === "other-principal" ? { principalId: f.agent.id }
          : kind === "sibling-repository" ? { repositoryPrefix: "https://github.com/odysseus-crew" }
          : kind === "credentialless" ? { credential: null, metadataCredentialRecipient: null } : {}) });
        if (kind === "revoked") revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: grant.id, now: Date.now() });
      }
      await expect(f.service().repository({ ...f.bounds, principalId: f.owner.id, repository: "odysseus/ithaca" }),
        "SETTINGS_METADATA_NEEDS_OWN_LIVE_GRANT_AND_API_PERMISSION").rejects.toMatchObject({ reason: "denied" });
      expect(tokenReads, "SETTINGS_METADATA_REFUSAL_NEVER_PROBES_CREDENTIAL").toBe(0);
      expect(f.received).toEqual([{ path: "/repos/odysseus/ithaca", authorization: null }]);
      expect(f.git).toEqual([]);
    } finally { await f.close(); }
  });

for (const kind of ["operation", "principal", "grant", "recipient", "credential", "cancel"] as const)
  test(`Settings private metadata fences ${kind} loss during credentialed DNS`, async () => {
    let release!: () => void, ready!: () => void, lookups = 0, current = true;
    const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const credentials: Record<string, string> = { GITHUB_TOKEN: token }, controller = new AbortController();
    const f = await fixture({ private: true, credentials, lookup: async () => {
      if (++lookups === 2) { ready(); await held; } return [{ address: "93.184.216.34", family: 4 }];
    } });
    const grant = f.grant({ principalId: f.owner.id });
    const pending = f.service().repository({ ...f.bounds, principalId: f.owner.id, repository: "odysseus/ithaca", current: () => current, signal: controller.signal });
    try {
      await reached;
      if (kind === "operation") current = false;
      else if (kind === "principal") revokePrincipal(f.db, f.owner.id, Date.now());
      else if (kind === "grant") revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: grant.id, now: Date.now() });
      else if (kind === "recipient") f.db.query("UPDATE reference_grants SET metadata_credential_recipient=NULL WHERE id=?").run(grant.id);
      else if (kind === "credential") credentials.GITHUB_TOKEN = "changed-fixture-token";
      else controller.abort();
      release();
      const result = await pending.then(value => ({ ok: true, value }), () => ({ ok: false }));
      expect(result, "SETTINGS_AUTHORITY_RECHECKED_AFTER_CREDENTIALED_DNS").toEqual({ ok: false });
      expect(f.connections, "SETTINGS_LOST_AUTHORITY_NEVER_REACHES_CREDENTIALED_TCP").toHaveLength(1);
      expect(f.received).toEqual([{ path: "/repos/odysseus/ithaca", authorization: null }]);
      expect(f.git).toEqual([]);
    } finally { release(); await pending.catch(() => {}); await f.close(); }
  });

for (const kind of ["owner", "repository"] as const)
  test(`Settings ${kind} identity retains its original caller and operation across waits`, async () => {
    let release!: () => void, ready!: () => void, current = true;
    const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ lookup: async () => { ready(); await held; return [{ address: "93.184.216.34", family: 4 }]; } });
    const input = { ...f.bounds, principalId: f.owner.id, owner: "odysseus", repository: "odysseus/ithaca", current: () => current };
    const pending = kind === "owner" ? f.service().owner(input) : f.service().repository(input);
    try {
      await reached; current = false;
      input.principalId = f.agent.id; input.current = () => true; input.owner = "penelope"; input.repository = "penelope/loom";
      release();
      expect(await pending.then(() => true, () => false), "SETTINGS_CALLER_MUTATION_CANNOT_REPLACE_OPERATION").toBe(false);
      expect(f.connections).toEqual([]); expect(f.received).toEqual([]);
    } finally { release(); await pending.catch(() => {}); await f.close(); }
  });

test("each Settings lookup observes fresh provider identity and refuses redirects or unknown metadata", async () => {
  const changes = [identity(), { ...identity(), id: 102 }, { ...identity(), owner: { id: 202, login: "Odysseus" } },
    { ...identity(), name: "Fleet", full_name: "Odysseus/Fleet", clone_url: "https://github.com/Odysseus/Fleet.git", url: "https://api.github.com/repos/Odysseus/Fleet" }];
  let selected = 0;
  const f = await fixture({ metadata: () => Response.json(changes[selected]) });
  try {
    const lookup = (repository = "odysseus/ithaca") => f.service().repository({ ...f.bounds, principalId: f.owner.id, repository });
    expect(await lookup()).toMatchObject({ repositoryId: "101", ownerId: "201" });
    selected = 1; expect(await lookup(), "SETTINGS_NAME_REUSE_RETURNS_NEW_IDENTITY").toMatchObject({ repositoryId: "102", ownerId: "201" });
    selected = 2; expect(await lookup(), "SETTINGS_OWNER_REUSE_RETURNS_NEW_BOUNDARY").toMatchObject({ repositoryId: "101", ownerId: "202" });
    selected = 3;
    await expect(lookup(), "SETTINGS_RENAME_CANNOT_BORROW_OLD_NAME_RESPONSE").rejects.toThrow();
    expect(await lookup("odysseus/fleet"), "SETTINGS_RENAME_REQUIRES_FRESH_EXACT_NAME_OBSERVATION").toMatchObject({ repositoryId: "101", ownerId: "201", repository: "fleet" });
    expect(f.git).toEqual([]);
  } finally { await f.close(); }
  for (const status of [302, 403, 429, 500]) {
    let tokenReads = 0;
    const control = await fixture({ metadata: () => new Response(null, { status }), credentials: { get GITHUB_TOKEN() { tokenReads++; return token; } } });
    control.grant({ principalId: control.owner.id });
    try {
      await expect(control.service().repository({ ...control.bounds, principalId: control.owner.id, repository: "odysseus/ithaca" }),
        "SETTINGS_UNKNOWN_METADATA_CANNOT_DISPATCH_CREDENTIAL").rejects.toThrow();
      expect(tokenReads).toBe(0); expect(control.received).toHaveLength(1); expect(control.git).toEqual([]);
    } finally { await control.close(); }
  }
});

test("Settings cancellation closes a pending DNS operation before that lookup finishes", async () => {
  let release!: () => void, ready!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const f = await fixture({ lookup: async () => { ready(); await held; return [{ address: "93.184.216.34", family: 4 }]; } });
  const pending = f.service().repository({ ...f.bounds, principalId: f.owner.id, repository: "odysseus/ithaca", signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await reached; controller.abort();
    const result = await Promise.race([pending.then(() => "identity", () => "cancelled"),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("still_waiting"), 5000); })]);
    expect(result, "SETTINGS_CANCEL_DOES_NOT_WAIT_FOR_DNS").toBe("cancelled");
    expect(f.connections).toEqual([]); expect(f.received).toEqual([]);
  } finally { if (timer) clearTimeout(timer); release(); await pending.catch(() => {}); await f.close(); }
});

test("one acquisition binds a short revision before network and refuses a moved fetched commit before checkout", async () => {
  const f = await fixture({ fetchCommit: "b".repeat(40) });
  try {
    await expect(f.service().open({ ...f.bounds, principalId: f.agent.id, repository: "odysseus/ithaca", revision: "refs/pull/1/head" }),
      "REFERENCE_ACCESS_REVISION_FIXED_BEFORE_METADATA").rejects.toMatchObject({ reason: "invalid" });
    expect(f.received).toEqual([]);
    const access = await f.open();
    try {
      await expect(access.fetch("/unused"), "REFERENCE_ACCESS_FETCH_NEEDS_RESOLVED_REF").rejects.toMatchObject({ reason: "invalid" });
      expect(f.git).toEqual([]); await access.resolve();
      await expect(access.fetch("/unused"), "REFERENCE_ACCESS_MOVED_FETCH_NOT_PUBLISHED").rejects.toMatchObject({ reason: "invalid" });
      expect(() => access.assertCurrent()).toThrow();
    } finally { await access.close(); }
  } finally { await f.close(); }
});
