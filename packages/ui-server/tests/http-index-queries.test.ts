/**
 * The graph view and the voice vocabulary, through the real app, against a
 * brain.db the real `brain` CLI produced. Every request carries a valid owner
 * session, so what fails here fails in the handler or in core — never at the
 * auth guard, which is checked separately to answer first without a session.
 *
 * Core is an optional peer (#696 ruling A). These tests stage the installation
 * states that follow from that — usable, absent, skewed — and the index states
 * a usable core can report — present, missing, incompatible, replaced.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateSignedCookie } from "hono/cookie";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as queries from "@schlessera/brain/queries";
import { defineSpeechProvider, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { setCoreModuleLoaderForTesting, type CoreModuleLoader } from "../src/core-queries";
import { createPrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

const ROOT = resolve(import.meta.dir, "../../..");
const SECRET = "index-query-fixture-secret-0123456789";
const AUTH_ENV = { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" };
const GRAPH_ROUTES = ["/api/graph/meta", "/api/graph/clusters", "/api/graph/neighborhood?center=notes/odysseus.md", "/api/graph/discovery", "/api/graph/maintenance"];
const OVERRIDES = "- Odysseus → oh-DISS-ee-us\n- Ithaca -> ITH-uh-kuh\n";

const temporary: string[] = [];
/** Two checkpointed CLI-produced indexes: A is the voyage, B a later voyage. */
let indexA: string;
let indexB: string;

async function cliIndex(notes: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "brain-ui-index-queries-"));
  temporary.push(dir);
  writeFileSync(join(dir, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  for (const [path, body] of Object.entries(notes)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const env: Record<string, string | undefined> = { ...process.env, BRAIN_ROOT: dir };
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "BRAIN_RERANK_MODE"]) delete env[name];
  const child = Bun.spawn([process.execPath, join(ROOT, "packages/core/src/cli/brain.ts"), "index", "--force", "--json"], { cwd: dir, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  expect(JSON.parse(out).total).toBeGreaterThan(0);
  const db = new Database(join(dir, "brain.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(true);
  return join(dir, "brain.db");
}

const note = (title: string, tags: string, body: string, updated = "2026-07-12") =>
  `---\ntitle: ${title}\ntype: note\nstatus: active\nrelevance: primary\ncreated: 2026-07-01\nupdated: ${updated}\ntags: [${tags}]\n---\n# ${title}\n${body}\n`;

beforeAll(async () => {
  indexA = await cliIndex({
    "AGENTS.md": "# Voyage entry\n\nStart with [[odysseus]].\n",
    "notes/odysseus.md": note("Odysseus", "Ithaca, Voyage", "Sails for [[ithaca]] past [[Scylla Strait]] and [[penelope]].\n**Odysseus Laertiades** keeps the MCP log. MCP keeps the bearings."),
    "notes/ithaca.md": note("Ithaca", "Ithaca", "Home of [[penelope]]. [[odysseus]] returns."),
    "notes/penelope.md": note("Penelope", "Ithaca", "Weaves and unweaves; waits for [[odysseus]].", "2025-01-01"),
    "notes/calypso.md": note("Calypso", "Ogygia", "An island with no links out."),
  });
  indexB = await cliIndex({
    "notes/odysseus.md": note("Odysseus", "Voyage", "Sails for [[telemachus]]."),
    "notes/telemachus.md": note("Telemachus", "Ithaca", "Searches for [[odysseus]]."),
  });
});

afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => setCoreModuleLoaderForTesting(null));

interface Booted extends HttpContractApp {
  get(path: string): Response | Promise<Response>;
  post(path: string): Response | Promise<Response>;
  cacheFile: string;
}

async function boot(options: { index?: string | null; speechProvider?: SpeechProvider; env?: Record<string, string> } = {}): Promise<Booted> {
  const t = await httpContractApp({ env: { ...AUTH_ENV, ...options.env }, ...(options.speechProvider ? { speechProvider: options.speechProvider } : {}) });
  if (options.index !== null) copyFileSync(options.index ?? indexA, join(t.brainPath, "brain.db"));
  writeFileSync(join(t.brainPath, ".voice-overrides.md"), OVERRIDES);
  const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", owner.id, SECRET)).split(";")[0]!;
  const send = (path: string, method: string) => t.fetch(path, { method, headers: { cookie, origin: "http://localhost", host: "localhost" } });
  return Object.assign(t, {
    get: (path: string) => send(path, "GET"),
    post: (path: string) => send(path, "POST"),
    cacheFile: join(t.app.config.voice.cacheDir, "keyterms.json"),
  });
}

/** A loader standing in for an installation that has no core at all. */
const absentCore = (): CoreModuleLoader => ({
  resolve: () => { throw Object.assign(new Error("Cannot find package '@schlessera/brain'"), { code: "MODULE_NOT_FOUND" }); },
  load: () => { throw new Error("unreachable"); },
});

/** The real installation, except that it reports an older release. */
function skewedCore(version: string): () => CoreModuleLoader {
  const require = createRequire(import.meta.url);
  return () => ({
    resolve: (specifier) => require.resolve(specifier),
    load: (specifier) => specifier.endsWith("/package.json") ? { ...require(specifier), version } : require(specifier),
  });
}

const OVERRIDE_PAIRS = [{ match: "Odysseus", replacement: "oh-DISS-ee-us" }, { match: "Ithaca", replacement: "ITH-uh-kuh" }];

describe("usable core and a CLI-produced index", () => {
  test("the auth guard answers before any graph or vocabulary handler", async () => {
    const t = await boot();
    try {
      for (const path of [...GRAPH_ROUTES, "/api/voice/keyterms"]) {
        expect((await t.fetch(path)).status, path).toBe(401);
      }
    } finally { await t.close(); }
  });

  test("all five mounted graph routes serve core's populated results unchanged", async () => {
    const t = await boot();
    try {
      const brainPath = t.brainPath;
      const expected: Record<string, unknown> = {
        "/api/graph/meta": queries.readGraphMeta({ brainPath }),
        "/api/graph/clusters": queries.readGraphClusters({ brainPath, includeIsolates: false }),
        "/api/graph/neighborhood?center=notes/odysseus.md": queries.readGraphNeighborhood({ brainPath, center: "notes/odysseus.md", depth: 1, direction: "both" }),
        "/api/graph/discovery": queries.readGraphDiscovery({ brainPath, direction: "out", maxDepth: 8 }),
        "/api/graph/maintenance": queries.readGraphMaintenance({ brainPath, staleDays: 180 }),
      };
      for (const path of GRAPH_ROUTES) {
        const result = expected[path] as { ok: boolean; value: unknown };
        expect(result.ok, path).toBe(true);
        const response = await t.get(path);
        expect(response.status, path).toBe(200);
        const body = await response.json();
        // Maintenance's stale cutoff is "now"; everything else is exact.
        expect(body, path).toEqual(result.value);
      }
      const meta = await (await t.get("/api/graph/meta")).json();
      expect(meta.available).toBe(true);
      expect(meta.nodeCount).toBeGreaterThan(3);
      expect(meta.edgeCount).toBeGreaterThan(3);
      expect(meta.defaultRoot).toEqual({ path: "AGENTS.md", virtual: true });
      const clusters = await (await t.get("/api/graph/clusters")).json();
      expect(clusters.nodes.map((n: { path: string }) => n.path)).not.toContain("notes/calypso.md");
      expect((await (await t.get("/api/graph/clusters?isolates=1")).json()).nodes.map((n: { path: string }) => n.path)).toContain("notes/calypso.md");
      const discovery = await (await t.get("/api/graph/discovery")).json();
      expect(discovery.nodes[0]).toMatchObject({ id: 0, virtual: true, path: "AGENTS.md" });
      expect(discovery.reachableCount).toBeGreaterThan(0);
      const maintenance = await (await t.get("/api/graph/maintenance")).json();
      expect(maintenance.brokenLinks).toContainEqual({ sourcePath: "notes/odysseus.md", target: "Scylla Strait" });
      expect(maintenance.orphans.map((n: { path: string }) => n.path)).toEqual(["notes/calypso.md"]);
      expect(maintenance.stale.map((n: { path: string }) => n.path)).toContain("notes/penelope.md");
    } finally { await t.close(); }
  });

  test("parameter validation, absent paths and caps keep their responses", async () => {
    const t = await boot();
    try {
      const cases: [string, number, unknown][] = [
        ["/api/graph/neighborhood", 400, { error: "missing_center" }],
        ["/api/graph/neighborhood?center=notes/odysseus.md&depth=4", 400, { error: "invalid_param", param: "depth" }],
        ["/api/graph/neighborhood?center=notes/odysseus.md&direction=sideways", 400, { error: "invalid_param", param: "direction" }],
        ["/api/graph/clusters?community=-1", 400, { error: "invalid_param", param: "community" }],
        ["/api/graph/discovery?maxDepth=9", 400, { error: "invalid_param", param: "maxDepth" }],
        ["/api/graph/discovery?direction=in", 400, { error: "invalid_param", param: "direction" }],
        ["/api/graph/maintenance?staleDays=0", 400, { error: "invalid_param", param: "staleDays" }],
        ["/api/graph/neighborhood?center=notes/absent.md", 404, { error: "not_found" }],
        ["/api/graph/neighborhood?center=../outside.md", 404, { error: "not_found" }],
        ["/api/graph/discovery?root=notes/absent.md", 404, { error: "not_found" }],
      ];
      for (const [path, status, body] of cases) {
        const response = await t.get(path);
        expect(response.status, path).toBe(status);
        expect(await response.json(), path).toEqual(body);
      }
      const deep = await (await t.get("/api/graph/neighborhood?center=notes/ithaca.md&depth=3&direction=in")).json();
      expect(deep).toEqual((queries.readGraphNeighborhood({ brainPath: t.brainPath, center: "notes/ithaca.md", depth: 3, direction: "in" }) as { value: unknown }).value);
      expect((await (await t.get("/api/graph/maintenance?staleDays=3650")).json()).staleDays).toBe(3650);
    } finally { await t.close(); }
  });

  test("voice vocabulary comes from core, keeps markdown overrides and is cached", async () => {
    const t = await boot();
    try {
      const response = await t.get("/api/voice/keyterms?rebuild=1");
      expect(response.status).toBe(200);
      const body = await response.json();
      const expected = queries.readVoiceVocabulary({ brainPath: t.brainPath, limit: t.app.config.voice.keytermLimit });
      expect(expected.ok).toBe(true);
      if (!expected.ok) return;
      expect(expected.value.terms.length).toBeGreaterThan(0);
      expect(body.keyterms).toEqual(expected.value.terms);
      expect(body.keyterms).toContain("Odysseus");
      expect(body.count).toBe(body.keyterms.length);
      expect(existsSync(t.cacheFile)).toBe(true);
      expect((await (await t.get("/api/voice/overrides")).json()).overrides).toEqual(OVERRIDE_PAIRS);
    } finally { await t.close(); }
  });

  test("each request reads the index that is there now, not a held handle", async () => {
    const t = await boot();
    try {
      const before = await (await t.get("/api/graph/meta")).json();
      expect((await t.get("/api/graph/neighborhood?center=notes/ithaca.md")).status).toBe(200);
      // A valid, checkpointed replacement, swapped in between requests.
      const staging = join(t.brainPath, "brain.db.next");
      copyFileSync(indexB, staging);
      renameSync(staging, join(t.brainPath, "brain.db"));
      const after = await (await t.get("/api/graph/meta")).json();
      expect(after.nodeCount).toBe(2);
      expect(after.nodeCount).not.toBe(before.nodeCount);
      expect((await t.get("/api/graph/neighborhood?center=notes/ithaca.md")).status).toBe(404);
      expect((await t.get("/api/graph/neighborhood?center=notes/telemachus.md")).status).toBe(200);
      const terms = (await (await t.get("/api/voice/keyterms?rebuild=1")).json()).keyterms;
      expect(terms).toContain("Telemachus");
    } finally { await t.close(); }
  });
});

describe("index states reported by a usable core", () => {
  test("a missing index: described meta, refused subgraphs, the vocabulary's own error", async () => {
    const t = await boot({ index: null });
    try {
      const meta = await t.get("/api/graph/meta");
      expect(meta.status).toBe(200);
      expect(await meta.json()).toEqual({ available: false, reason: "schema", schemaVersion: 0, computedAt: null, stale: false, nodeCount: 0, edgeCount: 0, communities: [], defaultRoot: null });
      for (const path of GRAPH_ROUTES.slice(1)) {
        const response = await t.get(path);
        expect(response.status, path).toBe(503);
        expect(await response.json(), path).toEqual({ error: "graph_unavailable", reason: "schema" });
      }
      const keyterms = await t.get("/api/voice/keyterms");
      expect(keyterms.status).toBe(500);
      expect((await keyterms.json()).error).toStartWith("brain.db not found at ");
      expect(existsSync(t.cacheFile)).toBe(false);
    } finally { await t.close(); }
  });

  test("an incompatible index degrades the vocabulary to overrides without caching it", async () => {
    const t = await boot();
    try {
      const db = new Database(join(t.brainPath, "brain.db"));
      db.run("UPDATE index_metadata SET value = '99' WHERE key = 'schema_version'");
      db.close(true);
      const meta = await (await t.get("/api/graph/meta")).json();
      expect(meta).toMatchObject({ available: false, reason: "schema", schemaVersion: 0 });
      expect(await (await t.get("/api/graph/clusters")).json()).toEqual({ error: "graph_unavailable", reason: "schema" });
      const keyterms = await t.get("/api/voice/keyterms");
      expect(keyterms.status).toBe(200);
      expect(await keyterms.json()).toMatchObject({ keyterms: [], count: 0 });
      expect((await (await t.get("/api/voice/overrides")).json()).overrides).toEqual(OVERRIDE_PAIRS);
      expect(existsSync(t.cacheFile)).toBe(false);
      expect(t.observability.logs.find({ severity: "WARN", scope: "voice" }).map((r) => r.attributes)).toContainEqual({ "index.error": "incompatible_index" });
    } finally { await t.close(); }
  });

  test("an uncomputed graph: meta says so, raw neighborhoods still work, derived modes refuse", async () => {
    const t = await boot();
    try {
      const db = new Database(join(t.brainPath, "brain.db"));
      db.run("DELETE FROM index_metadata WHERE key = 'graph_computed_at'");
      db.close(true);
      expect(await (await t.get("/api/graph/meta")).json()).toMatchObject({ available: false, reason: "not_computed" });
      expect((await t.get("/api/graph/neighborhood?center=notes/odysseus.md")).status).toBe(200);
      for (const path of ["/api/graph/clusters", "/api/graph/discovery", "/api/graph/maintenance"]) {
        expect(await (await t.get(path)).json(), path).toEqual({ error: "graph_unavailable", reason: "not_computed" });
      }
    } finally { await t.close(); }
  });
});

describe("without a usable core package", () => {
  for (const [name, loader, reason] of [
    ["absent", absentCore, "not_installed"],
    ["older than the query entry", skewedCore("0.39.0"), "version_unsupported"],
  ] as const) {
    test(`${name}: the app boots, the graph refuses as a capability, voice keeps its overrides`, async () => {
      setCoreModuleLoaderForTesting(loader);
      const t = await boot();
      try {
        // The index is perfectly readable; only the capability is missing.
        expect(queries.readGraphMeta({ brainPath: t.brainPath }).ok).toBe(true);
        // An unrelated feature is unaffected.
        expect((await t.get("/api/auth/methods")).status).toBe(200);
        for (const path of GRAPH_ROUTES) {
          const response = await t.get(path);
          expect(response.status, path).toBe(503);
          expect(await response.json(), path).toEqual({ error: "graph_unavailable", reason: "core_unavailable" });
        }
        // Parameter validation still answers first.
        expect((await t.get("/api/graph/discovery?maxDepth=9")).status).toBe(400);
        const keyterms = await t.get("/api/voice/keyterms");
        expect(keyterms.status).toBe(200);
        expect(await keyterms.json()).toMatchObject({ keyterms: [], count: 0 });
        expect((await (await t.get("/api/voice/overrides")).json()).overrides).toEqual(OVERRIDE_PAIRS);
        expect(existsSync(t.cacheFile)).toBe(false);
        const warnings = t.observability.logs.find({ severity: "WARN", scope: "core-queries" });
        expect(warnings.map((r) => r.attributes["core.reason"])).toEqual([reason, reason]);
        expect(JSON.stringify(warnings)).not.toContain(t.root);
      } finally { await t.close(); }
    });
  }
});

describe("speech providers and keyterm capability", () => {
  test("a provider without keyterm support never resolves core; one with it gets core's terms", async () => {
    let resolutions = 0;
    const require = createRequire(import.meta.url);
    setCoreModuleLoaderForTesting(() => ({
      resolve: (specifier) => { resolutions++; return require.resolve(specifier); },
      load: (specifier) => require(specifier),
    }));
    for (const keyterms of [false, true]) {
      const received: string[][] = [];
      const provider = defineSpeechProvider({
        id: "fixture-speech",
        capabilities: { streaming: true, interimResults: false, keyterms, endpointing: false },
        async createSession(opts) { received.push(opts.keyterms); return { url: "wss://speech.example.test/dictation", expiresAt: 1 }; },
      });
      resolutions = 0;
      const t = await boot({ speechProvider: provider, env: { VOICE_PROVIDER: "fixture-speech" } });
      try {
        expect((await t.post("/api/voice/session")).status).toBe(200);
        if (keyterms) {
          expect(resolutions).toBeGreaterThan(0);
          expect(received[0]).toContain("Odysseus");
        } else {
          expect(resolutions).toBe(0);
          expect(received).toEqual([[]]);
        }
      } finally { await t.close(); }
    }
  });
});
