/**
 * Every package that reads the content index, against ONE index the real
 * `brain` CLI produced, through the consumers' actual registrations (#700).
 *
 * The consumers are the ones the index-query decision inventories
 * (docs/decisions/index-query-api.md): the five mounted graph routes and the
 * voice keyterms route of `createApp` (behind a valid owner session, so the
 * auth guard never answers for them), the registered pi `brain_list` and
 * `brain_graph` tools, and the jobs module's hygiene check loaded through the
 * real module loader. Each is driven through the same index states, and each
 * must answer with its own documented envelope — never an empty success.
 *
 * What this file proves is the SUPPORTED behaviour: core's query results and
 * the consumers' mappings of them. It reads no column and asserts no table.
 * The direct-SQL promise (`docs/integration-contract/frontmatter.md#braindb-direct-sql-reads`)
 * still binds until #701, and its internal schema checks stay where they are,
 * labelled as such, in `tests/brain-db-contract.test.ts`. Here SQL appears
 * only to stage an index state on a disposable copy of the CLI's output.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateSignedCookie } from "hono/cookie";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SCHEMA_VERSION } from "@schlessera/brain";
import * as queries from "@schlessera/brain/queries";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { auditWithModules } from "../packages/core/src/lib/auditor";
import { initContext, setContext, type BrainContext } from "../packages/core/src/lib/context";
import type { AuditIssue } from "../packages/core/src/lib/types";
import { runCli } from "../packages/core/tests/cli-harness";
import { createBrainAccess } from "../packages/ui-backend-pi/src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../packages/ui-backend-pi/src/tools";
import { createTurnContext } from "../packages/ui-backend-pi/src/turn-context";
import { setCoreModuleLoaderForTesting } from "../packages/ui-server/src/core-queries";
import { createPrincipal } from "../packages/ui-server/src/db/principals";
import { httpContractApp, type HttpContractApp } from "../packages/ui-server/tests/helpers/http-contract-app";

const REPO = resolve(import.meta.dir, "..");
const NOW = "2026-07-12";
const CENTER = "notes/odysseus.md";
const SECRET = "index-query-consumers-secret-0123456789";
const AUTH_ENV = { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" };
const GRAPH = {
  meta: "/api/graph/meta",
  clusters: "/api/graph/clusters?isolates=1",
  neighborhood: `/api/graph/neighborhood?center=${CENTER}`,
  discovery: "/api/graph/discovery",
  maintenance: "/api/graph/maintenance?staleDays=180",
} as const;
type Route = keyof typeof GRAPH;
const ROUTES = Object.keys(GRAPH) as Route[];
const KEYTERMS = "/api/voice/keyterms?rebuild=1";

const temporary: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

const note = (title: string, body: string, updated = NOW, tags = "Ithaca, voyage") =>
  `---\ntitle: ${title}\ntype: note\nstatus: active\nrelevance: primary\ncreated: 2026-07-01\nupdated: ${updated}\nsummary: ${title} on the way home\ntags: [${tags}]\n---\n# ${title}\n${body}\n`;
const opportunity = (title: string, status: string, stage?: string) =>
  `---\ntype: opportunity\ntitle: "${title}"\ncreated: 2026-07-01\nupdated: ${NOW}\nstatus: ${status}\nrelevance: primary\n${stage ? `stage: ${stage}\n` : ""}---\n\n## Overview\n`;

/** The voyage: graph edges, a virtual root, an unresolved link, vocabulary and hygiene candidates. */
const VOYAGE: Record<string, string> = {
  "AGENTS.md": "# Voyage entry\n\nStart with [[odysseus]].\n",
  [CENTER]: note("Odysseus", "Sails for [[ithaca]] past [[Scylla Strait]], back to [[odysseus]], home to [[penelope]].\n**Ithaca Harbour** keeps the MCP log. MCP keeps the bearings."),
  "notes/ithaca.md": note("Ithaca", "Home of [[penelope]]. [[odysseus]] returns."),
  "notes/penelope.md": note("Penelope", "Weaves and unweaves; waits for [[odysseus]].", "2025-01-01"),
  "notes/calypso.md": note("Calypso", "An island with no links out.", NOW, "Ogygia"),
  "criteria.md": "# Criteria\n\nA berth on a ship bound for Ithaca.\n",
  "career/aeolus/status.md": opportunity("Aeolus — Wind Logistics", "active"),
  "career/circe/STATUS.md": opportunity("Circe — Island Operations", "active"),
  "career/ithaca/status.md": opportunity("Ithaca — Steward", "active", "applied"),
  "career/cyclops/status.md": opportunity("Cyclops — Shepherd", "archived"),
  "career/sirens/notstatus.md": opportunity("Sirens — Outreach", "active"),
};
/** A later voyage: the same repo, re-indexed after Telemachus joined it. */
const LATER: Record<string, string> = {
  "notes/telemachus.md": note("Telemachus", "Searches for [[odysseus]]. **Telemachus Rowing** drills."),
  "career/telemachus/status.md": opportunity("Telemachus — Search Coordinator", "active"),
};
const FLAGGED = ["career/aeolus/status.md", "career/circe/STATUS.md"];

function writeBrain(dir: string, files: Record<string, string>): void {
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "brain.config.json"), JSON.stringify({
    profile: { name: "Odysseus" },
    modules: { "@schlessera/brain-module-jobs": { criteria: "criteria.md" } },
  }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

async function cliIndexed(files: Record<string, string>): Promise<string> {
  const dir = tempDir("index-query-consumers-");
  writeBrain(dir, files);
  const indexed = await runCli(dir, ["index", "--force", "--json"]);
  expect(indexed.code, indexed.stderr).toBe(0);
  expect(JSON.parse(indexed.stdout).total).toBeGreaterThan(0);
  checkpoint(join(dir, "brain.db"));
  return dir;
}

/** A successful supported result's value; a failure fails the test with its code. */
function value<T>(result: queries.QueryResult<T>): T {
  if (!result.ok) throw new Error(`supported query failed: ${result.error.code}`);
  return result.value;
}

function checkpoint(file: string): void {
  const db = new Database(file);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(true); }
}

function edit(file: string, sql: string): void {
  const db = new Database(file);
  try { db.exec(sql); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(true); }
}

/** The voyage's CLI index (A) and the later voyage's (B), each indexed once. */
let voyage: string;
let later: string;
let brain: BrainContext;
/** What every consumer answers for an unmodified copy of A; each state compares against it. */
let baseline: Observed;

// File-level, so a single test selected with `-t` still has its index and baseline.
beforeAll(async () => {
  voyage = await cliIndexed(VOYAGE);
  later = await cliIndexed({ ...VOYAGE, ...LATER });
  brain = await initContext({ root: voyage });
  baseline = await observeAll(repo());
});

afterEach(() => setCoreModuleLoaderForTesting(null));
afterAll(() => {
  setContext(null);
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A fresh brain repo — sources included — carrying a copy of index A (or none). */
function repo(index: string | null = join(voyage, "brain.db"), files = VOYAGE): string {
  const dir = tempDir("index-query-consumers-case-");
  writeBrain(dir, files);
  if (index) copyFileSync(index, join(dir, "brain.db"));
  return dir;
}

// --- the three consumers, through their real registrations -------------------

interface Ui extends HttpContractApp {
  get(path: string): Promise<{ status: number; body: unknown }>;
  cacheFile: string;
}

/** `createApp` serving `dir`'s index, with a valid owner session on every request. */
async function ui(dir: string): Promise<Ui> {
  const t = await httpContractApp({ env: AUTH_ENV });
  rmSync(t.brainPath, { recursive: true, force: true });
  symlinkSync(dir, t.brainPath);
  const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", owner.id, SECRET)).split(";")[0]!;
  return Object.assign(t, {
    async get(path: string) {
      const response = await t.fetch(path, { headers: { cookie, origin: "http://localhost", host: "localhost" } });
      // An earlier layer must never be what answers: not the auth guard, not a missing mount.
      expect([401, 403], `${path} was answered before its handler`).not.toContain(response.status);
      // Not parsed blindly: an unmounted route's fallback must fail on its status, not on parsing.
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* reported as text */ }
      return { status: response.status, body };
    },
    cacheFile: join(t.app.config.voice.cacheDir, "keyterms.json"),
  });
}

type Tool = "brain_list" | "brain_graph";
/** pi's registered tools; a rejection is reported by its message, a success by its value. */
async function pi(dir: string, name: Tool, args: Record<string, unknown> = name === "brain_graph" ? { path: CENTER } : {}): Promise<{ value?: unknown; error?: string }> {
  const tool = createBrainTools({ brain: createBrainAccess(dir), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) })
    .find((t) => t.name === name) as ToolDefinition | undefined;
  expect(tool, `${name} is not registered`).toBeDefined();
  try {
    const result = await tool!.execute("consumers", args as never, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** The jobs hygiene check, loaded through the real loader, auditing `dir`. */
async function hygiene(dir: string): Promise<{ flagged: string[]; failed: string[]; messages: string[] }> {
  const failed: string[] = [];
  // The core audit's own (internal) database read stays on the source repo;
  // only the module's root-bound queries are pointed at the case.
  const db = new Database(join(voyage, "brain.db"), { readonly: true });
  let issues: AuditIssue[];
  try {
    issues = await auditWithModules(db, { ...brain, root: dir }, { onCheckFailed: (name) => failed.push(name) });
  } finally {
    db.close();
  }
  return {
    flagged: issues.filter((i) => i.category === "jobs-stage").map((i) => i.path),
    failed,
    messages: issues.filter((i) => i.category === "module-hygiene").map((i) => i.message),
  };
}

/** Everything every consumer answers for `dir`. */
async function observeAll(dir: string, prepare?: (dir: string) => (() => void) | void) {
  const app = await ui(dir);
  const release = prepare?.(dir);
  try {
    const routes = {} as Record<Route, { status: number; body: unknown }>;
    for (const route of ROUTES) routes[route] = await app.get(GRAPH[route]);
    const keyterms = await app.get(KEYTERMS);
    const cached = existsSync(app.cacheFile);
    return {
      routes, keyterms, cached,
      list: await pi(dir, "brain_list"),
      graph: await pi(dir, "brain_graph"),
      hygiene: await hygiene(dir),
    };
  } finally {
    release?.();
    await app.close();
  }
}
type Observed = Awaited<ReturnType<typeof observeAll>>;

const UNAVAILABLE_META = { status: 200, body: { available: false, reason: "schema", schemaVersion: 0, computedAt: null, stale: false, nodeCount: 0, edgeCount: 0, communities: [], defaultRoot: null } };
const REFUSED = (reason: string) => ({ status: 503, body: { error: "graph_unavailable", reason } });
const BUSY = { status: 503, body: { error: "index_busy" } };
const PI_ERROR: Record<string, string> = {
  missing_index: "Brain database not found — run `brain index` first.",
  incompatible_index: "Brain index is incompatible — rebuild it with `brain index --force`.",
  corrupt_index: "Brain index is corrupt — rebuild it with `brain index --force`.",
  busy_index: "Brain index is busy — try again.",
  unavailable_index: "Brain index is unavailable.",
};
const JOBS_ACTION: Record<string, string> = {
  missing_index: "run `brain index`",
  incompatible_index: "run `brain index --force`",
  corrupt_index: "run `brain index --force`",
  busy_index: "retry",
  unavailable_index: "check the index",
};
const jobsFailure = (code: string) => ({
  flagged: [], failed: ["jobs"],
  messages: [`hygiene check from module "jobs" failed: opportunity stages could not read the content index (${code}): ${JOBS_ACTION[code]}`],
});

// --- the index ---------------------------------------------------------------

describe("one CLI-produced index serves every consumer", () => {

  test("the index carries what the consumers are tested on", () => {
    const meta = value(queries.readGraphMeta({ brainPath: voyage }));
    expect(meta.available).toBe(true);
    expect(meta.edgeCount).toBeGreaterThan(4);
    expect(meta.communities.length).toBeGreaterThan(0);
    expect(meta.defaultRoot).toEqual({ path: "AGENTS.md", virtual: true });
    const maintenance = value(queries.readGraphMaintenance({ brainPath: voyage, now: `${NOW}T00:00:00Z` }));
    expect(maintenance.brokenLinks).toContainEqual({ sourcePath: CENTER, target: "Scylla Strait" });
    expect(maintenance.orphans.map((n) => n.path)).toContain("notes/calypso.md");
    expect(maintenance.unreachable.length).toBeGreaterThan(0);
    expect(value(queries.readVoiceVocabulary({ brainPath: voyage, limit: 200 })).terms).toContain("Ithaca Harbour");
    expect(value(queries.findIndexDocuments({ brainPath: voyage, type: "opportunity" })).map((c) => c.path)).toEqual([
      "career/aeolus/status.md", "career/circe/STATUS.md", "career/cyclops/status.md", "career/ithaca/status.md", "career/sirens/notstatus.md",
    ]);
  });

  test("each mounted graph route serves core's populated result", () => {
    const expected: Record<Route, unknown> = {
      meta: value(queries.readGraphMeta({ brainPath: voyage })),
      clusters: value(queries.readGraphClusters({ brainPath: voyage, includeIsolates: true })),
      neighborhood: value(queries.readGraphNeighborhood({ brainPath: voyage, center: CENTER, depth: 1, direction: "both" })),
      discovery: value(queries.readGraphDiscovery({ brainPath: voyage, direction: "out", maxDepth: 8 })),
      maintenance: value(queries.readGraphMaintenance({ brainPath: voyage, staleDays: 180 })),
    };
    for (const route of ROUTES) expect(baseline.routes[route], route).toEqual({ status: 200, body: expected[route] });
    const body = baseline.routes;
    expect((body.clusters.body as queries.Subgraph).nodes.length).toBeGreaterThan(3);
    expect((body.clusters.body as queries.Subgraph).edges.length).toBeGreaterThan(3);
    expect((body.neighborhood.body as queries.Subgraph).edges.length).toBeGreaterThan(1);
    expect((body.discovery.body as queries.Subgraph).nodes[0]).toMatchObject({ id: 0, virtual: true, path: "AGENTS.md" });
    expect((body.discovery.body as queries.Subgraph).reachableCount).toBeGreaterThan(1);
    expect((body.maintenance.body as queries.Maintenance).stale.map((n) => n.path)).toContain("notes/penelope.md");
  });

  test("voice serves and caches core's populated vocabulary", () => {
    expect(baseline.keyterms.status).toBe(200);
    const terms = (baseline.keyterms.body as { keyterms: string[] }).keyterms;
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toContain("Ithaca Harbour");
    expect(terms).toEqual(value(queries.readVoiceVocabulary({ brainPath: voyage, limit: terms.length })).terms);
    expect(baseline.cached).toBe(true);
  });

  test("pi's tools list and walk the same index", () => {
    const documents = (baseline.list.value as { documents: queries.ListedDocument[] }).documents;
    expect(documents.length).toBeGreaterThan(3);
    expect(documents).toEqual(value(queries.listIndexDocuments({ brainPath: voyage })));
    const walk = baseline.graph.value as queries.LinkWalk;
    expect(walk.edges).toContainEqual({ source: CENTER, target: "Scylla Strait", resolved: false });
    expect(walk.edges).toContainEqual({ source: CENTER, target: CENTER, resolved: true });
    expect(walk).toEqual(value(queries.readLinkWalk({ brainPath: voyage, path: CENTER })));
  });

  test("the jobs hygiene check selects the complete stage-less candidate set", () => {
    expect(baseline.hygiene).toEqual({ flagged: FLAGGED, failed: [], messages: [] });
  });
});

// --- index states ------------------------------------------------------------

/** How a state changes what each consumer answers, relative to the baseline. */
interface State {
  name: string;
  /** Stage the state on the case repo; a returned function releases it. */
  prepare(dir: string): (() => void) | void;
  routes?: Partial<Record<Route, { status: number; body: unknown } | ((body: unknown) => void)>>;
  /** Omitted = unchanged from the baseline; otherwise the keyterms response and whether it is cached. */
  keyterms?: { status: number; body: unknown; cached: boolean } | ((r: { status: number; body: unknown }) => void);
  list?: string;
  graph?: string;
  hygiene?: string;
}

const db = (dir: string) => join(dir, "brain.db");
const failingAll = (code: string): Pick<State, "list" | "graph" | "hygiene"> => ({ list: code, graph: code, hygiene: code });
const allRefused = (reason: string) => ({ meta: UNAVAILABLE_META, clusters: REFUSED(reason), neighborhood: REFUSED(reason), discovery: REFUSED(reason), maintenance: REFUSED(reason) });
const DEGRADED_VOICE = { status: 200, body: expect.objectContaining({ keyterms: [], count: 0 }), cached: false };

const STATES: State[] = [
  {
    name: "a missing index",
    prepare: (dir) => { rmSync(db(dir)); },
    routes: allRefused("schema"),
    keyterms: (r) => {
      expect(r.status).toBe(500);
      expect((r.body as { error: string }).error).toStartWith("brain.db not found at ");
    },
    ...failingAll("missing_index"),
  },
  {
    name: "an incompatible older index (schema 2)",
    prepare: (dir) => edit(db(dir), "UPDATE index_metadata SET value = '2' WHERE key = 'schema_version'"),
    routes: allRefused("schema"),
    keyterms: DEGRADED_VOICE,
    ...failingAll("incompatible_index"),
  },
  {
    name: "an unknown newer index",
    prepare: (dir) => edit(db(dir), `UPDATE index_metadata SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`),
    routes: allRefused("schema"),
    keyterms: DEGRADED_VOICE,
    ...failingAll("incompatible_index"),
  },
  {
    name: "a compatible older index without the graph layout (schema 7)",
    prepare: (dir) => edit(db(dir), "UPDATE index_metadata SET value = '7' WHERE key = 'schema_version'; DROP TABLE graph_metrics; DROP TABLE graph_layouts; DROP TABLE graph_communities; DROP TABLE graph_root_distances"),
    routes: {
      meta: (body) => {
        expect(body).toMatchObject({ available: false, reason: "schema", schemaVersion: 7, communities: [], defaultRoot: null });
        expect((body as queries.GraphMeta).nodeCount).toBeGreaterThan(3);
      },
      // The raw neighborhood stays readable; the derived modes need the layout.
      neighborhood: (body) => {
        const hood = body as queries.Subgraph;
        expect(hood.edges.length).toBeGreaterThan(1);
        expect(hood.nodes.every((n) => n.pagerank === undefined)).toBe(true);
      },
      clusters: REFUSED("schema"), discovery: REFUSED("schema"), maintenance: REFUSED("schema"),
    },
  },
  {
    name: "a forged current version missing the graph layout",
    prepare: (dir) => edit(db(dir), "DROP TABLE graph_layouts"),
    routes: allRefused("schema"),
  },
  {
    name: "a current version missing a column the listing and selection need",
    prepare: (dir) => {
      const file = db(dir);
      const handle = new Database(file);
      try {
        for (const { name } of handle.query<{ name: string }, []>("SELECT name FROM pragma_index_list('documents') WHERE origin = 'c'").all()) {
          const columns = handle.query<{ name: string }, []>(`SELECT name FROM pragma_index_info('${name}')`).all();
          if (columns.some((c) => c.name === "status")) handle.exec(`DROP INDEX "${name}"`);
        }
      } finally { handle.close(true); }
      edit(file, "ALTER TABLE documents DROP COLUMN status");
    },
    list: "corrupt_index",
    hygiene: "corrupt_index",
  },
  {
    name: "a corrupt file",
    prepare: (dir) => writeFileSync(db(dir), "Odysseus: this logbook is not a SQLite file"),
    routes: allRefused("schema"),
    keyterms: { status: 500, body: { error: "brain.db could not be read for voice vocabulary (corrupt_index)" }, cached: false },
    ...failingAll("corrupt_index"),
  },
  {
    name: "a busy index",
    prepare: (dir) => {
      const writer = new Database(db(dir));
      writer.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      return () => { writer.exec("ROLLBACK"); writer.close(true); };
    },
    routes: { meta: BUSY, clusters: BUSY, neighborhood: BUSY, discovery: BUSY, maintenance: BUSY },
    keyterms: { status: 500, body: { error: "brain.db could not be read for voice vocabulary (busy_index)" }, cached: false },
    ...failingAll("busy_index"),
  },
  {
    name: "an uncomputed graph",
    prepare: (dir) => edit(db(dir), "DELETE FROM index_metadata WHERE key = 'graph_computed_at'"),
    routes: {
      meta: (body) => {
        expect(body).toMatchObject({ available: false, reason: "not_computed" });
        expect((body as queries.GraphMeta).nodeCount).toBeGreaterThan(3);
      },
      neighborhood: (body) => expect((body as queries.Subgraph).edges.length).toBeGreaterThan(1),
      clusters: REFUSED("not_computed"), discovery: REFUSED("not_computed"), maintenance: REFUSED("not_computed"),
    },
  },
  {
    name: "a stale graph",
    prepare: (dir) => edit(db(dir), "UPDATE index_metadata SET value = '2020-01-01T00:00:00Z' WHERE key = 'graph_computed_at'"),
    routes: {
      meta: (body) => {
        expect(body).toMatchObject({ available: true, stale: true, computedAt: "2020-01-01T00:00:00Z" });
        expect((body as queries.GraphMeta).nodeCount).toBeGreaterThan(3);
      },
    },
  },
  {
    name: "an absent default root",
    prepare: (dir) => edit(db(dir), "DELETE FROM index_metadata WHERE key IN ('graph_root', 'graph_root_links')"),
    routes: {
      meta: (body) => expect(body).toMatchObject({ available: true, defaultRoot: null }),
      discovery: (body) => {
        const discovery = body as queries.Subgraph;
        expect(discovery.nodes.length).toBeGreaterThan(0);
        expect(discovery.nodes.some((n) => n.virtual)).toBe(false);
        expect(discovery.reachableCount).toBeUndefined();
      },
      // Without a root nothing is "unreachable"; the other arms are unchanged.
      maintenance: (body) => {
        const before = baseline.routes.maintenance.body as queries.Maintenance;
        expect(before.unreachable.length).toBeGreaterThan(0);
        expect(body).toEqual({ ...before, unreachable: [] });
      },
    },
  },
];

describe("every consumer keeps its documented envelope in each index state", () => {
  for (const state of STATES) {
    test(state.name, async () => {
      const seen = await observeAll(repo(), state.prepare);
      for (const route of ROUTES) {
        const expected = state.routes?.[route];
        if (expected === undefined) expect(seen.routes[route], `${route} (unchanged)`).toEqual(baseline.routes[route]);
        else if (typeof expected === "function") {
          expect(seen.routes[route].status, route).toBe(200);
          expected(seen.routes[route].body);
        } else expect(seen.routes[route], route).toEqual(expected);
      }
      if (state.keyterms === undefined) {
        expect(seen.keyterms.status).toBe(200);
        expect((seen.keyterms.body as { keyterms: unknown }).keyterms).toEqual((baseline.keyterms.body as { keyterms: unknown }).keyterms);
        expect(seen.cached).toBe(true);
      } else if (typeof state.keyterms === "function") {
        state.keyterms(seen.keyterms);
        expect(seen.cached, "a failed vocabulary is never cached").toBe(false);
      } else {
        expect({ status: seen.keyterms.status, body: seen.keyterms.body }).toEqual({ status: state.keyterms.status, body: state.keyterms.body });
        expect(seen.cached, "a degraded or failed vocabulary is never cached").toBe(state.keyterms.cached);
      }
      expect(seen.list).toEqual(state.list ? { error: PI_ERROR[state.list] } : baseline.list);
      expect(seen.graph).toEqual(state.graph ? { error: PI_ERROR[state.graph] } : baseline.graph);
      expect(seen.hygiene).toEqual(state.hygiene ? jobsFailure(state.hygiene) : baseline.hygiene);
    });
  }
});

// --- snapshot, replacement and native lifetime -------------------------------

const nativeQuery = Database.prototype.query;
/** A consumer's content-index connection — not the UI's operational DB, nor the core audit's own read of the source repo. */
const indexConnection = (connection: Database) => connection.filename.endsWith("brain.db") && connection.filename !== join(voyage, "brain.db");
/** Watch every statement a content-index connection prepares while `run` executes. */
async function watch<T>(run: () => Promise<T>, hook: (connection: Database, sql: string) => void): Promise<T> {
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    if (indexConnection(this)) hook(this, sql);
    return nativeQuery.call(this, sql);
  } as typeof nativeQuery);
  try { return await run(); } finally { spy.mockRestore(); }
}

/** A writer that commits, once, after the consumer's read has already pinned its compatibility check. */
function writeBetweenReads(dir: string, change: (writer: Database) => void) {
  const writer = new Database(db(dir));
  writer.exec("PRAGMA journal_mode=WAL");
  const state = { committed: false };
  return {
    state,
    hook: (connection: Database, sql: string) => {
      if (state.committed || connection === writer || sql !== "SELECT MAX(indexed_at) AS newest FROM documents") return;
      state.committed = true;
      writer.transaction(() => change(writer))();
    },
    close: () => writer.close(true),
  };
}

const UNKNOWN_VERSION = (writer: Database) => writer.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION + 1)]);

describe("each response is one snapshot, and the next call reads what is there now", () => {
  test("a graph route keeps one WAL snapshot while a writer commits between its reads", async () => {
    const dir = repo();
    const app = await ui(dir);
    const commit = writeBetweenReads(dir, (writer) => {
      writer.run("DELETE FROM links WHERE target_id IS NULL");
      UNKNOWN_VERSION(writer);
    });
    try {
      const during = await watch(() => app.get(GRAPH.maintenance), commit.hook);
      expect(commit.state.committed).toBe(true);
      expect(during, "compatibility and every maintenance arm come from the pre-commit snapshot").toEqual(baseline.routes.maintenance);
      expect((during.body as queries.Maintenance).brokenLinks.length).toBeGreaterThan(0);
      expect(await app.get(GRAPH.maintenance)).toEqual(REFUSED("schema"));
    } finally {
      commit.close();
      await app.close();
    }
  });

  test("the vocabulary keeps one WAL snapshot while a writer commits between its reads", async () => {
    const dir = repo();
    const app = await ui(dir);
    const commit = writeBetweenReads(dir, (writer) => {
      writer.run("DELETE FROM links");
      writer.run("DELETE FROM tags");
      UNKNOWN_VERSION(writer);
    });
    try {
      const during = await watch(() => app.get(KEYTERMS), commit.hook);
      expect(commit.state.committed).toBe(true);
      expect((during.body as { keyterms: string[] }).keyterms).toEqual((baseline.keyterms.body as { keyterms: string[] }).keyterms);
      expect((await app.get(KEYTERMS)).body).toMatchObject({ keyterms: [], count: 0 });
    } finally {
      commit.close();
      await app.close();
    }
  });

  test("pi's tools keep one WAL snapshot while a writer commits between their reads", async () => {
    for (const name of ["brain_list", "brain_graph"] as const) {
      const dir = repo();
      const commit = writeBetweenReads(dir, (writer) => {
        writer.run("UPDATE documents SET title = 'Changed Ithaca'");
        UNKNOWN_VERSION(writer);
      });
      try {
        const during = await watch(() => pi(dir, name), commit.hook);
        expect(commit.state.committed, name).toBe(true);
        expect(during, name).toEqual(name === "brain_list" ? baseline.list : baseline.graph);
        expect(await pi(dir, name), name).toEqual({ error: PI_ERROR.incompatible_index });
      } finally {
        commit.close();
      }
    }
  });

  test("the hygiene check keeps one WAL snapshot while a writer commits between its reads", async () => {
    const dir = repo();
    const commit = writeBetweenReads(dir, (writer) => {
      writer.run("DELETE FROM documents WHERE path = 'career/aeolus/status.md'");
      UNKNOWN_VERSION(writer);
    });
    try {
      const during = await watch(() => hygiene(dir), commit.hook);
      expect(commit.state.committed).toBe(true);
      expect(during).toEqual(baseline.hygiene);
      expect(await hygiene(dir)).toEqual(jobsFailure("incompatible_index"));
    } finally {
      commit.close();
    }
  });

  test("a checkpointed replacement index is read by every consumer's next call", async () => {
    // The repo already holds the later voyage's sources; only its index is A.
    const dir = repo(join(voyage, "brain.db"), { ...VOYAGE, ...LATER });
    const app = await ui(dir);
    try {
      const before = {
        meta: (await app.get(GRAPH.meta)).body as queries.GraphMeta,
        terms: ((await app.get(KEYTERMS)).body as { keyterms: string[] }).keyterms,
        list: ((await pi(dir, "brain_list")).value as { documents: queries.ListedDocument[] }).documents.map((d) => d.path),
        hygiene: await hygiene(dir),
      };
      expect(before.meta.nodeCount).toBe((baseline.routes.meta.body as queries.GraphMeta).nodeCount);
      expect(before.terms).not.toContain("Telemachus Rowing");
      expect(before.list).not.toContain("notes/telemachus.md");
      expect(before.hygiene.flagged).toEqual(FLAGGED);
      const staging = join(dir, "brain.db.next");
      copyFileSync(join(later, "brain.db"), staging);
      renameSync(staging, db(dir));
      const after = (await app.get(GRAPH.meta)).body as queries.GraphMeta;
      expect(after.nodeCount).toBeGreaterThan(before.meta.nodeCount);
      expect((await app.get(`/api/graph/neighborhood?center=notes/telemachus.md`)).status).toBe(200);
      expect(((await app.get(KEYTERMS)).body as { keyterms: string[] }).keyterms).toContain("Telemachus Rowing");
      expect(((await pi(dir, "brain_list")).value as { documents: queries.ListedDocument[] }).documents.map((d) => d.path)).toContain("notes/telemachus.md");
      expect(((await pi(dir, "brain_graph", { path: "notes/telemachus.md" })).value as queries.LinkWalk).edges).toContainEqual({ source: "notes/telemachus.md", target: CENTER, resolved: true });
      expect((await hygiene(dir)).flagged).toEqual([...FLAGGED, "career/telemachus/status.md"]);
    } finally {
      await app.close();
    }
  });

  test("a native failure mid-read closes the connection, maps to each consumer's error and leaves no stale handle", async () => {
    const dir = repo();
    const app = await ui(dir);
    const connections = new Set<Database>();
    const failMidRead = (connection: Database, sql: string) => {
      connections.add(connection);
      if (sql === "SELECT MAX(indexed_at) AS newest FROM documents") return;
      if (/^\s*SELECT (key, value|name) FROM/.test(sql) || sql.startsWith("PRAGMA")) return;
      throw Object.assign(new Error("private native detail from Ithaca"), { code: "SQLITE_IOERR" });
    };
    try {
      const failed = await watch(async () => ({
        maintenance: await app.get(GRAPH.maintenance),
        keyterms: await app.get(KEYTERMS),
        list: await pi(dir, "brain_list"),
        graph: await pi(dir, "brain_graph"),
        hygiene: await hygiene(dir),
      }), failMidRead);
      expect(failed).toEqual({
        maintenance: { status: 500, body: { error: "internal_error" } },
        keyterms: { status: 500, body: { error: "brain.db could not be read for voice vocabulary (unavailable_index)" } },
        list: { error: PI_ERROR.unavailable_index },
        graph: { error: PI_ERROR.unavailable_index },
        hygiene: jobsFailure("unavailable_index"),
      });
      expect(JSON.stringify(failed)).not.toContain("private native detail");
      expect(connections.size).toBeGreaterThanOrEqual(5);
      for (const connection of connections) expect(() => connection.query("SELECT 1")).toThrow("closed");
      // The next calls open afresh and succeed.
      expect(await app.get(GRAPH.maintenance)).toEqual(baseline.routes.maintenance);
      expect(await pi(dir, "brain_list")).toEqual(baseline.list);
      expect(await hygiene(dir)).toEqual(baseline.hygiene);
    } finally {
      await app.close();
    }
  });
});
