import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressProxy } from "../../ui-sdk/src/server/egress-proxy";
import { createGitHubReferenceAccess } from "../src/brain/github-reference-access";
import { createReferenceSources } from "../src/brain/reference-source";
import type { ReferenceTransport } from "../src/brain/reference-transport";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import { fixtureTls } from "./fixtures/fixture-tls";
import { referencePoolDouble } from "./helpers/reference-pool-double";
import { createReferenceTools } from "../src/brain/reference-tools";
import { openSqliteWriter } from "../src/db/write-worker";
import { registerReferenceWrites } from "../src/brain/reference-writes";
import { createReferenceWorktrees } from "../src/brain/reference-worktrees";

const repository = "https://github.com/odysseus/ithaca", commit = "a".repeat(40), tree = "b".repeat(40), brain = "ithaca-brain";
let root: string, tls: ReturnType<typeof fixtureTls>;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "odysseus-managed-source-")); tls = fixtureTls(root, ["api.github.com"]); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function fixture(options: { private?: boolean; worker?: boolean } = {}) {
  const directory = mkdtempSync(join(root, "source-")), db = createUiDb(join(directory, "ui.db"));
  const owner = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const other = createPrincipal(db, { authMethod: "password", label: "Telemachus", ttlSeconds: 3600 });
  const writer = options.worker ? openSqliteWriter(db) : undefined;
  if (writer) registerReferenceWrites(db, writer);
  const credentials: Record<string, string | undefined> = { GITHUB_TOKEN: "odysseus-fixture-token" };
  const metadata: string[] = [], git: unknown[] = [];
  const state = { current: true, ownerId: 201, clock: Date.now(), fetches: 0, private: options.private ?? false, status: 200, invalidAt: 0, invalidJsonAt: 0, endOnPrivateMetadata: false };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    metadata.push(request.headers.get("authorization") ?? "anonymous");
    if (metadata.length === state.invalidJsonAt) return new Response("{", { headers: { "content-type": "application/json" } });
    if (metadata.length === state.invalidAt) return Response.json({ id: "invalid" });
    if (state.status !== 200) return new Response(null, { status: state.status });
    if (state.private && !request.headers.has("authorization")) return new Response(null, { status: 404 });
    if (state.endOnPrivateMetadata && request.headers.has("authorization")) state.current = false;
    return Response.json({ id: 101, owner: { id: state.ownerId, login: "Odysseus" }, name: "Ithaca", full_name: "Odysseus/Ithaca",
      clone_url: `${repository}.git`, url: "https://api.github.com/repos/odysseus/ithaca", private: state.private });
  } });
  const records: unknown[] = [];
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 4 * 1048576, observe(value) { records.push(value); } });
  const secondEgress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 4 * 1048576, observe() {} });
  const transport: ReferenceTransport = {
    async resolve(input) { git.push(input); return { ok: true, commit, ref: `refs/heads/${input.revision}` }; },
    async fetch(input) { git.push(input); state.fetches++; writeFileSync(join(input.root, "README.md"), "Odysseus charts Ithaca on 2026-07-12.\n"); return { commit }; },
    async checkout() {},
    async tree() { return tree; },
  };
  const pool = referencePoolDouble(join(directory, "pool"));
  const access = (database = db) => createGitHubReferenceAccess({ db: database, brain, credentials, transport,
    wireTransport: { ca: readFileSync(tls.ca, "utf8"), lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (() => connect({ host: "127.0.0.1", port: server.port! })) as typeof connect } });
  const github = access();
  const sourceOptions = { db, pool, transport, brain, credentials: { GITHUB_TOKEN: "odysseus-fixture-token" }, github, now: () => state.clock };
  const sources = createReferenceSources(sourceOptions);
  const grant = (repositoryPrefix = repository) => createReferenceGrant(db, { brain, principalId: owner.id, createdBy: owner.id, repositoryPrefix,
    credential: "GITHUB_TOKEN", metadataCredentialRecipient: "https://api.github.com", now: Date.now() });
  const request = (principalId = owner.id, turnId = "odysseus-turn", proxy = egress) => {
    const input = { repository, revision: "main", principalId, acquisition: { turnId, egress: proxy, current: () => state.current } };
    return sources.request(input);
  };
  return { sources, sourceOptions, request, db, pool, transport, github, credentials, owner, other, grant, state, egress, secondEgress, metadata, git, records,
    restart(database: ReturnType<typeof createUiDb>) { return createReferenceSources({ ...sourceOptions, db: database, github: access(database) }); },
    databasePath: join(directory, "ui.db"),
    async close() { await sources.close(); await writer?.close(); egress.stop(); secondEgress.stop(); server.stop(true); db.close(); } };
}

test("managed source publishes actual metadata, turn bytes and sealed root/tree facts in one catalog transaction", async () => {
  const f = await fixture();
  try {
    const lease = await f.request();
    try {
      expect(readFileSync(join(lease.viewPath, lease.name, "README.md"), "utf8")).toContain("Odysseus");
      const record = f.pool.records.get(lease.rootId)!;
      expect(f.db.query("SELECT * FROM reference_acquisitions WHERE root_id = ?").get(lease.rootId), "REFERENCE_MANAGED_ROOT_MAPPING").toMatchObject({
        brain, principal_id: f.owner.id, turn_id: "odysseus-turn", repository_id: "101", owner_id: "201", owner: "odysseus",
        repository_name: "ithaca", ref: "refs/heads/main", commit_id: commit, tree_id: tree,
        native_root_id: record.root!.rootId, native_uuid: record.root!.uuid, native_generation: record.root!.otransid, grant_id: null,
      });
      expect(f.egress.usedBytes(), "REFERENCE_SOURCE_CHARGES_ACTUAL_TURN").toBeGreaterThan(0);
      expect(f.metadata, "REFERENCE_SOURCE_FINAL_IDENTITY_REVALIDATED").toEqual(["anonymous", "anonymous"]);
      expect(f.git.every(input => (input as { wire?: unknown }).wire !== undefined), "REFERENCE_SOURCE_NEVER_BYPASSES_WIRE").toBe(true);
    } finally { lease.release(); }
  } finally { await f.close(); }
});

test("managed GitHub requests without an admitted turn budget refuse before any source transport", async () => {
  const f = await fixture();
  try {
    await expect(f.sources.request({ principalId: f.owner.id, repository, revision: "main" }), "REFERENCE_SOURCE_REQUIRES_REAL_TURN").rejects.toMatchObject({ code: "unavailable" });
    expect(f.git).toEqual([]); expect(f.metadata).toEqual([]);
  } finally { await f.close(); }
});

test("a cached shared root still uses the requesting principal and turn's own metadata budget", async () => {
  const f = await fixture();
  try {
    const first = await f.request();
    const second = await f.request(f.other.id, "telemachus-turn", f.secondEgress);
    try {
      expect(first.rootId).toBe(second.rootId);
      expect(f.state.fetches).toBe(1);
      expect(f.secondEgress.usedBytes(), "REFERENCE_SOURCE_CACHE_CANNOT_BORROW_TURN_BUDGET").toBeGreaterThan(0);
      expect(f.metadata).toHaveLength(4);
    } finally { first.release(); second.release(); }
  } finally { await f.close(); }
});

test("pre-proxy bind preparation with expired GitHub authority withholds source without network", async () => {
  const f = await fixture();
  try {
    const lease = await f.request(); lease.release();
    f.state.clock += 400_000;
    const count = f.git.length, metadata = f.metadata.length;
    await f.sources.bindable(f.owner.id);
    expect(f.git.length, "REFERENCE_BIND_NEVER_SPENDS_UNBOUND_NETWORK").toBe(count);
    expect(f.metadata.length).toBe(metadata);
    expect(f.pool.events.some(event => event.operation === "unpublish"), "REFERENCE_BIND_WITHHOLDS_EXPIRED_MANAGED_SOURCE").toBe(true);
  } finally { await f.close(); }
});

for (const change of ["turn", "grant", "owner", "root"] as const)
  test(`managed source refuses ${change} change while sealing before actual publication`, async () => {
    const f = await fixture({ private: change === "grant" }), grant = change === "grant" ? f.grant() : null;
    const seal = f.pool.poolSeal;
    f.pool.poolSeal = async (id, signal) => {
      const result = await seal(id, signal);
      if (change === "turn") f.state.current = false;
      if (change === "grant") revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: grant!.id, now: Date.now() });
      if (change === "owner") f.state.ownerId = 202;
      if (change === "root") result.root = null;
      return result;
    };
    try {
      await expect(f.request(), "REFERENCE_MANAGED_FINAL_PUBLICATION_FENCE").rejects.toThrow();
      expect(f.pool.events.filter(event => event.operation === "publish"), "REFERENCE_MANAGED_REFUSAL_HAS_NO_FILE_EFFECT").toEqual([]);
      expect(f.db.query("SELECT * FROM reference_acquisitions").all()).toEqual([]);
    } finally { await f.close(); }
  });

test("the host tool attaches only its admitted turn's budget and expires it at turn end", async () => {
  const f = await fixture(), tools = createReferenceTools({ sources: f.sources });
  try {
    await tools.begin("odysseus-tool-turn", { principalId: f.owner.id, posture: "interactive", generation: null });
    const call = { tool: "reference_source" as const, input: { repository, revision: "main" } };
    expect(await tools.call("odysseus-tool-turn", f.owner.id, call)).toMatchObject({ ok: false, code: "unavailable" });
    expect(() => tools.attachEgress("odysseus-tool-turn", f.other.id, { egress: f.egress, current: () => true })).toThrow();
    tools.attachEgress("odysseus-tool-turn", f.owner.id, { egress: f.egress, current: () => f.state.current });
    expect(() => tools.attachEgress("odysseus-tool-turn", f.owner.id, { egress: f.secondEgress, current: () => true })).toThrow();
    const result = await tools.call("odysseus-tool-turn", f.owner.id, call);
    expect(result, "REFERENCE_TOOL_USES_ACTUAL_HOST_TURN").toMatchObject({ ok: true, source: { domain: "public", commit } });
    expect(f.db.query("SELECT turn_id FROM reference_acquisitions").get()).toEqual({ turn_id: "odysseus-tool-turn" });
    tools.end("odysseus-tool-turn");
    expect(await tools.call("odysseus-tool-turn", f.owner.id, call)).toMatchObject({ ok: false, code: "unavailable" });
  } finally { tools.end("odysseus-tool-turn"); await f.close(); }
});

test("worker-owned publication persists acquisition facts across a fresh database connection and service restart", async () => {
  const f = await fixture({ worker: true });
  try {
    const lease = await f.request(), id = lease.rootId; lease.release();
    const original = f.db.query("SELECT * FROM reference_acquisitions").get();
    await f.sources.close();
    const db = createUiDb(f.databasePath), restarted = f.restart(db);
    try {
      const metadata = f.metadata.length;
      await restarted.recover();
      expect(f.metadata.length, "REFERENCE_RESTART_NEVER_SPENDS_UNBOUND_NETWORK").toBe(metadata);
      expect(db.query("SELECT * FROM reference_acquisitions WHERE root_id = ?").get(id), "REFERENCE_ACQUISITION_SURVIVES_RESTART").toEqual(original);
      expect(db.query("SELECT root_id FROM reference_sources").get()).toEqual({ root_id: id });
    } finally { await restarted.close(); db.close(); }
  } finally { await f.close(); }
});

for (const changed of ["uuid", "generation", "commit", "brain"] as const)
  test(`restart refuses a retained managed root with a contradictory ${changed}`, async () => {
    const f = await fixture();
    try {
      const lease = await f.request(), id = lease.rootId; lease.release();
      await f.sources.close();
      const record = f.pool.records.get(id)!;
      if (changed === "uuid") record.root = { ...record.root!, uuid: "another-root" };
      if (changed === "generation") record.root = { ...record.root!, otransid: "2" };
      if (changed === "commit") f.db.query("UPDATE reference_sources SET commit_id = ?").run("c".repeat(40));
      if (changed === "brain") f.db.query("UPDATE reference_acquisitions SET brain = 'troy-brain'").run();
      const restarted = f.restart(f.db);
      try {
        await restarted.recover();
        expect(f.db.query("SELECT * FROM reference_sources").all(), "REFERENCE_RESTART_REFUSES_CONTRADICTORY_ROOT").toEqual([]);
        expect(record.state).toBe("reclaimed");
      } finally { await restarted.close(); }
    } finally { await f.close(); }
  });

test("two concurrent public requesters cannot join the first turn's in-flight acquisition", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.transport.fetch; let calls = 0;
  f.transport.fetch = async input => { if (++calls === 1) { entered(); await held; } return fetch(input); };
  const first = f.request();
  try {
    await reached;
    const second = await f.request(f.other.id, "telemachus-turn", f.secondEgress);
    try {
      expect(f.secondEgress.usedBytes(), "REFERENCE_CONCURRENT_REQUEST_PAYS_OWN_BUDGET").toBeGreaterThan(0);
      expect(calls, "REFERENCE_CONCURRENT_REQUEST_NEVER_JOINS_FOREIGN_TURN").toBe(2);
    } finally { second.release(); }
    release(); (await first).release();
  } finally { release(); await first.then(lease => lease.release(), () => {}); await f.close(); }
});

test("authority lost after native publication removes the name and acquisition rather than returning bytes", async () => {
  const f = await fixture(), publish = f.pool.poolPublish;
  let path = "";
  f.pool.poolPublish = async (...args) => {
    const result = await publish(...args); path = result.path!; f.state.current = false; return result;
  };
  try {
    await expect(f.request(), "REFERENCE_POST_MANAGER_AUTHORITY_FENCE").rejects.toThrow();
    expect(existsSync(path), "REFERENCE_POST_MANAGER_FAILURE_REMOVES_ROOT").toBe(false);
    expect(f.db.query("SELECT * FROM reference_acquisitions").all()).toEqual([]);
  } finally { await f.close(); }
});

test("a changed native root reply cannot be recorded as the root sealed before the publication wait", async () => {
  const f = await fixture(), publish = f.pool.poolPublish;
  let path = "";
  f.pool.poolPublish = async (...args) => {
    const result = await publish(...args); path = result.path!; result.root = { ...result.root!, uuid: "a-different-native-root" }; return result;
  };
  try {
    await expect(f.request(), "REFERENCE_NATIVE_PUBLICATION_ROOT_MUST_MATCH_SEAL").rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(f.db.query("SELECT * FROM reference_acquisitions").all()).toEqual([]);
  } finally { await f.close(); }
});

test("principal revocation committed with the async publication receipt withdraws the just-published root", async () => {
  const f = await fixture({ worker: true }), publish = f.pool.poolPublish;
  let path = "";
  f.pool.poolPublish = async (...args) => { const result = await publish(...args); path = result.path!; return result; };
  f.db.exec(`CREATE TRIGGER odysseus_revoke_at_publication AFTER INSERT ON reference_acquisitions
    BEGIN UPDATE principals SET revoked_at = 1 WHERE id = NEW.principal_id; END`);
  try {
    await expect(f.request(), "REFERENCE_POST_DATABASE_AUTHORITY_FENCE").rejects.toThrow();
    expect(existsSync(path), "REFERENCE_POST_DATABASE_FAILURE_REMOVES_ROOT").toBe(false);
    expect(f.db.query("SELECT * FROM reference_acquisitions").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM reference_sources WHERE root_id IS NOT NULL").all()).toEqual([]);
  } finally { await f.close(); }
});

for (const wait of ["coverage", "native-grant"] as const)
  test(`managed worktree access fences acquiring-turn loss after its own ${wait} wait`, async () => {
    const f = await fixture();
    const context = { turnId: "odysseus-worktree-turn", egress: f.egress, current: () => f.state.current };
    const worktrees = createReferenceWorktrees({ db: f.db, pool: f.pool, sources: f.sources,
      coverage: async () => { if (wait === "coverage") f.state.current = false; } });
    let generation: Awaited<ReturnType<typeof worktrees.openGeneration>> | undefined;
    try {
      const item = await worktrees.allocate({ principalId: f.owner.id, repository, revision: "main", acquisition: context });
      generation = await worktrees.openGeneration({ principalId: f.owner.id, turnId: context.turnId, profile: "governed" });
      const access = f.pool.poolAccess;
      f.pool.poolAccess = async (...args) => { const result = await access(...args); if (wait === "native-grant") f.state.current = false; return result; };
      await expect(worktrees.access({ worktreeId: item.id, principalId: f.owner.id, generation: generation.id, acquisition: context }),
        "REFERENCE_WORKTREE_FINAL_TURN_FENCE").rejects.toThrow();
      expect(f.pool.records.get(item.id)!.access, "REFERENCE_WORKTREE_STALE_GRANT_PARKED").toBeNull();
    } finally { if (generation) await worktrees.closeGeneration(generation.id); await worktrees.close(); await f.close(); }
  });
describe("live managed authority", () => {
  test("anonymous public refusal is fenced before a private retry ends its turn", async () => {
    const f = await fixture(); let held: Awaited<ReturnType<typeof f.request>> | undefined;
    try {
      held = await f.request(); expect(readFileSync(join(held.viewPath, held.name, "README.md"), "utf8")).toContain("Odysseus");
      f.state.private = true; f.grant(); f.state.endOnPrivateMetadata = true;
      await expect(f.request()).rejects.toThrow();
      const views = await f.sources.bindable(f.other.id);
      expect(existsSync(join(views.public, held.name, "README.md")), "PRIVATE_RETRY_TURN_END_CANNOT_UNDO_ANONYMOUS_REFUSAL").toBe(false);
      expect(existsSync(join(views.public, held.rootId, "README.md")), "ANONYMOUS_REFUSAL_REMOVES_PUBLIC_ROOT_IDENTITY").toBe(false);
    } finally { held?.release(); await f.close(); }
  });

  for (const malformed of ["schema", "json"] as const)
    test(`initial ${malformed} metadata failure survives a turn ending during access shutdown`, async () => {
      const f = await fixture(); let held: Awaited<ReturnType<typeof f.request>> | undefined;
      try {
        held = await f.request();
        expect(readFileSync(join(held.viewPath, held.name, "README.md"), "utf8")).toContain("Odysseus");
        if (malformed === "schema") f.state.invalidAt = f.metadata.length + 1;
        else f.state.invalidJsonAt = f.metadata.length + 1;
        const open = f.github.open;
        f.github.open = async input => { try { return await open(input); } finally { f.state.current = false; } };
        await expect(f.request()).rejects.toThrow();
        const views = await f.sources.bindable(f.other.id);
        expect(existsSync(join(views.public, held.name, "README.md")), "INITIAL_METADATA_FAILURE_SURVIVES_ACCESS_SHUTDOWN").toBe(false);
        expect(existsSync(join(views.public, held.rootId, "README.md")), "INITIAL_METADATA_FAILURE_HIDES_ROOT_IDENTITY").toBe(false);
      } finally { held?.release(); await f.close(); }
    });

  test("older failed publication cleanup cannot unpublish a newly validated source", async () => {
    const f = await fixture(), releaseStarted = Promise.withResolvers<void>(), resumeRelease = Promise.withResolvers<void>();
    let held: Awaited<ReturnType<typeof f.request>> | undefined, current: typeof held, failedId = "", failed = false, pending: Promise<unknown> | undefined;
    const publish = f.pool.poolPublish, release = f.pool.poolRelease;
    try {
      held = await f.request();
      const nextCommit = "c".repeat(40), fetch = f.transport.fetch;
      f.transport.resolve = async () => ({ ok: true, commit: nextCommit, ref: "refs/heads/main" });
      f.transport.fetch = async input => { await fetch(input); return { commit: nextCommit }; };
      f.pool.poolPublish = async (...args) => { const result = await publish(...args); if (!failed) { failed = true; failedId = args[0]; f.state.current = false; } return result; };
      f.pool.poolRelease = async (...args) => { if (args[0] === failedId) { releaseStarted.resolve(); await resumeRelease.promise; } return release(...args); };
      pending = f.request().then(lease => { lease.release(); return null; }, error => error);
      await releaseStarted.promise;
      current = await f.sources.request({ principalId: f.owner.id, repository, revision: "main", acquisition: { turnId: "odysseus-new-valid-source", egress: f.secondEgress, current: () => true } });
      expect(readFileSync(join(current.viewPath, current.name, "README.md"), "utf8")).toContain("Odysseus");
      resumeRelease.resolve(); expect(await pending).toBeInstanceOf(Error);
      expect(existsSync(join(current.viewPath, current.name, "README.md")), "OLDER_FAILED_PUBLICATION_CANNOT_UNPUBLISH_NEW_VALID_SOURCE").toBe(true);
    } finally { resumeRelease.resolve(); await pending; current?.release(); held?.release(); await f.close(); }
  });

  for (const prefix of ["https://github.com/Odysseus", "https://github.com/Odysseus/Ithaca.GIT"])
  for (const retained of [false, true])
    test(`a ${retained ? "retained" : "new"} mixed-case GitHub grant covers ${prefix}`, async () => {
      const f = await fixture({ private: true }), issued = f.grant(prefix);
      try {
        if (retained) f.db.query("UPDATE reference_grants SET repository_prefix = ? WHERE id = ?").run(prefix, issued.id);
        expect(f.sources.covers({ principalId: f.owner.id, repository }), "MIXED_CASE_GITHUB_GRANT_COVERS_TRANSPORT_IDENTITY").toBe(true);
        const lease = await f.request();
        try { expect(lease.domain).toBe("private"); expect(readFileSync(join(lease.viewPath, lease.name, "README.md"), "utf8")).toContain("Odysseus"); }
        finally { lease.release(); }
        expect(f.sources.covers({ principalId: f.owner.id, repository: "https://github.com/odysseus-crew/ithaca" })).toBe(false);
      } finally { await f.close(); }
    });

  for (const managed of [true, false])
    test(`${managed ? "managed" : "legacy"} publication authority loss hides files before staging release`, async () => {
      const f = await fixture({ private: true }), issued = f.grant(), releaseStarted = Promise.withResolvers<void>(), resumeRelease = Promise.withResolvers<void>();
      if (!managed) f.transport.resolve = async input => input.token ? { ok: true, commit, ref: "refs/heads/main" } : { ok: false, reason: "denied", detail: "A live private grant is required." };
      const sources = managed ? f.sources : createReferenceSources({ ...f.sourceOptions, github: undefined });
      const publish = f.pool.poolPublish, release = f.pool.poolRelease;
      let path = "";
      f.pool.poolPublish = async (...args) => { const result = await publish(...args); path = join(result.path!, "README.md"); revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: issued.id, now: Date.now() }); return result; };
      f.pool.poolRelease = async (...args) => { releaseStarted.resolve(); await resumeRelease.promise; return release(...args); };
      const pending = sources.request({ principalId: f.owner.id, repository, revision: "main", acquisition: { turnId: "odysseus-post-publication-denial", egress: f.egress, current: () => f.state.current } }).then(lease => { lease.release(); return null; }, error => error);
      try {
        await releaseStarted.promise;
        expect(existsSync(path), "PUBLICATION_DENIAL_HIDES_ROOT_BEFORE_STORAGE_CLEANUP").toBe(false);
        resumeRelease.resolve(); expect(await pending).toMatchObject({ code: "unauthorized" });
      } finally { resumeRelease.resolve(); await pending; if (!managed) await sources.close(); await f.close(); }
    });

  for (const final of [false, true])
    test(`suspension from ${final ? "final" : "initial"} incomplete metadata survives restart`, async () => {
      const f = await fixture({ worker: final }); let held: Awaited<ReturnType<typeof f.request>> | undefined, restarted: typeof f.sources | undefined;
      try {
        held = await f.request(); held.release();
        f.state.invalidAt = f.metadata.length + (final ? 2 : 1);
        await expect(f.request()).rejects.toThrow();
        expect(existsSync(join(held.viewPath, held.name, "README.md"))).toBe(false);
        await f.sources.close(); restarted = f.restart(f.db); await restarted.recover();
        const count = f.metadata.length, views = await restarted.bindable(f.other.id);
        expect(existsSync(join(views.public, held.name, "README.md")), "RESTART_CANNOT_REEXPOSE_UNCERTAIN_SOURCE_AUTHORITY").toBe(false);
        expect(f.metadata.length, "RESTART_BIND_DOES_NOT_BORROW_NETWORK_BUDGET").toBe(count);
        f.state.invalidAt = 0;
        const restored = await restarted.request({ principalId: f.owner.id, repository, revision: "main", acquisition: { turnId: "odysseus-restarted-validation", egress: f.egress, current: () => f.state.current } });
        try { expect(readFileSync(join(restored.viewPath, restored.name, "README.md"), "utf8")).toContain("Odysseus"); } finally { restored.release(); }
      } finally { held?.release(); await restarted?.close(); await f.close(); }
    });

  test("a request without network allowance cannot invalidate another turn's cached authority", async () => {
    const f = await fixture(), remaining = f.secondEgress.remainingBytes; let held: Awaited<ReturnType<typeof f.request>> | undefined;
    try {
      held = await f.request(); const observations = f.metadata.length;
      f.secondEgress.remainingBytes = () => 0;
      await expect(f.request(f.other.id, "odysseus-budget-refusal", f.secondEgress)).rejects.toMatchObject({ code: "capacity" });
      expect(f.metadata.length).toBe(observations);
      expect(existsSync(join(held.viewPath, held.name, "README.md")), "BUDGET_REFUSAL_IS_NOT_A_REPOSITORY_AUTHORITY_OBSERVATION").toBe(true);
    } finally { f.secondEgress.remainingBytes = remaining; held?.release(); await f.close(); }
  });

  test("a malformed refresh hides the previous source before staging cleanup or turn cancellation", async () => {
    const f = await fixture(), releaseStarted = Promise.withResolvers<void>(), resumeRelease = Promise.withResolvers<void>(), release = f.pool.poolRelease;
    let held: Awaited<ReturnType<typeof f.request>> | undefined, request: Promise<unknown> | undefined;
    const controller = new AbortController();
    try {
      held = await f.request();
      const nextCommit = "c".repeat(40), fetch = f.transport.fetch;
      f.transport.resolve = async () => ({ ok: true, commit: nextCommit, ref: "refs/heads/main" });
      f.transport.fetch = async input => { await fetch(input); return { commit: nextCommit }; };
      f.state.invalidAt = f.metadata.length + 2;
      f.pool.poolRelease = async (...args) => { releaseStarted.resolve(); await resumeRelease.promise; return release(...args); };
      request = f.sources.request({ principalId: f.owner.id, repository, revision: "main", signal: controller.signal,
        acquisition: { turnId: "odysseus-malformed-refresh", egress: f.egress, current: () => f.state.current } }).then(lease => { lease.release(); return null; }, error => error);
      await releaseStarted.promise;
      expect(existsSync(join(held.viewPath, held.name, "README.md")), "MALFORMED_REFRESH_HIDES_CACHE_BEFORE_STAGING_CLEANUP").toBe(false);
      f.state.current = false; controller.abort(); resumeRelease.resolve();
      expect(await request).toBeInstanceOf(Error);
      expect(existsSync(join(held.viewPath, held.rootId, "README.md")), "TURN_END_CANNOT_RESTORE_KNOWN_INVALID_METADATA").toBe(false);
    } finally { resumeRelease.resolve(); await request; held?.release(); await f.close(); }
  });

  for (const malformed of ["schema", "json"] as const)
    test(`malformed final ${malformed} metadata withholds a cached public source`, async () => {
      const f = await fixture(); let held: Awaited<ReturnType<typeof f.request>> | undefined;
      try {
        held = await f.request();
        expect(readFileSync(join(held.viewPath, held.name, "README.md"), "utf8")).toContain("Odysseus");
        if (malformed === "schema") f.state.invalidAt = f.metadata.length + 2;
        else f.state.invalidJsonAt = f.metadata.length + 2;
        await expect(f.request(), "FINAL_METADATA_REFUSES_THE_REVALIDATION").rejects.toThrow();
        const views = await f.sources.bindable(f.other.id);
        expect(existsSync(join(views.public, held.name, "README.md")), "MALFORMED_FINAL_METADATA_WITHHOLDS_CACHED_NAME").toBe(false);
        expect(existsSync(join(views.public, held.rootId, "README.md")), "MALFORMED_FINAL_METADATA_WITHHOLDS_CACHED_ROOT").toBe(false);
        f.state.invalidAt = 0; f.state.invalidJsonAt = 0;
        const recovered = await f.request();
        try {
          expect(recovered.rootId, "VALID_METADATA_RESTORES_THE_WITHHELD_CACHE").toBe(held.rootId);
          expect(readFileSync(join(recovered.viewPath, recovered.name, "README.md"), "utf8")).toContain("Odysseus");
        } finally { recovered.release(); }
      } finally { held?.release(); await f.close(); }
    });

  for (const alias of ["https://github.com/Odysseus/Ithaca", "https://GITHUB.COM/Odysseus/Ithaca.git"])
    test(`GitHub authority withdrawal covers the URL alias ${alias}`, async () => {
      const f = await fixture(); let held: Awaited<ReturnType<typeof f.request>> | undefined;
      try {
        held = await f.sources.request({ principalId: f.owner.id, repository: alias, revision: "main", acquisition: { turnId: "odysseus-alias-turn", egress: f.egress, current: () => f.state.current } });
        expect(readFileSync(join(held.viewPath, held.name, "README.md"), "utf8")).toContain("Odysseus");
        f.state.private = true;
        await expect(f.request()).rejects.toMatchObject({ code: "unauthorized" });
        const views = await f.sources.bindable(f.other.id);
        expect(existsSync(join(views.public, held.name, "README.md")), "GITHUB_ALIAS_CANNOT_BYPASS_PUBLIC_WITHDRAWAL").toBe(false);
        expect(existsSync(join(views.public, held.rootId, "README.md")), "GITHUB_ALIAS_ROOT_CANNOT_BYPASS_WITHDRAWAL").toBe(false);
      } finally { held?.release(); await f.close(); }
    });

  test("GitHub URL aliases share the transport's canonical cache identity", async () => {
    const f = await fixture(); let first: Awaited<ReturnType<typeof f.request>> | undefined, second: typeof first;
    try {
      first = await f.sources.request({ principalId: f.owner.id, repository: "https://github.com/Odysseus/Ithaca.git", revision: "main", acquisition: { turnId: "odysseus-canonical-alias", egress: f.egress, current: () => f.state.current } });
      second = await f.request(f.other.id, "odysseus-canonical-second", f.secondEgress);
      expect(first.repository, "GITHUB_CACHE_USES_TRANSPORT_CANONICAL_IDENTITY").toBe(repository);
      expect(second.rootId, "GITHUB_ALIASES_REUSE_THE_SAME_SEALED_ROOT").toBe(first.rootId);
      expect(f.state.fetches, "GITHUB_ALIASES_DO_NOT_FETCH_DUPLICATE_ROOTS").toBe(1);
      expect(readFileSync(join(second.viewPath, second.name, "README.md"), "utf8")).toContain("Odysseus");
    } finally { second?.release(); first?.release(); await f.close(); }
  });

  test("authority withdrawal also fences an already stored noncanonical GitHub catalog key", async () => {
    const f = await fixture(); let held: Awaited<ReturnType<typeof f.request>> | undefined;
    try {
      held = await f.request();
      // Simulate disposable catalog state retained from an earlier service.
      f.db.transaction(() => {
        f.db.query("UPDATE reference_sources SET repository = ? WHERE repository = ?").run("https://github.com/Odysseus/Ithaca", repository);
        f.db.query("UPDATE reference_roots SET repository = ? WHERE repository = ?").run("https://github.com/Odysseus/Ithaca", repository);
      })();
      expect(readFileSync(join(held.viewPath, held.name, "README.md"), "utf8")).toContain("Odysseus");
      f.state.private = true;
      await expect(f.request()).rejects.toMatchObject({ code: "unauthorized" });
      const views = await f.sources.bindable(f.other.id);
      expect(existsSync(join(views.public, held.name, "README.md")), "STORED_GITHUB_ALIAS_IS_FENCED").toBe(false);
    } finally { held?.release(); await f.close(); }
  });

  for (const initialPrivate of [false, true])
    test(`a retained ${initialPrivate ? "private" : "public"} worktree alias uses the actual transport's grant scope`, async () => {
      const f = await fixture({ private: initialPrivate }); f.grant();
      const context = { turnId: "odysseus-retained-alias-turn", egress: f.egress, current: () => f.state.current };
      const worktrees = createReferenceWorktrees({ db: f.db, pool: f.pool, sources: f.sources, coverage: async () => {} });
      let generation: Awaited<ReturnType<typeof worktrees.openGeneration>> | undefined;
      try {
        const item = await worktrees.allocate({ principalId: f.owner.id, repository, revision: "main", acquisition: context });
        f.db.query("UPDATE reference_worktrees SET repository = ? WHERE id = ?").run("https://github.com/Odysseus/Ithaca", item.id);
        f.state.private = true;
        generation = await worktrees.openGeneration({ principalId: f.owner.id, turnId: context.turnId, profile: "governed" });
        await expect(worktrees.access({ worktreeId: item.id, principalId: f.owner.id, generation: generation.id, acquisition: context }),
          "RETAINED_ALIAS_USES_LIVE_CANONICAL_GRANT").resolves.toMatchObject({ generation: generation.id });
        expect(readFileSync(join(generation.path, item.id, "README.md"), "utf8")).toContain("Odysseus");
      } finally { if (generation) await worktrees.closeGeneration(generation.id); await worktrees.close(); await f.close(); }
    });

  test("incomplete metadata hides a first native publication before delayed storage release", async () => {
    const f = await fixture(), arrived = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), observed = Promise.withResolvers<void>();
    const releaseStarted = Promise.withResolvers<void>(), resumeRelease = Promise.withResolvers<void>(), publish = f.pool.poolPublish, release = f.pool.poolRelease, open = f.github.open;
    let path = "", id = "", released = false;
    f.pool.poolPublish = async (...args) => { const result = await publish(...args); path = join(result.path!, "README.md"); id = args[0]; arrived.resolve(); await resume.promise; return result; };
    f.pool.poolRelease = async (...args) => { if (args[0] === id && !released) { released = true; releaseStarted.resolve(); await resumeRelease.promise; } return release(...args); };
    const earlier = f.request().then(lease => ({ lease, error: undefined }), error => ({ lease: undefined, error }));
    let later: Promise<{ lease: Awaited<ReturnType<typeof f.request>> | undefined; error: unknown }> | undefined;
    try {
      await arrived.promise; expect(readFileSync(path, "utf8")).toContain("Odysseus");
      f.state.invalidAt = f.metadata.length + 1;
      f.github.open = async input => { try { return await open(input); } finally { observed.resolve(); } };
      later = f.request().then(lease => ({ lease, error: undefined }), error => ({ lease: undefined, error }));
      await observed.promise; await new Promise<void>(resolve => setImmediate(resolve));
      resume.resolve(); await releaseStarted.promise;
      const current = await later; current.lease?.release();
      expect(current.error).toMatchObject({ code: "unavailable" });
      expect(existsSync(path), "INCOMPLETE_METADATA_HIDES_NATIVE_EXPOSURE_WITHOUT_CATALOG").toBe(false);
      resumeRelease.resolve(); expect((await earlier).error).toMatchObject({ code: "unauthorized" });
    } finally { resume.resolve(); resumeRelease.resolve(); (await earlier).lease?.release(); (await later)?.lease?.release(); await f.close(); }
  });

  test("private revocation waits for an in-flight first publication with no catalog row", async () => {
    const f = await fixture({ private: true }), issued = f.grant(), arrived = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const publish = f.pool.poolPublish, release = f.pool.poolRelease, releaseStarted = Promise.withResolvers<void>(), resumeRelease = Promise.withResolvers<void>();
    let publishedPath = "", publishedId = "", releasePaused = false, revocation: Promise<void> | undefined;
    f.pool.poolPublish = async (...args) => {
      const result = await publish(...args); publishedPath = join(result.path!, "README.md"); publishedId = args[0];
      arrived.resolve(); await resume.promise; return result;
    };
    f.pool.poolRelease = async (...args) => {
      if (args[0] === publishedId && !releasePaused) { releasePaused = true; releaseStarted.resolve(); await resumeRelease.promise; }
      return release(...args);
    };
    const request = f.request().then(lease => ({ lease, error: undefined }), error => ({ lease: undefined, error }));
    try {
      await arrived.promise;
      expect(readFileSync(publishedPath, "utf8")).toContain("Odysseus");
      expect(f.db.query("SELECT 1 FROM reference_sources").get()).toBeNull();
      revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: issued.id, now: Date.now() });
      let finished = false;
      revocation = f.sources.revoke({ grantIds: [issued.id], principalIds: [] }).then(() => { finished = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(finished, "PRIVATE_REVOCATION_WAITS_FOR_DISPATCHED_PUBLICATION").toBe(false);
      resume.resolve(); await releaseStarted.promise; await revocation;
      expect(existsSync(publishedPath), "PRIVATE_REVOCATION_HIDES_FIRST_PUBLICATION_BEFORE_RETURNING").toBe(false);
      resumeRelease.resolve();
      const result = await request;
      expect(result.error).toMatchObject({ code: "unauthorized" }); result.lease?.release();
    } finally { resume.resolve(); resumeRelease.resolve(); await revocation; (await request).lease?.release(); await f.close(); }
  });

  test("concurrent private requests do not inherit another request's public fence", async () => {
    const f = await fixture({ private: true }); f.grant();
    const secondOpened = Promise.withResolvers<void>(), resumeSecond = Promise.withResolvers<void>(), open = f.github.open;
    let openings = 0, first: Awaited<ReturnType<typeof f.request>> | undefined, second: typeof first;
    f.github.open = async input => {
      const index = ++openings, access = await open(input);
      if (index === 2) { secondOpened.resolve(); await resumeSecond.promise; }
      return access;
    };
    const earlier = f.request(), later = f.request(f.owner.id, "odysseus-second-private-turn", f.secondEgress);
    void later.catch(() => {});
    try {
      await secondOpened.promise;
      first = await earlier;
      resumeSecond.resolve(); second = await later;
      expect(first.domain).toBe("private"); expect(second.domain).toBe("private");
      expect(f.egress.usedBytes()).toBeGreaterThan(0); expect(f.secondEgress.usedBytes()).toBeGreaterThan(0);
    } finally {
      resumeSecond.resolve();
      first ??= await earlier.catch(() => undefined); second ??= await later.catch(() => undefined);
      second?.release(); first?.release(); await f.close();
    }
  });

  for (const olderRevision of ["main", "return-home"])
  for (const outcome of ["private", "denied", "unavailable"] as const)
    test(`an older first public publication of ${olderRevision} cannot survive newer ${outcome} metadata authority`, async () => {
      const f = await fixture(), arrived = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), observed = Promise.withResolvers<void>();
      const publish = f.pool.poolPublish, open = f.github.open;
      let paused = false, publicName = "", publicRootId = "", first: Awaited<ReturnType<typeof f.request>> | undefined, second: Awaited<ReturnType<typeof f.request>> | undefined;
      f.pool.poolPublish = async (...args) => {
        const result = await publish(...args);
        if (!paused) {
          paused = true; publicName = args[2]; publicRootId = args[0];
          expect(readFileSync(join(result.path!, "README.md"), "utf8"), "OLDER_PUBLIC_NATIVE_PUBLICATION_HAS_READABLE_FILES").toContain("Odysseus");
          arrived.resolve(); await resume.promise;
        }
        return result;
      };
      let earlier: Promise<{ lease?: Awaited<ReturnType<typeof f.request>>; error?: unknown }> | undefined;
      try {
        earlier = f.sources.request({ principalId: f.owner.id, repository, revision: olderRevision,
          acquisition: { turnId: "odysseus-earlier-public-turn", egress: f.egress, current: () => f.state.current } })
          .then(lease => ({ lease }), error => ({ error }));
        await arrived.promise;
        expect(f.db.query("SELECT 1 FROM reference_sources").get(), "FIRST_PUBLIC_PUBLICATION_HAS_NO_CATALOG_ROW_YET").toBeNull();
        f.state.private = true;
        if (outcome !== "denied") f.grant();
        if (outcome === "unavailable") f.credentials.GITHUB_TOKEN = undefined;
        f.github.open = async input => {
          try { return await open({ ...input, withdrawPublic: async () => { observed.resolve(); await input.withdrawPublic?.(); } }); }
          finally { observed.resolve(); }
        };
        const later = f.request().then(lease => ({ lease, error: undefined }), error => ({ lease: undefined, error }));
        await observed.promise;
        // The public withdrawal has started before the older native reply
        // arrives; no wall-clock race or external I/O.
        await new Promise<void>(resolve => setImmediate(resolve));
        resume.resolve();
        const old = await earlier, current = await later;
        first = old.lease; second = current.lease;
        if (outcome === "private") expect(second?.domain).toBe("private");
        else expect(current.error).toMatchObject({ code: outcome === "denied" ? "unauthorized" : "unavailable" });
        const views = await f.sources.bindable(f.other.id);
        expect(existsSync(join(views.public, publicName, "README.md")), "LATE_PUBLIC_PUBLICATION_CANNOT_REEXPOSE_SOURCE").toBe(false);
        expect(existsSync(join(views.public, publicRootId, "README.md")), "LATE_PUBLIC_PUBLICATION_CANNOT_EXPOSE_ROOT_IDENTITY").toBe(false);
        expect(f.db.query("SELECT 1 FROM reference_sources WHERE domain = 'public' AND root_id IS NOT NULL").get(), "LATE_PUBLIC_PUBLICATION_CANNOT_RECREATE_PUBLIC_CATALOG").toBeNull();
        expect(old.error, "OLDER_PUBLIC_PUBLICATION_IS_FENCED_BY_NEWER_AUTHORITY").toMatchObject({ code: "unauthorized" });
      } finally {
        resume.resolve();
        first ??= (await earlier)?.lease;
        second?.release(); first?.release(); await f.close();
      }
    });

  test("a private metadata observation withdraws every cached public revision of that repository", async () => {
    const f = await fixture();
    let first: Awaited<ReturnType<typeof f.request>> | undefined, other: typeof first, current: typeof first;
    try {
      first = await f.request();
      other = await f.sources.request({ principalId: f.owner.id, repository, revision: "return-home", acquisition: { turnId: "odysseus-other-revision", egress: f.egress, current: () => f.state.current } });
      expect(readFileSync(join(other.viewPath, other.name, "README.md"), "utf8")).toContain("Odysseus");
      f.state.private = true; f.grant(); current = await f.request();
      const views = await f.sources.bindable(f.other.id);
      expect(existsSync(join(views.public, first.name, "README.md")), "PRIVATE_METADATA_FENCES_REQUESTED_PUBLIC_REVISION").toBe(false);
      expect(existsSync(join(views.public, other.name, "README.md")), "PRIVATE_METADATA_FENCES_OTHER_PUBLIC_REVISIONS").toBe(false);
    } finally { current?.release(); other?.release(); first?.release(); await f.close(); }
  });

  for (const refusal of ["metadata", "git-denial", "missing-ref"] as const)
    test(`a known public source is hidden from another principal after ${refusal} refuses it`, async () => {
      const f = await fixture();
      let held: Awaited<ReturnType<typeof f.request>> | undefined;
      try {
        held = await f.request();
        const path = join(held.viewPath, held.name, "README.md");
        expect(readFileSync(path, "utf8"), "PUBLIC_SOURCE_WAS_PUBLISHED_BEFORE_REFUSAL").toContain("Odysseus");
        if (refusal === "metadata") f.state.private = true;
        else f.transport.resolve = async () => ({ ok: false, reason: refusal === "git-denial" ? "denied" : "missing", detail: "The published source is no longer available anonymously." });
        await expect(f.request(), "MANAGED_PUBLIC_AUTHORITY_REFUSAL_IS_REPORTED").rejects.toMatchObject({ code: refusal === "missing-ref" ? "missing" : "unauthorized" });
        const views = await f.sources.bindable(f.other.id);
        expect(existsSync(join(views.public, held.name, "README.md")), "MANAGED_PUBLIC_REFUSAL_FENCES_OTHER_PRINCIPALS").toBe(false);
        expect(existsSync(path), "MANAGED_PUBLIC_REFUSAL_WITHDRAWS_NAME_WITH_A_HELD_LEASE").toBe(false);
      } finally { held?.release(); await f.close(); }
    });

  for (const status of [401, 403, 404])
    test(`a private cached source is hidden after metadata returns ${status}`, async () => {
      const f = await fixture({ private: true }); f.grant();
      let held: Awaited<ReturnType<typeof f.request>> | undefined;
      try {
        held = await f.request();
        expect(readFileSync(join(held.viewPath, held.name, "README.md"), "utf8")).toContain("Odysseus");
        f.state.status = status;
        await expect(f.request(), "MANAGED_PRIVATE_METADATA_REFUSAL_IS_AUTHORITY_LOSS").rejects.toMatchObject({ code: "unauthorized" });
        const views = await f.sources.bindable(f.owner.id);
        expect(existsSync(join(views.private, held.name, "README.md")), "MANAGED_PRIVATE_METADATA_REFUSAL_WITHDRAWS_COPY").toBe(false);
      } finally { held?.release(); await f.close(); }
    });

  test("a revoked private grant during wire shutdown refuses and hides the cached source", async () => {
    const f = await fixture({ private: true }), issued = f.grant();
    let held: Awaited<ReturnType<typeof f.request>> | undefined;
    try {
      held = await f.request();
      const open = f.github.open;
      f.github.open = async input => {
        const access = await open(input);
        return Object.freeze({ ...access, async close() {
          await access.close();
          revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: issued.id, now: Date.now() });
        } });
      };
      await expect(f.request(), "MANAGED_PRIVATE_SHUTDOWN_RECHECKS_AUTHORITY").rejects.toMatchObject({ code: "unauthorized" });
      expect(existsSync(join(held.viewPath, held.name, "README.md")), "MANAGED_PRIVATE_SHUTDOWN_WITHDRAWS_COPY").toBe(false);
    } finally { held?.release(); await f.close(); }
  });

  test("a newly private acquisition removes the prior public copy before returning private access", async () => {
    const f = await fixture();
    let old: Awaited<ReturnType<typeof f.request>> | undefined, current: Awaited<ReturnType<typeof f.request>> | undefined;
    try {
      old = await f.request();
      expect(existsSync(join(old.viewPath, old.name, "README.md"))).toBe(true);
      f.state.private = true; f.grant();
      current = await f.request();
      expect(current.domain, "PRIVATE_TRANSITION_USES_ITS_OWN_GRANTED_DOMAIN").toBe("private");
      expect(readFileSync(join(current.viewPath, current.name, "README.md"), "utf8")).toContain("Odysseus");
      const views = await f.sources.bindable(f.other.id);
      expect(existsSync(join(views.public, old.name, "README.md")), "MANAGED_PRIVATE_TRANSITION_WITHDRAWS_PUBLIC_COPY").toBe(false);
    } finally { current?.release(); old?.release(); await f.close(); }
  });

  for (const initialPrivate of [true, false])
  for (const wait of ["coverage", "native-grant", "grant-write", "held-refresh", "held-write"] as const)
    test(`a ${initialPrivate ? "private" : "public-to-private"} worktree loses mounted access when its grant is revoked during ${wait}`, async () => {
      const f = await fixture({ private: initialPrivate }), issued = f.grant();
      const revoke = () => { expect(revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: issued.id, now: Date.now() })).not.toBeNull(); };
      const context = { turnId: "odysseus-private-worktree", egress: f.egress, current: () => f.state.current };
      const worktrees = createReferenceWorktrees({ db: f.db, pool: f.pool, sources: f.sources,
        coverage: async () => { if (wait === "coverage") revoke(); } });
      let generation: Awaited<ReturnType<typeof worktrees.openGeneration>> | undefined;
      try {
        const item = await worktrees.allocate({ principalId: f.owner.id, repository, revision: "main", acquisition: context });
        generation = await worktrees.openGeneration({ principalId: f.owner.id, turnId: context.turnId, profile: "governed" });
        if (wait.startsWith("held-")) {
          await worktrees.access({ worktreeId: item.id, principalId: f.owner.id, generation: generation.id, acquisition: context });
          expect(existsSync(join(generation.path, item.id, "README.md")), "PRIVATE_WORKTREE_WAS_GRANTED_BEFORE_REVOCATION").toBe(true);
        }
        f.state.private = true;
        if (wait.endsWith("write")) f.db.exec(`CREATE TRIGGER odysseus_revoke_during_worktree_grant AFTER UPDATE OF holder ON reference_worktrees
          WHEN NEW.holder IS NOT NULL BEGIN UPDATE reference_grants SET revoked_at = 1 WHERE revoked_at IS NULL; END`);
        if (wait === "native-grant") {
          const access = f.pool.poolAccess;
          f.pool.poolAccess = async (...args) => { const result = await access(...args); revoke(); return result; };
        }
        if (wait === "held-refresh") {
          const request = f.sources.request;
          f.sources.request = async input => { const result = await request(input); revoke(); return result; };
        }
        await expect(worktrees.access({ worktreeId: item.id, principalId: f.owner.id, generation: generation.id, acquisition: context }),
          "MANAGED_PRIVATE_WORKTREE_RECHECKS_POST_WAIT_GRANT").rejects.toMatchObject({ code: "unauthorized" });
        expect(f.pool.records.get(item.id)!.access, "MANAGED_PRIVATE_WORKTREE_REVOKED_MOUNT_IS_PARKED").toBeNull();
        expect(existsSync(join(generation.path, item.id, "README.md")), "MANAGED_PRIVATE_WORKTREE_REVOKED_FILES_ARE_HIDDEN").toBe(false);
        expect(worktrees.get({ worktreeId: item.id, principalId: f.owner.id }).generation, "MANAGED_PRIVATE_WORKTREE_REVOKED_HOLDER_IS_CLEARED").toBeNull();
      } finally { if (generation) await worktrees.closeGeneration(generation.id); await worktrees.close(); await f.close(); }
    });

  test("a public-to-private worktree can still be accessed while its private grant remains live", async () => {
    const f = await fixture(); f.grant();
    const context = { turnId: "odysseus-transition-worktree", egress: f.egress, current: () => f.state.current };
    const worktrees = createReferenceWorktrees({ db: f.db, pool: f.pool, sources: f.sources, coverage: async () => {} });
    let generation: Awaited<ReturnType<typeof worktrees.openGeneration>> | undefined;
    try {
      const item = await worktrees.allocate({ principalId: f.owner.id, repository, revision: "main", acquisition: context });
      f.state.private = true;
      generation = await worktrees.openGeneration({ principalId: f.owner.id, turnId: context.turnId, profile: "governed" });
      const accessed = await worktrees.access({ worktreeId: item.id, principalId: f.owner.id, generation: generation.id, acquisition: context });
      expect(accessed.generation).toBe(generation.id);
      expect(readFileSync(join(generation.path, item.id, "README.md"), "utf8")).toContain("Odysseus");
    } finally { if (generation) await worktrees.closeGeneration(generation.id); await worktrees.close(); await f.close(); }
  });

  for (const wait of ["native-create", "checkpoint", "activation-write"] as const)
    test(`a private allocation is discarded when its grant is revoked during ${wait}`, async () => {
      const f = await fixture({ private: true }), issued = f.grant();
      const context = { turnId: "odysseus-private-allocation", egress: f.egress, current: () => f.state.current };
      const worktrees = createReferenceWorktrees({ db: f.db, pool: f.pool, sources: f.sources, coverage: async () => {} });
      const revoke = () => { expect(revokeReferenceGrant(f.db, { brain, principalId: f.owner.id, id: issued.id, now: Date.now() })).not.toBeNull(); };
      try {
        if (wait === "native-create") {
          const create = f.pool.poolCreate;
          f.pool.poolCreate = async (...args) => { const result = await create(...args); if (args[1] === "worktree") revoke(); return result; };
        }
        if (wait === "checkpoint") {
          const checkpoint = f.pool.poolCheckpoint;
          f.pool.poolCheckpoint = async (...args) => { const result = await checkpoint(...args); revoke(); return result; };
        }
        if (wait === "activation-write") f.db.exec(`CREATE TRIGGER odysseus_revoke_at_worktree_activation AFTER UPDATE OF state ON reference_worktrees
          WHEN NEW.state = 'active' BEGIN UPDATE reference_grants SET revoked_at = 1 WHERE revoked_at IS NULL; END`);
        await expect(worktrees.allocate({ principalId: f.owner.id, repository, revision: "main", acquisition: context }),
          "MANAGED_PRIVATE_ALLOCATION_RECHECKS_POST_WAIT_GRANT").rejects.toMatchObject({ code: "unauthorized" });
        expect(worktrees.list(f.owner.id), "MANAGED_PRIVATE_REVOKED_ALLOCATION_IS_DISCARDED").toEqual([]);
        expect([...f.pool.records.values()].filter(record => record.purpose === "worktree" && record.state !== "reclaimed"),
          "MANAGED_PRIVATE_REVOKED_ALLOCATION_LEAVES_NO_ROOT").toEqual([]);
      } finally { await worktrees.close(); await f.close(); }
    });
});
