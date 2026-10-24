import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ReferenceToolCall, ReferenceToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import { createReferenceSources } from "../src/brain/reference-source";
import type { ReferenceTransport } from "../src/brain/reference-transport";
import { createReferenceTools } from "../src/brain/reference-tools";
import { createReferenceWorktrees, ReferenceWorktreeError, referenceWorktreeDependents } from "../src/brain/reference-worktrees";
import { referencePoolDouble } from "./helpers/reference-pool-double";

const BRAIN = "ithaca-brain", DAY = 86_400, TOKEN = "fixture-reference-token";
const PUBLIC = "https://github.com/odysseus/ithaca", PRIVATE = "https://github.com/odysseus/penelope-loom";
let root: string, db: Database, clock: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "reference-tools-")); db = createUiDb(":memory:"); clock = Date.now(); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const principal = (label = "Penelope") => createPrincipal(db, { authMethod: "password", label, ttlSeconds: 30 * DAY });
const grant = (principalId: string) => createReferenceGrant(db, { brain: BRAIN, principalId, repositoryPrefix: "https://github.com/odysseus",
  credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", createdBy: principalId, now: Date.now() });

function host() {
  const tips = new Map([[PUBLIC, "1".repeat(40)], [PRIVATE, "2".repeat(40)]]);
  const state = { failFetch: false, resolves: 0, fetches: 0, unavailable: false, failResolves: 0, gate: null as Promise<void> | null, onResolve: null as null | (() => void) };
  const transport: ReferenceTransport = {
    async resolve({ repository, token }) {
      state.resolves++;
      state.onResolve?.();
      await state.gate;
      if (state.unavailable) return { ok: false, reason: "unavailable", detail: "fixture network unavailable" };
      if (state.failResolves > 0) { state.failResolves--; return { ok: false, reason: "unavailable", detail: "fixture network unavailable" }; }
      const tip = tips.get(repository.canonical) ?? (repository.canonical.startsWith(`${PUBLIC}-`) ? "4".repeat(40) : undefined);
      if (!tip || (repository.canonical === PRIVATE && token !== TOKEN)) return { ok: false, reason: "denied", detail: "fatal: repository not found" };
      return { ok: true, commit: tip, ref: "refs/heads/main" };
    },
    async fetch({ repository, root: target }) {
      state.fetches++;
      if (state.failFetch) throw new Error(`fetch failed under ${join(root, "pool")}/roots`);
      writeFileSync(join(target, "odyssey.md"), `${repository.canonical}: Sing, Muse, of the man of many ways.\n`);
      return { commit: tips.get(repository.canonical) ?? "4".repeat(40) };
    },
    async checkout() {},
  };
  const pool = referencePoolDouble(join(root, "pool"));
  const sources = createReferenceSources({ db, pool, transport, brain: BRAIN, credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN }, now: () => clock,
    limits: { refreshMs: 60_000 }, dependents: rootId => referenceWorktreeDependents(db, rootId) });
  const worktrees = createReferenceWorktrees({ db, pool, sources, now: () => clock, coverage: async () => {} });
  const released: string[] = [];
  const counted = { ...sources, async request(input: Parameters<typeof sources.request>[0]) {
    const lease = await sources.request(input);
    return { ...lease, release() { released.push(lease.name); lease.release(); } };
  } };
  const tools = createReferenceTools({ sources: counted, worktrees });
  const views = () => readdirSync(join(root, "pool", "views")).flatMap(view => readdirSync(join(root, "pool", "views", view)));
  /** One interactive turn, prepared as run-session prepares it. */
  async function turn(principalId: string, options: { generation?: boolean; posture?: "interactive" | "voice" } = {}) {
    const turnId = crypto.randomUUID();
    const generation = options.generation === false ? null : await worktrees.openGeneration({ principalId, turnId, profile: "governed" });
    const views = await tools.begin(turnId, { principalId, posture: options.posture ?? "interactive", generation });
    const call = (input: ReferenceToolCall, caller = principalId) => tools.call(turnId, caller, input);
    return { turnId, generation, views, call };
  }
  return { pool, sources, worktrees, tools, turn, state, tips, released, views };
}
const ok = <T extends ReferenceToolResult>(result: ReferenceToolResult) => { expect(result.ok, JSON.stringify(result)).toBe(true); return result as Extract<T, { ok: true }>; };
const source = (repository: string, revision = "main"): ReferenceToolCall => ({ tool: "reference_source", input: { repository, revision } });
const worktree = (input: Record<string, unknown>): ReferenceToolCall => ({ tool: "reference_worktree", input: input as never });

describe("shared reference source", () => {
  test("a source is reported at its path inside the view this turn's workers bind", async () => {
    const { turn, pool } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    expect(current.views, "REFERENCE_TOOLS_VIEWS_OPENED_BEFORE_PUBLICATION").not.toBeNull();
    expect(existsSync(current.views!.public) && existsSync(current.views!.private)).toBe(true);
    const result = ok<Extract<ReferenceToolResult, { source: unknown }>>(await current.call(source(PUBLIC)));
    expect(result.source, "REFERENCE_TOOLS_SOURCE_REPORTS_BOUND_PATH").toMatchObject({ domain: "public", commit: "1".repeat(40), freshness: "fresh", error: null });
    const name = result.source.path!.slice("/tmp/brain-reference/public/".length);
    expect(result.source.path!.startsWith("/tmp/brain-reference/public/")).toBe(true);
    // The worker path names the same entry the bound host view resolves.
    expect(readFileSync(join(current.views!.public, name, "odyssey.md"), "utf8")).toContain("Sing, Muse");
    expect([...pool.records.values()].some(record => record.view && join(pool.records.get(record.id)!.path!, "..") === current.views!.public)).toBe(true);
  });

  test("a stale source reports its error and unchanged refresh time, without a host path", async () => {
    const { turn, state, tips } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    const first = ok<Extract<ReferenceToolResult, { source: unknown }>>(await current.call(source(PUBLIC)));
    clock += 61_000; tips.set(PUBLIC, "3".repeat(40)); state.failFetch = true;
    const stale = ok<Extract<ReferenceToolResult, { source: unknown }>>(await current.call(source(PUBLIC)));
    expect(stale.source, "REFERENCE_TOOLS_STALE_REPORTED").toMatchObject({ freshness: "stale", commit: "1".repeat(40), refreshedAt: first.source.refreshedAt });
    // The fetch error named a host path, so the result carries the fixed text and the host log the detail.
    expect(stale.source.error).toBe("The last refresh failed; its details are in the host log.");
    expect(stale.source.error, "REFERENCE_TOOLS_ERROR_HIDES_HOST_POOL").not.toContain(root);
  });

  test("private source needs the turn principal's live grant; another principal and a revoked grant are refused", async () => {
    const { turn } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const current = await turn(penelope.id);
    expect(await current.call(source(PRIVATE)), "REFERENCE_TOOLS_PRIVATE_NEEDS_GRANT").toMatchObject({ ok: false, code: "unauthorized" });
    const issued = grant(penelope.id);
    const result = ok<Extract<ReferenceToolResult, { source: unknown }>>(await current.call(source(PRIVATE)));
    expect(result.source.domain).toBe("private");
    expect(result.source.path!.startsWith("/tmp/brain-reference/private/")).toBe(true);
    // The bridge supplies the turn's principal; a mismatched caller holds nothing.
    expect(await current.call(source(PRIVATE), telemachus.id), "REFERENCE_TOOLS_PRINCIPAL_FROM_TURN").toMatchObject({ ok: false, code: "unavailable" });
    const theirs = await turn(telemachus.id);
    expect(await theirs.call(source(PRIVATE)), "REFERENCE_TOOLS_PRIVATE_NOT_SHARED").toMatchObject({ ok: false, code: "unauthorized" });
    expect(theirs.views!.private).not.toBe(current.views!.private);
    revokeReferenceGrant(db, { brain: BRAIN, principalId: penelope.id, id: issued.id, now: Date.now() });
    // Inside the validation lifetime: revocation needs no clock to take effect.
    expect(await current.call(source(PRIVATE)), "REFERENCE_TOOLS_REVOCATION_IMMEDIATE").toMatchObject({ ok: false, code: "unauthorized" });
    clock += 301_000;
    expect(await current.call(source(PRIVATE)), "REFERENCE_TOOLS_REVOKED_REFUSES").toMatchObject({ ok: false, code: "unauthorized" });
  });

  test("a turn the host did not prepare holds no reference access", async () => {
    const { tools } = host();
    const penelope = principal();
    expect(await tools.call("restricted-turn", penelope.id, source(PUBLIC)), "REFERENCE_TOOLS_UNPREPARED_TURN_REFUSED")
      .toMatchObject({ ok: false, code: "unavailable" });
  });

  test("the turn's readers protect each source until the turn ends, once per source", async () => {
    const { turn, tools, released } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    await current.call(source(PUBLIC)); await current.call(source(PUBLIC));
    expect(released, "REFERENCE_TOOLS_ONE_LEASE_PER_SOURCE").toHaveLength(1);
    tools.end(current.turnId);
    expect(released, "REFERENCE_TOOLS_LEASES_END_WITH_TURN").toHaveLength(2);
    expect(await current.call(source(PUBLIC))).toMatchObject({ ok: false, code: "unavailable" });
  });
});

/** What the public view holds: names and root identities alike. */
const publicEntries = (views: { public: string } | null) => views ? readdirSync(views.public).sort() : null;
const nameOf = (result: ReferenceToolResult) => ok<Extract<ReferenceToolResult, { source: unknown }>>(result).source.path!.split("/").at(-1)!;

describe("binding a view is a new mount (#2432, option 1)", () => {
  test("a lapsed source no turn reads is validated again before the next bind, and stays", async () => {
    const { turn, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    const name = nameOf(await first.call(source(PUBLIC)));
    const rootId = readlinkSync(join(first.views!.public, name));
    tools.end(first.turnId);
    clock += 301_000;
    const checks = state.resolves, fetches = state.fetches;
    const next = await turn(telemachus.id);
    expect({ checked: state.resolves - checks, fetched: state.fetches - fetches, entries: publicEntries(next.views) }, "REFERENCE_TOOLS_LAPSED_SOURCE_REVALIDATED_AT_BIND")
      .toEqual({ checked: 1, fetched: 0, entries: [name, rootId].sort() });
  });

  test("a lapsed source that fails the check is withheld by name and identity until a request validates it", async () => {
    const { turn, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    const name = nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    const next = await turn(telemachus.id);
    expect(publicEntries(next.views), "REFERENCE_TOOLS_FAILED_CHECK_WITHHELD").toEqual([]);
    expect(nameOf(await next.call(source(PUBLIC))), "REFERENCE_TOOLS_WITHHELD_SOURCE_REPUBLISHED").toBe(name);
    expect(publicEntries(next.views) ?? []).toContain(name);
  });

  test("a lapsed source a running turn reads is validated again before another turn binds the view", async () => {
    const { turn, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const reading = await turn(penelope.id);
    const name = nameOf(await reading.call(source(PUBLIC)));
    clock += 301_000;
    const checks = state.resolves, fetches = state.fetches;
    const next = await turn(telemachus.id);
    expect({ checked: state.resolves - checks, fetched: state.fetches - fetches, bound: (publicEntries(next.views) ?? []).includes(name) }, "REFERENCE_TOOLS_HELD_SOURCE_REVALIDATED_AT_BIND")
      .toEqual({ checked: 1, fetched: 0, bound: true });
    // The check renewed its validation: a bind right after needs none.
    await turn(telemachus.id);
    expect(state.resolves - checks, "REFERENCE_TOOLS_REVALIDATION_RENEWS_LIFETIME").toBe(1);
  });

  test("a held source whose check fails is withheld from the new bind, and the running reader keeps its lease", async () => {
    const { turn, state, released } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const reading = await turn(penelope.id);
    nameOf(await reading.call(source(PUBLIC)));
    clock += 301_000;
    state.unavailable = true;
    const next = await turn(telemachus.id);
    expect({ entries: publicEntries(next.views), releases: released.length }, "REFERENCE_TOOLS_FAILED_REVALIDATION_WITHHELD").toEqual({ entries: [], releases: 0 });
    expect(await reading.call(source(PUBLIC)), "REFERENCE_TOOLS_WITHHELD_UNTIL_VALIDATED").toMatchObject({ ok: false, code: "unavailable" });
  });

  test("a held source whose revision moved is withheld at bind without fetching, and a request refreshes it", async () => {
    const { turn, state, tips } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const reading = await turn(penelope.id);
    const name = nameOf(await reading.call(source(PUBLIC)));
    clock += 301_000;
    tips.set(PUBLIC, "3".repeat(40));
    const fetches = state.fetches;
    const next = await turn(telemachus.id);
    expect({ entries: publicEntries(next.views), fetched: state.fetches - fetches }, "REFERENCE_TOOLS_MOVED_REVISION_WITHHELD_WITHOUT_FETCH").toEqual({ entries: [], fetched: 0 });
    const refreshed = ok<Extract<ReferenceToolResult, { source: unknown }>>(await reading.call(source(PUBLIC)));
    expect({ commit: refreshed.source.commit, bound: (publicEntries(next.views) ?? []).includes(name) }).toEqual({ commit: "3".repeat(40), bound: true });
  });

  test("a source with less than a minute of validation left is checked before a bind", async () => {
    const { turn, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 270_000;
    const checks = state.resolves;
    const next = await turn(telemachus.id);
    expect({ checked: state.resolves - checks, admitted: publicEntries(next.views)?.length ?? null }, "REFERENCE_TOOLS_BIND_MARGIN").toEqual({ checked: 1, admitted: 2 });
  });

  test("a cancelled bind stops waiting for another request's acquisition, which goes on", async () => {
    const { turn, sources, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 61_000;
    let open!: () => void;
    state.gate = new Promise(resolve => { open = resolve; });
    const resolves = state.resolves;
    const refreshing = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    while (state.resolves === resolves) await Bun.sleep(1);
    const controller = new AbortController();
    const binding = sources.bindable(telemachus.id, controller.signal).then(() => "bound", (error: Error) => error.message);
    expect(await Promise.race([binding, Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
    controller.abort(new Error("turn cancelled"));
    expect(await Promise.race([binding, Bun.sleep(500).then(() => "waiting")]), "REFERENCE_TOOLS_CANCELLED_BIND_RETURNS").toBe("turn cancelled");
    open();
    (await refreshing).release();
  });
});

describe("admission (#2432 review)", () => {
  const lapsedSources = (views: { public: string }) => (db.query("SELECT name, validated_at FROM reference_sources WHERE domain = 'public'").all() as { name: string; validated_at: number }[])
    .filter(row => readdirSync(views.public).includes(row.name) && row.validated_at + 300_000 <= clock + 60_000).map(row => row.name);
  async function cached(count: number) {
    const h = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    for (let index = 0; index < count; index++) (await h.sources.request({ principalId: penelope.id, repository: `${PUBLIC}-${index}`, revision: "main" })).release();
    clock += 301_000;
    return { ...h, telemachus };
  }

  test("no source a bind admits has lapsed while later checks ran", async () => {
    const { sources, state, telemachus } = await cached(13);
    // The first round of checks takes half a minute each, so the first batch nears
    // its margin before the last finishes; the bind checks those again before admitting.
    let slow = 13;
    const checks = state.resolves;
    state.onResolve = () => { if (slow-- > 0) clock += 30_000; };
    const views = await sources.bindable(telemachus.id);
    state.onResolve = null;
    expect({ admitted: readdirSync(views.public).length, lapsed: lapsedSources(views), rechecked: state.resolves - checks > 13 }, "REFERENCE_TOOLS_NO_LAPSED_SOURCE_AT_ADMISSION")
      .toEqual({ admitted: 26, lapsed: [], rechecked: true });
  });

  test("a bind whose sources keep lapsing while it checks them withholds them instead of admitting them", async () => {
    const { sources, state, telemachus } = await cached(13);
    const checks = state.resolves;
    state.onResolve = () => { clock += 110_000; };
    const bound = await sources.bindable(telemachus.id).then(views => ({ views, refused: null }), (error: Error) => ({ views: null, refused: error.message }));
    state.onResolve = null;
    expect(bound.refused, "REFERENCE_TOOLS_LAPSING_SOURCES_WITHHELD").toBeNull();
    const views = bound.views!;
    expect({ checked: state.resolves - checks > 13, lapsed: lapsedSources(views) }, "REFERENCE_TOOLS_LAPSING_SOURCES_WITHHELD").toEqual({ checked: true, lapsed: [] });
  });

  test("a bind over many healthy sources with slow checks converges", async () => {
    const { sources, state, telemachus } = await cached(100);
    // Sixteen seconds per batch of four: a full round of checks outlasts the margin,
    // so checking again keeps pushing other sources into it.
    state.onResolve = () => { clock += 4_000; };
    const bound = await sources.bindable(telemachus.id).then(views => ({ views, refused: null }), (error: Error) => ({ views: null, refused: error.message }));
    state.onResolve = null;
    expect(bound.refused, "REFERENCE_TOOLS_BIND_CONVERGES_WITH_MANY_SOURCES").toBeNull();
    const views = bound.views!;
    // The pool double holds 64 roots, so capacity eviction left 64 of the 100 cached.
    const cachedNames = (db.query("SELECT name FROM reference_sources WHERE domain = 'public' AND root_id IS NOT NULL").all() as { name: string }[]).map(row => row.name);
    const admitted = cachedNames.filter(name => readdirSync(views.public).includes(name));
    expect({ lapsed: lapsedSources(views), mostAdmitted: admitted.length >= cachedNames.length * 0.9 }, "REFERENCE_TOOLS_BIND_CONVERGES_WITH_MANY_SOURCES").toEqual({ lapsed: [], mostAdmitted: true });
  });

  test("a released root whose reply was lost is settled, not refused forever", async () => {
    const { turn, pool, sources } = host();
    const penelope = principal();
    const publish = pool.poolPublish, release = pool.poolRelease;
    pool.poolPublish = async (id, view, entry, signal) => { await publish(id, view, entry, signal); throw new Error("publication reply lost"); };
    let lost = 1, releases = 0;
    pool.poolRelease = async (id, signal) => { releases++; const record = await release(id, signal); if (lost-- > 0) throw new Error("release reply lost"); return record; };
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })).rejects.toThrow();
    pool.poolPublish = publish;
    // The publication took effect and its release did too, but neither reply arrived: the catalog still says staging.
    const orphan = db.query("SELECT id, state FROM reference_roots").get() as { id: string; state: string };
    expect({ state: orphan.state, pool: pool.records.get(orphan.id)?.state, releases }).toEqual({ state: "staging", pool: "reclaimed", releases: 1 });
    const next = await turn(penelope.id);
    expect({ bound: next.views !== null, entries: publicEntries(next.views), releases, catalog: db.query("SELECT id FROM reference_roots").all() }, "REFERENCE_TOOLS_RELEASED_ORPHAN_SETTLED")
      .toEqual({ bound: true, entries: [], releases: 2, catalog: [] });
  });

  test("a cancelled bind stops waiting for a suspension in progress", async () => {
    const { turn, pool, sources, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    const withdraw = pool.poolWithdraw;
    let open!: () => void, paused = false;
    const gate = new Promise<void>(resolve => { open = resolve; });
    pool.poolWithdraw = async (id, signal) => { if (!paused) { paused = true; await gate; } return withdraw(id, signal); };
    const controller = new AbortController();
    const binding = sources.bindable(telemachus.id, controller.signal).then(() => "bound", (error: Error) => error.message);
    while (!paused) await Bun.sleep(1);
    controller.abort(new Error("turn cancelled"));
    expect(await Promise.race([binding, Bun.sleep(500).then(() => "waiting")]), "REFERENCE_TOOLS_CANCELLED_BIND_DURING_SUSPENSION").toBe("turn cancelled");
    open();
  });
});

describe("exposure changes are serialized (#2432 review)", () => {
  test("a restoration waits for a suspension in progress, so a leased source never ends up out of its view", async () => {
    const { turn, pool, sources, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    const name = nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    const withdraw = pool.poolWithdraw;
    let open!: () => void, paused = false;
    const gate = new Promise<void>(resolve => { open = resolve; });
    pool.poolWithdraw = async (id, signal) => { if (!paused) { paused = true; await gate; } return withdraw(id, signal); };
    const binding = sources.bindable(telemachus.id);
    while (!paused) await Bun.sleep(1);
    const lease = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    await Bun.sleep(5);
    open();
    const views = await binding;
    const held = await lease;
    expect({ name: readdirSync(views.public).includes(name), root: existsSync(join(held.viewPath, held.name, "odyssey.md")) }, "REFERENCE_TOOLS_SUSPEND_RESTORE_SERIALIZED")
      .toEqual({ name: true, root: true });
    held.release();
  });

  test("a suspension the pool did not confirm refuses the bind, and the next bind retries it", async () => {
    const { turn, pool, sources, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 2;
    const unpublish = pool.poolUnpublish;
    let failures = 1;
    pool.poolUnpublish = async (view, entry, signal) => { if (failures-- > 0) throw new Error("manager reply lost"); return unpublish(view, entry, signal); };
    await expect(sources.bindable(telemachus.id), "REFERENCE_TOOLS_FAILED_SUSPENSION_FAILS_CLOSED").rejects.toMatchObject({ code: "unavailable" });
    expect(publicEntries(await sources.bindable(telemachus.id)), "REFERENCE_TOOLS_FAILED_SUSPENSION_RETRIED").toEqual([]);
  });

  test("a restoration the pool did not confirm is taken out again by the next bind", async () => {
    const { turn, pool, sources, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    await turn(telemachus.id);
    const publish = pool.poolPublish;
    let failures = 1;
    pool.poolPublish = async (id, view, entry, signal) => { const record = await publish(id, view, entry, signal); if (failures-- > 0) throw new Error("publication reply lost"); return record; };
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })).rejects.toThrow();
    clock += 301_000;
    state.failResolves = 1;
    expect(publicEntries(await sources.bindable(telemachus.id)), "REFERENCE_TOOLS_FAILED_RESTORE_RESETTLED").toEqual([]);
  });

  test("a failed publication never exposes a suspended previous root again", async () => {
    const { turn, pool, tools, tips, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    const name = nameOf(await first.call(source(PUBLIC)));
    const previous = readlinkSync(join(first.views!.public, name));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    const later = await turn(telemachus.id);
    expect(publicEntries(later.views)).toEqual([]);
    tips.set(PUBLIC, "3".repeat(40));
    const publish = pool.poolPublish;
    pool.poolPublish = async (id, view, entry, signal) => { if (id !== previous) { await publish(id, view, entry, signal); throw new Error("publication reply lost"); } return publish(id, view, entry, signal); };
    expect((await later.call(source(PUBLIC))).ok).toBe(false);
    expect((publicEntries(later.views) ?? []).filter(entry => entry === name || entry === previous), "REFERENCE_TOOLS_ROLLBACK_KEEPS_LAPSED_HIDDEN").toEqual([]);
  });

  test("a first publication whose reply was lost and whose staging was not released leaves no orphan in a bound view", async () => {
    const { turn, pool, sources } = host();
    const penelope = principal();
    const publish = pool.poolPublish, release = pool.poolRelease;
    pool.poolPublish = async (id, view, entry, signal) => { await publish(id, view, entry, signal); throw new Error("publication reply lost"); };
    pool.poolRelease = async () => { throw new Error("manager busy"); };
    await expect(sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" })).rejects.toThrow();
    pool.poolPublish = publish; pool.poolRelease = release;
    const next = await turn(penelope.id);
    expect(publicEntries(next.views), "REFERENCE_TOOLS_ORPHAN_ROOT_HIDDEN").toEqual([]);
  });

  test("a bind waits for a first publication in progress", async () => {
    const { pool, sources } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    await sources.bindable(telemachus.id);
    const publish = pool.poolPublish;
    let open!: () => void, paused = false;
    const gate = new Promise<void>(resolve => { open = resolve; });
    pool.poolPublish = async (...args) => { if (!paused) { paused = true; await gate; } return publish(...args); };
    const acquiring = sources.request({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    while (!paused) await Bun.sleep(1);
    let bound = false;
    const binding = sources.bindable(telemachus.id).then(views => { bound = true; return views; });
    await Bun.sleep(20);
    expect(bound, "REFERENCE_TOOLS_BIND_WAITS_FOR_INITIAL_PUBLICATION").toBe(false);
    open();
    const held = await acquiring;
    expect(publicEntries(await binding) ?? []).toContain(held.name);
    held.release();
  });

  test("a refresh takes the superseded root out of the view at once, while its reader keeps the source", async () => {
    const { turn, pool, tips } = host();
    const penelope = principal();
    const reading = await turn(penelope.id);
    const name = nameOf(await reading.call(source(PUBLIC)));
    const before = readlinkSync(join(reading.views!.public, name));
    clock += 61_000;
    tips.set(PUBLIC, "3".repeat(40));
    ok(await reading.call(source(PUBLIC)));
    const after = readlinkSync(join(reading.views!.public, name));
    expect({ moved: after !== before, superseded: (publicEntries(reading.views) ?? []).includes(before), retained: pool.records.get(before)?.state }, "REFERENCE_TOOLS_SUPERSEDED_ROOT_NOT_IN_VIEW")
      .toEqual({ moved: true, superseded: false, retained: "sealed" });
  });

  test("a revocation that lands during a restoration still withdraws the source", async () => {
    const { turn, pool, sources, tools, worktrees, state } = host();
    const penelope = principal();
    const issued = grant(penelope.id);
    const first = await turn(penelope.id);
    const name = nameOf(await first.call(source(PRIVATE)));
    // A worktree keeps the source root after revocation, so only its exposure shows whether the withdrawal won.
    await worktrees.allocate({ principalId: penelope.id, repository: PRIVATE, revision: "main" });
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    await turn(penelope.id);
    expect(readdirSync(first.views!.private)).not.toContain(name);
    const publish = pool.poolPublish;
    let open!: () => void, paused = false;
    const gate = new Promise<void>(resolve => { open = resolve; });
    pool.poolPublish = async (...args) => { if (!paused) { paused = true; await gate; } return publish(...args); };
    const restoring = sources.request({ principalId: penelope.id, repository: PRIVATE, revision: "main" });
    while (!paused) await Bun.sleep(1);
    revokeReferenceGrant(db, { brain: BRAIN, principalId: penelope.id, id: issued.id, now: Date.now() });
    const revoking = sources.revoke({ grantIds: [issued.id], principalIds: [] });
    await Bun.sleep(5);
    open();
    await Promise.allSettled([restoring, revoking]);
    (await restoring.catch(() => null))?.release();
    expect(readdirSync(first.views!.private), "REFERENCE_TOOLS_REVOCATION_WINS_OVER_RESTORE").toEqual([]);
  });

  test("after recovery republishes everything, the next bind judges each source again", async () => {
    const { turn, sources, tools, state } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    const name = nameOf(await first.call(source(PUBLIC)));
    tools.end(first.turnId);
    clock += 301_000;
    state.failResolves = 1;
    const withheld = await turn(telemachus.id);
    expect(publicEntries(withheld.views)).toEqual([]);
    await sources.recover();
    expect(publicEntries(withheld.views) ?? [], "REFERENCE_TOOLS_RECOVERY_REPUBLISHES").toContain(name);
    state.failResolves = 1;
    expect(publicEntries((await turn(telemachus.id)).views), "REFERENCE_TOOLS_RECOVERY_THEN_BIND_SUSPENDS").toEqual([]);
  });
});

describe("turn boundaries", () => {
  test("a call that finishes after its turn ended reports no path and keeps no reader", async () => {
    const { turn, tools, state, released } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    let open!: () => void;
    state.gate = new Promise(resolve => { open = resolve; });
    const pending = current.call(source(PUBLIC));
    while (state.resolves === 0) await Bun.sleep(1);
    tools.end(current.turnId);
    open();
    expect(await pending, "REFERENCE_TOOLS_LATE_RESULT_FENCED").toMatchObject({ ok: false, code: "cancelled" });
    expect(released, "REFERENCE_TOOLS_LATE_LEASE_RELEASED").toHaveLength(1);
  });

  test("a worktree renewal whose turn ended while it was queued changes nothing", async () => {
    const { turn, tools, worktrees } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    const id = ok<Extract<ReferenceToolResult, { worktree: unknown }>>(await current.call(worktree({ action: "request", repository: PUBLIC, revision: "main" }))).worktree.id;
    const before = worktrees.list(penelope.id)[0]!.accessedAt;
    clock += 1000;
    const pending = current.call(worktree({ action: "renew", worktreeId: id }));
    tools.end(current.turnId);
    expect(await pending, "REFERENCE_TOOLS_ENDED_TURN_RENEW_FENCED").toMatchObject({ ok: false, code: "unavailable" });
    expect(worktrees.list(penelope.id)[0]!.accessedAt).toBe(before);
  });

  test("a turn at its reader limit is refused another source instead of dropping an earlier reader", async () => {
    const { turn, released, tools } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    for (let index = 0; index < 32; index++) ok(await current.call(source(`${PUBLIC}-${index}`)));
    expect(await current.call(source(`${PUBLIC}-32`)), "REFERENCE_TOOLS_READER_LIMIT_REFUSES").toMatchObject({ ok: false, code: "busy" });
    // Only the refused 33rd reader was released; every admitted reader is still held.
    expect(released, "REFERENCE_TOOLS_READER_LIMIT_KEEPS_EARLIER_READERS").toEqual([released[0]!]);
    expect(released[0], "REFERENCE_TOOLS_READER_LIMIT_RELEASES_THE_REFUSED").toContain("ithaca-32");
    tools.end(current.turnId);
    expect(released, "REFERENCE_TOOLS_END_RELEASES_EVERY_READER").toHaveLength(33);
  });

  test("a refusal names no host path even when the views could not be prepared", async () => {
    const { pool, sources, worktrees } = host();
    const penelope = principal();
    const create = pool.poolCreate;
    pool.poolCreate = async (id, purpose, from, allowance, signal) => {
      if (purpose === "worktree") throw new Error(`refused at ${join(root, "pool", "roots", id)}`);
      return create(id, purpose, from, allowance, signal);
    };
    const tools = createReferenceTools({ sources: { ...sources, async bindable() { throw new Error("views unavailable"); } }, worktrees });
    const turnId = crypto.randomUUID();
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId, profile: "governed" });
    expect(await tools.begin(turnId, { principalId: penelope.id, posture: "interactive", generation })).toBeNull();
    const refused = await tools.call(turnId, penelope.id, worktree({ action: "request", repository: PUBLIC, revision: "main" }));
    expect(refused, "REFERENCE_TOOLS_REFUSAL_HIDES_HOST_PATH").toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(refused), "REFERENCE_TOOLS_REFUSAL_NAMES_NO_HOST_PATH").not.toContain(root);
    // Every shape a service error could carry a host path in.
    for (const leak of ["fatal:/pool/roots/ithaca", "../../pool/roots/ithaca", "file:///pool/roots/ithaca", "'/pool/with spaces/roots/ithaca'", "C:\\pool\\roots"]) {
      const failing = createReferenceTools({ sources: { ...sources, async bindable() { throw new Error("views unavailable"); } },
        worktrees: { ...worktrees, async renew() { throw new ReferenceWorktreeError("unavailable", `renewal failed at ${leak}`); } } });
      const id = crypto.randomUUID();
      await failing.begin(id, { principalId: penelope.id, posture: "interactive", generation: null });
      const result = await failing.call(id, penelope.id, worktree({ action: "renew", worktreeId: "raft" }));
      expect(JSON.stringify(result), `REFERENCE_TOOLS_REFUSAL_NO_PATH_SHAPE ${leak}`).not.toMatch(/pool[/\\]/);
    }
  });
});

describe("managed worktrees", () => {
  test("request, renew, list and release run under the turn's principal and generation", async () => {
    const { turn, pool } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    const requested = ok<Extract<ReferenceToolResult, { worktree: unknown }>>(await current.call(worktree({ action: "request", repository: PUBLIC, revision: "main" })));
    const id = requested.worktree.id;
    expect(requested.worktree, "REFERENCE_TOOLS_WORKTREE_GRANTED_TO_TURN").toMatchObject({ startingCommit: "1".repeat(40), state: "active",
      path: `/tmp/brain-worktrees/${id}`, domain: "public" });
    expect(pool.records.get(id)!.access, "REFERENCE_TOOLS_WORKTREE_IN_TURN_GENERATION").toBe(current.generation!.id);
    clock += DAY * 1000;
    const renewed = ok<Extract<ReferenceToolResult, { worktree: unknown }>>(await current.call(worktree({ action: "renew", worktreeId: id })));
    expect(Date.parse(renewed.worktree.lastActivityAt), "REFERENCE_TOOLS_RENEW_MOVES_CLOCK").toBe(clock);
    const listed = ok<Extract<ReferenceToolResult, { worktrees: unknown }>>(await current.call(worktree({ action: "list" })));
    expect(listed.worktrees.map(item => item.id)).toEqual([id]);
    // Another turn of the same principal sees the worktree, but its workers cannot reach it.
    const elsewhere = await turn(penelope.id);
    expect(ok<Extract<ReferenceToolResult, { worktrees: unknown }>>(await elsewhere.call(worktree({ action: "list" }))).worktrees[0]!.path,
      "REFERENCE_TOOLS_PATH_NEEDS_THIS_GENERATION").toBeNull();
    expect(await elsewhere.call(worktree({ action: "access", worktreeId: id })), "REFERENCE_TOOLS_HELD_ELSEWHERE_BUSY").toMatchObject({ ok: false, code: "busy" });
    const released = ok<Extract<ReferenceToolResult, { worktree: unknown }>>(await current.call(worktree({ action: "release", worktreeId: id })));
    expect(released.worktree, "REFERENCE_TOOLS_RELEASED_HAS_NO_PATH").toMatchObject({ state: "released", path: null });
    expect(await current.call(worktree({ action: "access", worktreeId: id })), "REFERENCE_TOOLS_RELEASE_IS_FINAL").toMatchObject({ ok: false, code: "released" });
  });

  test("another principal's worktree identity grants nothing", async () => {
    const { turn } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const mine = await turn(penelope.id);
    const id = ok<Extract<ReferenceToolResult, { worktree: unknown }>>(await mine.call(worktree({ action: "request", repository: PUBLIC, revision: "main" }))).worktree.id;
    const theirs = await turn(telemachus.id);
    for (const action of ["access", "renew", "release"] as const)
      expect(await theirs.call(worktree({ action, worktreeId: id })), `REFERENCE_TOOLS_WRONG_PRINCIPAL_${action.toUpperCase()}`).toMatchObject({ ok: false, code: "missing" });
    expect(ok<Extract<ReferenceToolResult, { worktrees: unknown }>>(await theirs.call(worktree({ action: "list" }))).worktrees).toEqual([]);
  });

  test("a turn without a worker generation allocates nothing", async () => {
    const { turn, worktrees } = host();
    const penelope = principal();
    const current = await turn(penelope.id, { generation: false });
    expect(await current.call(worktree({ action: "request", repository: PUBLIC, revision: "main" })), "REFERENCE_TOOLS_NO_GENERATION_REFUSES")
      .toMatchObject({ ok: false, code: "unavailable" });
    expect(worktrees.list(penelope.id), "REFERENCE_TOOLS_NO_GENERATION_NO_ALLOCATION").toEqual([]);
  });

  test("a voice turn reads and lists, and changes no worktree", async () => {
    const { turn } = host();
    const penelope = principal();
    const current = await turn(penelope.id, { posture: "voice" });
    ok(await current.call(source(PUBLIC)));
    ok(await current.call(worktree({ action: "list" })));
    expect(await current.call(worktree({ action: "request", repository: PUBLIC, revision: "main" })), "REFERENCE_TOOLS_VOICE_NO_WORKTREE_CHANGE")
      .toMatchObject({ ok: false, code: "unavailable" });
  });

  test("model-supplied identities and paths are refused before the host acts", async () => {
    const { turn, worktrees } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    for (const input of [{ action: "request", repository: PUBLIC, revision: "main", principalId: penelope.id }, { action: "access", worktreeId: "x", generation: "g" },
      { action: "renew" }, { action: "list", path: "/tmp/brain-worktrees" }])
      expect(await current.call(worktree(input)), "REFERENCE_TOOLS_STRICT_INPUT").toMatchObject({ ok: false, code: "invalid" });
    expect(worktrees.list(penelope.id)).toEqual([]);
  });
});
