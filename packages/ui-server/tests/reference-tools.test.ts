import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createReferenceWorktrees, referenceWorktreeDependents } from "../src/brain/reference-worktrees";
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
  const state = { failFetch: false, resolves: 0, gate: null as Promise<void> | null };
  const transport: ReferenceTransport = {
    async resolve({ repository, token }) {
      state.resolves++;
      await state.gate;
      const tip = tips.get(repository.canonical) ?? (repository.canonical.startsWith(`${PUBLIC}-`) ? "4".repeat(40) : undefined);
      if (!tip || (repository.canonical === PRIVATE && token !== TOKEN)) return { ok: false, reason: "denied", detail: "fatal: repository not found" };
      return { ok: true, commit: tip, ref: "refs/heads/main" };
    },
    async fetch({ repository, root: target }) {
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
    expect(stale.source.error).toContain("fetch failed");
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

describe("binding a view is a new mount", () => {
  test("a source whose validation lapsed with no reader leaves the view before a worker binds it, and returns once validated", async () => {
    const { turn, tools, state, views } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const first = await turn(penelope.id);
    const name = ok<Extract<ReferenceToolResult, { source: unknown }>>(await first.call(source(PUBLIC))).source.path!.split("/").at(-1)!;
    tools.end(first.turnId);
    clock += 301_000;
    const next = await turn(telemachus.id);
    // Neither the name nor the root's identity stays in the view a new worker binds.
    expect(views(), "REFERENCE_TOOLS_LAPSED_SOURCE_NOT_BOUND").toEqual([]);
    const checks = state.resolves;
    const again = ok<Extract<ReferenceToolResult, { source: unknown }>>(await next.call(source(PUBLIC)));
    expect({ checked: state.resolves > checks, path: again.source.path?.endsWith(name) }, "REFERENCE_TOOLS_REVALIDATED_SOURCE_REPUBLISHED").toEqual({ checked: true, path: true });
    expect(views()).toContain(name);
  });

  test("a running turn's source stays while another turn binds after its validation lapsed", async () => {
    const { turn, views } = host();
    const penelope = principal(), telemachus = principal("Telemachus");
    const reading = await turn(penelope.id);
    const name = ok<Extract<ReferenceToolResult, { source: unknown }>>(await reading.call(source(PUBLIC))).source.path!.split("/").at(-1)!;
    clock += 301_000;
    await turn(telemachus.id);
    expect(views(), "REFERENCE_TOOLS_RUNNING_READER_KEEPS_SOURCE").toContain(name);
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

  test("a turn at its reader limit is refused another source instead of dropping an earlier reader", async () => {
    const { turn, released } = host();
    const penelope = principal();
    const current = await turn(penelope.id);
    for (let index = 0; index < 32; index++) ok(await current.call(source(`${PUBLIC}-${index}`)));
    expect(await current.call(source(`${PUBLIC}-32`)), "REFERENCE_TOOLS_READER_LIMIT_REFUSES").toMatchObject({ ok: false, code: "busy" });
    expect(released, "REFERENCE_TOOLS_READER_LIMIT_KEEPS_EARLIER_READERS").toHaveLength(1);
    ok(await current.call(source(`${PUBLIC}-0`)));
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
