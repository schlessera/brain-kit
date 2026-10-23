import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createUiDb } from "../src/db/client";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import { createReferenceSources, referenceSourceName, type ReferenceSourceLease } from "../src/brain/reference-source";
import { ReferenceTransportError, type ReferenceTransport } from "../src/brain/reference-transport";
import { referencePoolDouble } from "./helpers/reference-pool-double";
import { referenceRepository } from "../src/db/reference-grants";

const BRAIN = "ithaca-brain", DAY = 86_400, TOKEN = "fixture-reference-token";
const PUBLIC = "https://github.com/odysseus/ithaca", PRIVATE = "https://github.com/odysseus/penelope-loom";
let root: string, db: Database, clock: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "reference-source-")); db = createUiDb(":memory:"); clock = Date.now(); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const owner = () => createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 30 * DAY });
const agent = (by: string, label = "Telemachus") => createPrincipal(db, { authMethod: "delegated", label, createdBy: by, ttlSeconds: 7 * DAY });
const grant = (principalId: string, by: string, prefix = "https://github.com/odysseus") =>
  createReferenceGrant(db, { brain: BRAIN, principalId, repositoryPrefix: prefix, credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", createdBy: by, now: Date.now() });

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Scripted repositories: anonymous access only to public ones; the private one needs the fixture token. */
function scripted() {
  const repos = new Map<string, { private: boolean; tip: string }>([[PUBLIC, { private: false, tip: "1".repeat(40) }], [PRIVATE, { private: true, tip: "2".repeat(40) }],
    ["https://github.com/odysseus/argo", { private: false, tip: "3".repeat(40) }], ["https://github.com/odysseus/scylla", { private: false, tip: "4".repeat(40) }]]);
  const state = { resolves: [] as { repository: string; token: string | null }[], fetches: [] as { repository: string; token: string | null }[], active: 0, maxActive: 0,
    gate: null as null | ReturnType<typeof deferred>, unavailable: false, fetchFailure: null as null | Error, checkoutFailure: null as null | Error, settleDelayMs: 0,
    events: [] as string[], onResolve: null as null | ((token: string | null) => void) };
  const transport: ReferenceTransport = {
    async resolve({ repository, token }) {
      state.resolves.push({ repository: repository.canonical, token });
      state.onResolve?.(token);
      if (state.unavailable) return { ok: false, reason: "unavailable", detail: "fixture network unavailable" };
      const repo = repos.get(repository.canonical);
      if (!repo || (repo.private && token !== TOKEN)) return { ok: false, reason: "denied", detail: "fatal: repository not found" };
      return { ok: true, commit: repo.tip, ref: "refs/heads/main" };
    },
    async fetch({ repository, token, root: target, signal }) {
      state.fetches.push({ repository: repository.canonical, token });
      state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (state.gate) await Promise.race([state.gate.promise, new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
        if (state.fetchFailure) throw state.fetchFailure;
        const repo = repos.get(repository.canonical)!;
        writeFileSync(join(target, "README.md"), `${repository.canonical}@${repo.tip}\n`);
        return { commit: repo.tip };
      } finally {
        // A real worker needs time to tear down after an abort.
        if (state.settleDelayMs) await Bun.sleep(state.settleDelayMs);
        state.active--; state.events.push("fetch-settled");
      }
    },
    async checkout() { if (state.checkoutFailure) throw state.checkoutFailure; },
  };
  return { repos, state, transport };
}

function service(options: { limits?: Record<string, number>; capacityRoots?: number } = {}) {
  const fixture = scripted();
  const pool = referencePoolDouble(join(root, "pool"), { capacityRoots: options.capacityRoots });
  const originalRelease = pool.poolRelease;
  pool.poolRelease = async (id, signal) => { fixture.state.events.push(`release:${id}`); return originalRelease(id, signal); };
  const sources = createReferenceSources({ db, pool, transport: fixture.transport, brain: BRAIN, credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN },
    limits: options.limits, now: () => clock });
  return { ...fixture, pool, sources };
}
const read = (lease: ReferenceSourceLease) => readFileSync(join(lease.viewPath, lease.name, "README.md"), "utf8").trim();
const minutes = (count: number) => { clock += count * 60_000; };

describe("authority and sharing domains", () => {
  test("public source is shared host-wide and only ever fetched anonymously", async () => {
    const { sources, state } = service();
    const penelope = owner(), telemachus = agent(penelope.id);
    grant(telemachus.id, penelope.id);
    const first = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const second = await sources.request({ principalId: telemachus.id, repository: `${PUBLIC}.git`, revision: "main" });
    expect(first.domain).toBe("public");
    expect(second.view, "REFERENCE_SOURCE_PUBLIC_SHARED").toBe(first.view);
    expect(state.fetches).toHaveLength(1);
    expect([...state.resolves, ...state.fetches].every(call => call.token === null), "REFERENCE_SOURCE_PUBLIC_NEVER_CREDENTIALED").toBe(true);
    expect(read(first)).toBe(`${PUBLIC}@${"1".repeat(40)}`);
    expect(first.name).toBe(referenceSourceName(referenceRepository(PUBLIC), "main"));
  });

  test("private source needs a live covering grant and stays inside its principal's domain", async () => {
    const { sources, state } = service();
    const penelope = owner(), telemachus = agent(penelope.id), eurycleia = agent(penelope.id, "Eurycleia");
    grant(telemachus.id, penelope.id); grant(eurycleia.id, penelope.id);
    const mine = await sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" });
    expect(mine.domain).toBe("private");
    expect(state.fetches.at(-1)?.token, "REFERENCE_SOURCE_GRANT_CREDENTIAL_USED").toBe(TOKEN);
    const theirs = await sources.request({ principalId: eurycleia.id, repository: PRIVATE, revision: "main" });
    expect(theirs.view, "REFERENCE_SOURCE_PRIVATE_DOMAIN_ISOLATED").not.toBe(mine.view);
    expect(state.fetches.filter(call => call.repository === PRIVATE), "REFERENCE_SOURCE_PRIVATE_NOT_SHARED").toHaveLength(2);
    expect(sources.views(telemachus.id).private).toBe(mine.viewPath);
    expect(sources.views(eurycleia.id).private).toBe(theirs.viewPath);
    await expect(sources.request({ principalId: penelope.id, repository: PRIVATE, revision: "main" }), "REFERENCE_SOURCE_PRINCIPAL_SUBSTITUTION_REFUSED")
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  test("a configured host credential alone never authorizes private access", async () => {
    const { sources, state } = service();
    const penelope = owner();
    await expect(sources.request({ principalId: penelope.id, repository: PRIVATE, revision: "main" }), "REFERENCE_SOURCE_CREDENTIAL_IS_NOT_AUTHORITY")
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(state.resolves.every(call => call.token === null)).toBe(true);
    expect(state.fetches).toHaveLength(0);
  });

  test("a public-to-private transition withdraws the public copy and never serves it under public authority", async () => {
    const { sources, state, repos, pool } = service();
    const penelope = owner(), telemachus = agent(penelope.id);
    const shared = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    shared.release();
    minutes(6);
    repos.get(PUBLIC)!.private = true;
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" }), "REFERENCE_SOURCE_PUBLIC_TO_PRIVATE_REFUSED")
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(existsSync(join(shared.viewPath, shared.name)), "REFERENCE_SOURCE_PUBLIC_TO_PRIVATE_UNPUBLISHED").toBe(false);
    expect([...pool.records.values()].filter(record => record.state === "sealed"), "REFERENCE_SOURCE_PUBLIC_COPY_RELEASED").toHaveLength(0);
    grant(telemachus.id, penelope.id);
    const now = await sources.request({ principalId: telemachus.id, repository: PUBLIC, revision: "main" });
    expect(now.domain).toBe("private");
    expect(state.fetches.at(-1)?.token).toBe(TOKEN);
  });
});

describe("validation, refresh and stale fallback", () => {
  test("refresh happens only on request, after the cooldown since the last successful refresh", async () => {
    const { sources, state, repos } = service();
    const penelope = owner();
    const first = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    minutes(4);
    const reused = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    expect(state.resolves, "REFERENCE_SOURCE_COOLDOWN_REUSES").toHaveLength(1);
    expect(reused.refreshedAt).toBe(first.refreshedAt);
    repos.get(PUBLIC)!.tip = "5".repeat(40);
    minutes(2);
    const refreshed = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    expect(refreshed.commit).toBe("5".repeat(40));
    expect(read(first), "REFERENCE_SOURCE_REFRESH_REPUBLISHES").toBe(`${PUBLIC}@${"5".repeat(40)}`);
    expect(refreshed.refreshedAt).toBe(clock);
  });

  test("a failed refresh returns the previous authorized revision as stale without advancing its refresh time", async () => {
    const { sources, state, repos } = service({ limits: { validationMs: 600_000, refreshMs: 300_000 } });
    const penelope = owner();
    const first = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    repos.get(PUBLIC)!.tip = "6".repeat(40);
    state.fetchFailure = new Error("fixture fetch failed");
    minutes(6);
    const stale = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    expect(stale, "REFERENCE_SOURCE_STALE_FALLBACK").toMatchObject({ stale: true, commit: "1".repeat(40), error: expect.stringContaining("fixture fetch failed") });
    expect(stale.refreshedAt, "REFERENCE_SOURCE_FAILED_REFRESH_KEEPS_TIMESTAMP").toBe(first.refreshedAt);
    expect(read(stale)).toBe(`${PUBLIC}@${"1".repeat(40)}`);
  });

  test("expired validation refuses cached bytes when the fresh check cannot succeed", async () => {
    const { sources, state } = service({ limits: { validationMs: 300_000, refreshMs: 600_000 } });
    const penelope = owner();
    const first = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    first.release();
    minutes(6);
    state.unavailable = true;
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" }), "REFERENCE_SOURCE_EXPIRED_VALIDATION_REFUSES")
      .rejects.toMatchObject({ code: "unavailable" });
  });

  test("an outage inside still-valid authority reuses the source explicitly stale", async () => {
    const { sources, state } = service({ limits: { validationMs: 600_000, refreshMs: 60_000 } });
    const penelope = owner();
    await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    minutes(2);
    state.unavailable = true;
    expect(await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" }), "REFERENCE_SOURCE_OUTAGE_INSIDE_AUTHORITY")
      .toMatchObject({ stale: true, error: "fixture network unavailable" });
  });

  test("a failed acquisition never publishes and releases its staging reservation", async () => {
    const { sources, state, pool } = service();
    const penelope = owner();
    state.checkoutFailure = new Error("fixture checkout failed");
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" }), "REFERENCE_SOURCE_FAILED_ACQUISITION_REFUSES").rejects.toThrow("fixture checkout failed");
    expect(pool.events.filter(event => event.operation === "publish"), "REFERENCE_SOURCE_FAILED_ACQUISITION_UNPUBLISHED").toHaveLength(0);
    expect([...pool.records.values()].map(record => record.state)).toEqual(["reclaimed"]);
    expect(db.query("SELECT COUNT(*) AS n FROM reference_roots").get()).toEqual({ n: 0 });
  });
});

describe("admission, cancellation and eviction", () => {
  test("same-source requests in one domain join a single operation", async () => {
    const { sources, state } = service();
    const penelope = owner(), telemachus = agent(penelope.id);
    state.gate = deferred();
    const requests = [penelope.id, telemachus.id, penelope.id, telemachus.id].map(principalId => sources.request({ principalId, repository: PUBLIC, revision: "main" }));
    await Bun.sleep(10);
    state.gate.resolve();
    const leases = await Promise.all(requests);
    expect(state.fetches, "REFERENCE_SOURCE_SINGLE_FLIGHT").toHaveLength(1);
    expect(new Set(leases.map(lease => lease.commit)).size).toBe(1);
  });

  test("at most two acquisitions run host-wide; readers are not admitted operations", async () => {
    const { sources, state } = service();
    const penelope = owner();
    state.gate = deferred();
    const requests = [PUBLIC, "https://github.com/odysseus/argo", "https://github.com/odysseus/scylla"]
      .map(repository => sources.request({ principalId: penelope.id, repository, revision: "main" }));
    try {
      await Bun.sleep(10);
      expect(sources.activity(), "REFERENCE_SOURCE_TWO_OPERATIONS").toEqual({ active: 2, waiting: 1 });
      expect(state.maxActive).toBe(2);
    } finally { state.gate.resolve(); await Promise.allSettled(requests); }
    await Promise.all(requests);
    expect(state.maxActive, "REFERENCE_SOURCE_THIRD_WAITED").toBe(2);
    const resolves = state.resolves.length;
    await Promise.all(Array.from({ length: 12 }, () => sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })));
    expect(state.resolves.length, "REFERENCE_SOURCE_READERS_UNCAPPED").toBe(resolves);
  });

  test("a full admission queue refuses instead of growing", async () => {
    const { sources, state } = service({ limits: { operations: 1, waiters: 1 } });
    const penelope = owner();
    state.gate = deferred();
    const running = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const waiting = sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/argo", revision: "main" });
    await Bun.sleep(10);
    const third = sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/scylla", revision: "main" });
    const early = await Promise.race([third.then(() => "admitted", (error: { code?: string }) => error.code ?? "error"), Bun.sleep(50).then(() => "waiting")]);
    state.gate.resolve();
    await Promise.allSettled([running, waiting, third]);
    expect(early, "REFERENCE_SOURCE_QUEUE_BOUNDED").toBe("busy");
  });

  test("cancellation releases staging only after the transport worker stopped, and never publishes", async () => {
    const { sources, state, pool } = service();
    const penelope = owner();
    state.gate = deferred(); state.settleDelayMs = 30;
    const controller = new AbortController();
    const request = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main", signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    try { await expect(request).rejects.toMatchObject({ code: "cancelled" }); }
    finally { state.gate.resolve(); await sources.close(); }
    const settled = state.events.indexOf("fetch-settled"), released = state.events.findIndex(event => event.startsWith("release:"));
    expect(settled, "REFERENCE_SOURCE_RESERVATION_HELD_UNTIL_WORKER_STOPS").toBeGreaterThanOrEqual(0);
    expect(released, "REFERENCE_SOURCE_RESERVATION_HELD_UNTIL_WORKER_STOPS").toBeGreaterThan(settled);
    expect(pool.events.some(event => event.operation === "publish")).toBe(false);
  });

  test("revocation cancels in-flight private work and withdraws published private source", async () => {
    const { sources, state, pool } = service();
    const penelope = owner(), telemachus = agent(penelope.id);
    const record = grant(telemachus.id, penelope.id);
    state.gate = deferred();
    const request = sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" });
    await Bun.sleep(10);
    revokeReferenceGrant(db, { brain: BRAIN, principalId: telemachus.id, id: record.id, now: Date.now() });
    await sources.revoke({ grantIds: [record.id], principalIds: [] });
    const outcome = await Promise.race([request.then(() => "published", () => "refused"), Bun.sleep(2_000).then(() => "running")]);
    state.gate.resolve();
    expect(outcome, "REFERENCE_SOURCE_REVOCATION_CANCELS_REFRESH").toBe("refused");
    expect(pool.events.some(event => event.operation === "publish"), "REFERENCE_SOURCE_REVOKED_NEVER_PUBLISHED").toBe(false);
    state.gate = null;
    grant(telemachus.id, penelope.id);
    const published = await sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" });
    published.release();
    revokePrincipal(db, telemachus.id, Date.now());
    await sources.revoke({ grantIds: [], principalIds: [telemachus.id] });
    expect(existsSync(join(published.viewPath, published.name)), "REFERENCE_SOURCE_PRINCIPAL_REVOCATION_WITHDRAWS").toBe(false);
  });

  test("capacity evicts the least recently used unleased source and never a leased one", async () => {
    const { sources, pool } = service({ capacityRoots: 2 });
    const penelope = owner();
    const ithaca = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const argo = await sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/argo", revision: "main" });
    // Both readers active: nothing may be evicted.
    await expect(sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/scylla", revision: "main" }), "REFERENCE_SOURCE_LEASED_NOT_EVICTED")
      .rejects.toMatchObject({ code: "capacity" });
    ithaca.release(); argo.release();
    minutes(1);
    (await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })).release();
    const scylla = await sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/scylla", revision: "main" });
    expect(existsSync(join(argo.viewPath, argo.name)), "REFERENCE_SOURCE_LRU_EVICTED").toBe(false);
    expect(read(ithaca), "REFERENCE_SOURCE_RECENT_KEPT").toContain(PUBLIC);
    expect(read(scylla)).toContain("scylla");
    expect([...pool.records.values()].filter(record => record.state === "sealed")).toHaveLength(2);
  });

  test("an active reader keeps the superseded revision until it releases; refresh still proceeds", async () => {
    const { sources, repos, pool } = service();
    const penelope = owner();
    const reader = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    repos.get(PUBLIC)!.tip = "7".repeat(40);
    minutes(6);
    (await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })).release();
    expect([...pool.records.values()].filter(record => record.state === "sealed"), "REFERENCE_SOURCE_READER_DOES_NOT_BLOCK_REFRESH").toHaveLength(2);
    reader.release();
    await Bun.sleep(5);
    expect([...pool.records.values()].filter(record => record.state === "sealed"), "REFERENCE_SOURCE_SUPERSEDED_RELEASED_AFTER_READERS").toHaveLength(1);
  });

  test("restart recovery releases interrupted staging and roots the catalog lost", async () => {
    const first = service();
    const penelope = owner();
    const kept = await first.sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    kept.release();
    await first.pool.poolCreate("00000000-0000-4000-8000-0000000002a1", "source", null, 4096);
    db.query("INSERT INTO reference_roots (id, domain, repository, revision, state, created_at) VALUES ('00000000-0000-4000-8000-0000000002a1', 'public', ?, 'main', 'staging', 1)").run(PUBLIC);
    await first.pool.poolCreate("00000000-0000-4000-8000-0000000002a2", "source", null, 4096);
    const result = await first.sources.recover();
    expect(result.released.sort(), "REFERENCE_SOURCE_RECOVERY_RELEASES_UNPUBLISHED").toEqual(["00000000-0000-4000-8000-0000000002a1", "00000000-0000-4000-8000-0000000002a2"]);
    expect(read(kept)).toContain(PUBLIC);
  });

  test("invalid repositories and revisions refuse before any transport", async () => {
    const { sources, state } = service();
    const penelope = owner();
    for (const [repository, revision] of [["ssh://git@github.com/odysseus/ithaca", "main"], [PUBLIC, "../main"], [PUBLIC, "a".repeat(40)], [PUBLIC, "-main"], [PUBLIC, "main.lock"]])
      await expect(sources.request({ principalId: penelope.id, repository, revision }), `${repository} ${revision}`).rejects.toMatchObject({ code: "invalid" });
    expect(state.resolves).toHaveLength(0);
  });
});

describe("review regressions", () => {
  test("withdrawal removes a leased private root from its view by identity, not only by name", async () => {
    const { sources, pool } = service();
    const penelope = owner(), telemachus = agent(penelope.id);
    grant(telemachus.id, penelope.id);
    const reader = await sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" });
    const root = [...pool.records.values()].find(record => record.view === reader.view)!.id;
    expect(readdirSync(reader.viewPath)).toContain(root);
    revokePrincipal(db, telemachus.id, Date.now());
    await sources.revoke({ grantIds: [], principalIds: [telemachus.id] });
    expect(readdirSync(reader.viewPath), "REFERENCE_SOURCE_WITHDRAWN_IDENTITY_GONE").not.toContain(root);
    expect(pool.records.get(root)?.state, "REFERENCE_SOURCE_LEASED_STORAGE_KEPT").toBe("sealed");
    reader.release();
    await Bun.sleep(5);
    expect(pool.records.get(root)?.state).toBe("reclaimed");
  });

  test("private authority is read again after admission and before a lease is returned", async () => {
    const { sources, state } = service({ limits: { operations: 1, refreshMs: 60_000, validationMs: 600_000 } });
    const penelope = owner(), telemachus = agent(penelope.id);
    grant(telemachus.id, penelope.id);
    (await sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" })).release();
    minutes(2);
    // The private refresh waits for admission behind another operation; its principal is revoked meanwhile.
    state.gate = deferred();
    const holding = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    await Bun.sleep(10);
    const queued = sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" });
    await Bun.sleep(10);
    expect(sources.activity()).toEqual({ active: 1, waiting: 1 });
    revokePrincipal(db, telemachus.id, Date.now());
    const credentialed = state.resolves.filter(call => call.repository === PRIVATE && call.token).length;
    state.gate.resolve();
    await holding;
    await expect(queued).rejects.toMatchObject({ code: "unauthorized" });
    // Not even the credentialed check runs once admission finds the authority gone.
    expect(state.resolves.filter(call => call.repository === PRIVATE && call.token).length, "REFERENCE_SOURCE_AUTHORITY_RECHECKED_AFTER_ADMISSION").toBe(credentialed);
    const eurycleia = agent(penelope.id, "Eurycleia");
    grant(eurycleia.id, penelope.id);
    (await sources.request({ principalId: eurycleia.id, repository: PRIVATE, revision: "main" })).release();
    minutes(2);
    // Authority ends during the credentialed check, which then confirms the unchanged commit.
    state.onResolve = token => { if (token) revokePrincipal(db, eurycleia.id, Date.now()); };
    await expect(sources.request({ principalId: eurycleia.id, repository: PRIVATE, revision: "main" }), "REFERENCE_SOURCE_PRIVATE_LEASE_RECHECKED")
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  test("an anonymous fetch denial withdraws public source instead of serving it stale", async () => {
    const { sources, state, repos } = service({ limits: { validationMs: 600_000, refreshMs: 300_000 } });
    const penelope = owner();
    const shared = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    shared.release();
    repos.get(PUBLIC)!.tip = "8".repeat(40);
    state.fetchFailure = new ReferenceTransportError("denied", "reference fetch failed: HTTP 403");
    minutes(6);
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" }), "REFERENCE_SOURCE_FETCH_DENIAL_WITHDRAWS")
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(existsSync(join(shared.viewPath, shared.name))).toBe(false);
  });

  test("restart recovery withdraws private source whose grant was revoked before the withdrawal ran", async () => {
    const first = service();
    const penelope = owner(), telemachus = agent(penelope.id);
    const record = grant(telemachus.id, penelope.id);
    const reader = await first.sources.request({ principalId: telemachus.id, repository: PRIVATE, revision: "main" });
    reader.release();
    revokeReferenceGrant(db, { brain: BRAIN, principalId: telemachus.id, id: record.id, now: Date.now() });
    const restarted = createReferenceSources({ db, pool: first.pool, transport: first.transport, brain: BRAIN, credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN }, now: () => clock });
    await restarted.recover();
    expect(existsSync(join(reader.viewPath, reader.name)), "REFERENCE_SOURCE_RECOVERY_WITHDRAWS_REVOKED").toBe(false);
    expect(readdirSync(reader.viewPath)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM reference_sources").get()).toEqual({ n: 0 });
  });

  test("a publication whose reply was lost restores the previous revision's name", async () => {
    const { sources, repos, pool } = service({ limits: { validationMs: 600_000, refreshMs: 300_000 } });
    const penelope = owner();
    const first = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    first.release();
    repos.get(PUBLIC)!.tip = "9".repeat(40);
    const publish = pool.poolPublish;
    let lost = false;
    pool.poolPublish = async (...args) => { const record = await publish(...args); if (!lost) { lost = true; throw new Error("fixture reply lost"); } return record; };
    minutes(6);
    const stale = await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    expect(existsSync(join(stale.viewPath, stale.name, "README.md")), "REFERENCE_SOURCE_LOST_PUBLICATION_RESTORED").toBe(true);
    expect(stale.stale).toBe(true);
    expect(read(stale)).toBe(`${PUBLIC}@${"1".repeat(40)}`);
  });

  test("restart recovery resumes an interrupted root deletion", async () => {
    const { sources, pool } = service();
    const record = await pool.poolCreate("00000000-0000-4000-8000-0000000002b1", "source", null, 4096);
    record.state = "deleting";
    const result = await sources.recover();
    expect(result.released, "REFERENCE_SOURCE_RECOVERY_RESUMES_DELETION").toContain(record.id);
    expect(pool.records.get(record.id)?.state).toBe("reclaimed");
  });

  test("eviction fences its victim before any await so no new lease reaches a removed path", async () => {
    const { sources, pool } = service({ capacityRoots: 2 });
    const penelope = owner();
    (await sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })).release();
    minutes(1);
    (await sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/argo", revision: "main" })).release();
    const unpublish = pool.poolUnpublish, paused = deferred();
    let pausing = true;
    pool.poolUnpublish = async (...args) => { if (pausing) { pausing = false; await paused.promise; } return unpublish(...args); };
    const third = sources.request({ principalId: penelope.id, repository: "https://github.com/odysseus/scylla", revision: "main" });
    await Bun.sleep(10);
    const raced = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    await Bun.sleep(10);
    paused.resolve();
    const [victim] = await Promise.allSettled([raced, third]);
    expect(victim.status === "fulfilled" && existsSync(join(victim.value.viewPath, victim.value.name, "README.md")), "REFERENCE_SOURCE_EVICTION_FENCED").toBe(true);
  });

  test("an already-cancelled request is refused without an unobserved rejection", async () => {
    const { sources } = service();
    const penelope = owner();
    const unobserved: unknown[] = [];
    const track = (reason: unknown) => { unobserved.push(reason); };
    process.on("unhandledRejection", track);
    try {
      const controller = new AbortController(); controller.abort();
      await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main", signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
      await Bun.sleep(20);
      expect(unobserved, "REFERENCE_SOURCE_ABORTED_REQUEST_OBSERVED").toEqual([]);
      expect(sources.activity()).toEqual({ active: 0, waiting: 0 });
    } finally { process.off("unhandledRejection", track); }
  });
});
