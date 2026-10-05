import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, existsSync, renameSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import * as queries from "@schlessera/brain/queries";
import type { QueryResult } from "@schlessera/brain/queries";
import { SCHEMA_VERSION } from "@schlessera/brain";
import { walkLinks } from "../packages/core/src/lib/link-walk.js";
import { filterSearch } from "../packages/core/src/lib/search-engine.js";
// The frozen pre-migration server readers: core must keep reproducing them.
import { getClusters, getDiscovery, getGraphMeta, getMaintenance, getNeighborhood } from "./helpers/legacy-ui/graph-reader.js";
import { buildKeyterms } from "./helpers/legacy-ui/keyterm-builder.js";
const ROOT = resolve(import.meta.dir, "..");
let brainPath: string;
const temporary: string[] = [];
const CENTER = "notes/odysseus.md";
function success<T>(result: QueryResult<T>): T {
  expect(result.ok, `query result: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok)
    throw new Error("expected successful query");
  expect(result.snapshot.schemaVersion).toBe(SCHEMA_VERSION);
  expect(result.snapshot.newestIndexedAt).toBeString();
  return result.value;
}
function clone(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-query-copy-"));
  temporary.push(dir);
  cpSync(join(brainPath, "brain.db"), join(dir, "brain.db"));
  return dir;
}
function edit(dir: string, sql: string): void {
  const db = new Database(join(dir, "brain.db"));
  try {
    db.exec(sql);
  }
  finally {
    db.close(true);
  }
}
function error(result: QueryResult<unknown>, code: queries.QueryCode): void {
  expect(result).toEqual({ ok: false, error: { code, retryable: code === "busy_index" } });
}
beforeAll(async () => {
  brainPath = mkdtempSync(join(tmpdir(), "brain-query-odysseus-"));
  temporary.push(brainPath);
  cpSync(join(ROOT, "packages/core/fixtures/corpus"), brainPath, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(brainPath, "node_modules"));
  mkdirSync(join(brainPath, "notes"), { recursive: true });
  writeFileSync(join(brainPath, CENTER), `---\ntitle: Odysseus\ntype: note\nstatus: active\nrelevance: primary\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [Ithaca]\n---\n# Odysseus\n[[notes/ithaca.md]] [[Unknown Harbour]] [[notes/odysseus.md]]\n**Ithaca Harbour** uses MCP. MCP carries the message.\n`);
  writeFileSync(join(brainPath, "notes/ithaca.md"), `---\ntitle: Ithaca\ntype: note\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# Ithaca\n[[notes/odysseus.md]]\n`);
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(brainPath, `brain.db${suffix}`), { force: true });
  const env: Record<string, string | undefined> = { ...process.env, BRAIN_ROOT: brainPath };
  for (const name of ["GEMINI_API_KEY", "TYPESAFE_API_KEY", "BRAIN_RERANK_MODE", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"])
    delete env[name];
  const proc = Bun.spawn([process.execPath, join(ROOT, "packages/core/src/cli/brain.ts"), "index", "--force", "--json"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0);
  expect(JSON.parse(out).total).toBeGreaterThan(0);
  const db = new Database(join(brainPath, "brain.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(true);
});
afterAll(() => { for (const dir of temporary)
  rmSync(dir, { recursive: true, force: true }); });
describe("supported content-index results against a real CLI index", () => {
  test("all five graph modes preserve the UI profile with populated results", () => {
    const opts = { brainPath };
    const meta = success(queries.readGraphMeta(opts));
    expect(meta.nodeCount).toBeGreaterThan(0);
    expect(meta.edgeCount).toBeGreaterThan(0);
    expect(meta).toEqual(getGraphMeta(opts));
    const clusters = success(queries.readGraphClusters(opts));
    expect(clusters.nodes.length).toBeGreaterThan(0);
    expect(clusters.edges.length).toBeGreaterThan(0);
    expect(clusters).toEqual(getClusters(opts));
    const withIsolates = success(queries.readGraphClusters({ brainPath, includeIsolates: true }));
    expect(withIsolates.nodes.length).toBeGreaterThan(0);
    expect(withIsolates).toEqual(getClusters({ brainPath, includeIsolates: true }));
    expect(meta.communities.length).toBeGreaterThan(0);
    const community = meta.communities[0].community;
    const oneCommunity = success(queries.readGraphClusters({ brainPath, community, includeIsolates: true }));
    expect(oneCommunity.nodes.length).toBeGreaterThan(0);
    expect(oneCommunity.nodes.every(n => n.community === community)).toBe(true);
    expect(oneCommunity).toEqual(getClusters({ brainPath, community, includeIsolates: true }));
    const hoodOpts = { brainPath, center: CENTER };
    const hood = success(queries.readGraphNeighborhood(hoodOpts));
    expect(hood.nodes.length).toBeGreaterThan(1);
    expect(hood.edges.length).toBeGreaterThan(0);
    expect(hood).toEqual(getNeighborhood(hoodOpts));
    const discovery = success(queries.readGraphDiscovery({ brainPath, root: CENTER }));
    expect(discovery.nodes.length).toBeGreaterThan(1);
    expect(discovery.reachableCount).toBeGreaterThan(1);
    expect(discovery).toEqual(getDiscovery({ brainPath, root: CENTER }));
    const maintenance = success(queries.readGraphMaintenance(opts));
    expect(maintenance.brokenLinks.length).toBeGreaterThan(0);
    expect(maintenance).toEqual(getMaintenance(opts));
  });
  test("link walking keeps unresolved text, cycles, directions and depth clamps", () => {
    const db = new Database(join(brainPath, "brain.db"), { readonly: true });
    try {
      for (const direction of ["incoming", "outgoing", "both"] as const)
        for (const depth of [-1, 1, 2, 4, 9]) {
          const value = success(queries.readLinkWalk({ brainPath, path: CENTER, depth, direction }));
          expect(value.edges.length).toBeGreaterThan(0);
          expect(value.nodes.length).toBeGreaterThan(0);
          expect(value).toEqual(walkLinks(db, { path: CENTER, depth: Math.min(4, Math.max(1, depth)), direction }));
        }
      const value = success(queries.readLinkWalk({ brainPath, path: `./${CENTER}` }));
      expect(value.edges.some(e => !e.resolved && e.target === "Unknown Harbour")).toBe(true);
      expect(new Set(value.edges.map(e => `${e.source}->${e.target}`)).size).toBe(value.edges.length);
    }
    finally {
      db.close();
    }
  });
  test("vocabulary and list ranking match the existing populated readers", () => {
    const value = success(queries.readVoiceVocabulary({ brainPath, limit: 200 }));
    expect(value.terms.length).toBeGreaterThan(0);
    expect(value.terms).toContain("Ithaca Harbour");
    expect(value.extractorVersion).toBe(2);
    expect(value.terms).toEqual(buildKeyterms({ brainPath, cacheDir: brainPath, limit: 200 }).keyterms);
    expect(success(queries.readVoiceVocabulary({ brainPath, limit: 1 })).terms).toEqual(value.terms.slice(0, 1));
    const db = new Database(join(brainPath, "brain.db"), { readonly: true });
    try {
      for (const options of [{}, { type: "note" }, { tag: "Ithaca" }, { status: "archived" }, { relevance: "primary", limit: 5 }]) {
        const actual = success(queries.listIndexDocuments({ brainPath, ...options }));
        const expected = filterSearch(db, { ...options, includeArchived: options.status === "archived", limit: options.limit ?? 20 }).map(r => ({ path: r.path, title: r.title, type: r.type, relevance: r.relevance ?? null, status: r.status ?? null, tags: r.tags ?? null }));
        expect(actual).toEqual(expected);
      }
      expect(success(queries.listIndexDocuments({ brainPath, tag: "Ithaca" })).length).toBeGreaterThan(0);
    }
    finally {
      db.close();
    }
  });
  test("uncomputed and supported older layouts keep raw graph access", () => {
    const dir = clone();
    edit(dir, "DELETE FROM index_metadata WHERE key = 'graph_computed_at'");
    const meta = success(queries.readGraphMeta({ brainPath: dir }));
    expect(meta.available).toBe(false);
    expect(meta.reason).toBe("not_computed");
    expect(meta.nodeCount).toBeGreaterThan(0);
    for (const result of [queries.readGraphClusters({ brainPath: dir }), queries.readGraphDiscovery({ brainPath: dir }), queries.readGraphMaintenance({ brainPath: dir })])
      error(result, "not_computed");
    expect(success(queries.readGraphNeighborhood({ brainPath: dir, center: CENTER })).nodes.length).toBeGreaterThan(1);
    edit(dir, "UPDATE index_metadata SET value = '3' WHERE key = 'schema_version'; DROP TABLE graph_metrics; DROP TABLE graph_layouts; DROP TABLE graph_communities; DROP TABLE graph_root_distances");
    const result = queries.readGraphNeighborhood({ brainPath: dir, center: CENTER });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.schemaVersion).toBe(3);
      expect(result.value.nodes.length).toBeGreaterThan(1);
      expect(result.value.nodes.every(n => n.pagerank === undefined)).toBe(true);
    }
    const older = queries.readGraphMeta({ brainPath: dir });
    expect(older.ok).toBe(true);
    if (older.ok) {
      expect(older.value.reason).toBe("schema");
      expect(older.value.nodeCount).toBeGreaterThan(0);
    }
    error(queries.readGraphClusters({ brainPath: dir }), "incompatible_index");
    expect(queries.readLinkWalk({ brainPath: dir, path: CENTER }).ok).toBe(true);
  });
  test("meta exposes stale provenance and maintenance accepts a deterministic clock", () => {
    const dir = clone();
    edit(dir, "UPDATE index_metadata SET value = '2020-01-01T00:00:00Z' WHERE key = 'graph_computed_at'");
    const result = queries.readGraphMeta({ brainPath: dir });
    const meta = success(result);
    expect(meta.stale).toBe(true);
    expect(meta.computedAt).toBe("2020-01-01T00:00:00Z");
    expect(success(queries.readGraphMaintenance({ brainPath: dir, staleDays: 180, now: "2026-10-01T00:00:00Z" })).stale.some(n => n.path === CENTER)).toBe(true);
  });
  test("complete hygiene selection is uncapped, ordered and matches suffixes literally", () => {
    const dir = clone();
    const db = new Database(join(dir, "brain.db"));
    try {
      const insert = db.prepare("INSERT INTO documents (path,title,type,status,relevance,created,updated,content,indexed_at) VALUES (?, 'Odysseus', 'opportunity', ?, 'primary', '2026-01-01','2026-01-01','Ithaca','2026-01-01T00:00:00Z')");
      db.transaction(() => { for (let i = 0; i < 125; i++)
        insert.run(`career/ithaca-${String(i).padStart(3, "0")}/status.md`, "active"); insert.run("career/ithaca-literal/sta%_us.md", "active"); insert.run("career/ithaca-null/status.md", null); insert.run("career/ithaca-archived/status.md", "archived"); })();
      insert.finalize();
    }
    finally {
      db.close(true);
    }
    const value = success(queries.findIndexDocuments({ brainPath: dir, type: "opportunity", excludeStatus: "archived", pathSuffix: "status.md" }));
    const seeded = value.filter(n => n.path.startsWith("career/ithaca-"));
    expect(seeded.length).toBe(125);
    expect(seeded.map(n => n.path)).toEqual([...seeded.map(n => n.path)].sort());
    expect(seeded[0].updated).toBe("2026-01-01");
    expect(success(queries.findIndexDocuments({ brainPath: dir, type: "opportunity", excludeStatus: "archived", pathSuffix: "/status.md" }))).toEqual(value);
    expect(success(queries.findIndexDocuments({ brainPath: dir, pathSuffix: "sta%_us.md" })).map(n => n.path)).toEqual(["career/ithaca-literal/sta%_us.md"]);
    expect(success(queries.listIndexDocuments({ brainPath: dir, type: "opportunity" })).length).toBe(20);
    expect(success(queries.listIndexDocuments({ brainPath: dir, type: "opportunity", limit: 1000 })).length).toBe(100);
  });
});
describe("index failures and input validation are safe typed results", () => {
  test("missing files, corrupt files and unavailable paths are distinct", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-query-missing-"));
    temporary.push(dir);
    error(queries.readGraphMeta({ brainPath: dir }), "missing_index");
    expect(existsSync(join(dir, "brain.db"))).toBe(false);
    writeFileSync(join(dir, "brain.db"), "Odysseus: this is not a SQLite file");
    error(queries.readGraphMeta({ brainPath: dir }), "corrupt_index");
    rmSync(join(dir, "brain.db"));
    mkdirSync(join(dir, "brain.db"));
    error(queries.readGraphMeta({ brainPath: dir }), "unavailable_index");
  });
  test("old, unknown newer, malformed and forged versions fail before returning data", () => {
    for (const version of ["2", String(SCHEMA_VERSION + 1), "15junk", "", "3.5"]) {
      const dir = clone();
      const db = new Database(join(dir, "brain.db"));
      db.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [version]);
      db.close(true);
      error(queries.listIndexDocuments({ brainPath: dir }), "incompatible_index");
    }
    const dir = clone();
    edit(dir, "ALTER TABLE documents DROP COLUMN title");
    error(queries.listIndexDocuments({ brainPath: dir }), "corrupt_index");
    const forged = clone();
    edit(forged, "DROP TABLE graph_layouts");
    error(queries.readGraphMeta({ brainPath: forged }), "corrupt_index");
    error(queries.readGraphNeighborhood({ brainPath: forged, center: CENTER }), "corrupt_index");
  });
  test("invalid inputs and absent paths never masquerade as an empty success", () => {
    const bad = ["../notes/odysseus.md", "/notes/odysseus.md", "notes/../odysseus.md", "C:\\notes\\odysseus.md", "notes\\odysseus.md", "notes//odysseus.md", "", "notes/\u0000.md"];
    for (const path of bad) {
      error(queries.readLinkWalk({ brainPath, path }), "invalid_input");
      error(queries.readGraphNeighborhood({ brainPath, center: path }), "invalid_input");
    }
    error(queries.readLinkWalk({ brainPath, path: "notes/absent.md" }), "not_found");
    error(queries.readGraphNeighborhood({ brainPath, center: "notes/absent.md" }), "not_found");
    error(queries.readGraphDiscovery({ brainPath, root: "../outside.md" }), "invalid_input");
    error(queries.readGraphNeighborhood({ brainPath, center: CENTER, depth: 1.5 }), "invalid_input");
    error(queries.readGraphDiscovery({ brainPath, direction: "in" as "out" }), "invalid_input");
    error(queries.readGraphClusters({ brainPath, community: NaN }), "invalid_input");
    error(queries.readGraphClusters({ brainPath, includeIsolates: 1 as unknown as boolean }), "invalid_input");
    error(queries.readGraphMaintenance({ brainPath, now: "2026-02-30T00:00:00Z" }), "invalid_input");
    error(queries.readVoiceVocabulary({ brainPath, limit: 0 }), "invalid_input");
    error(queries.listIndexDocuments({ brainPath, limit: Infinity }), "invalid_input");
    error(queries.findIndexDocuments({ brainPath, pathSuffix: "../status.md" }), "invalid_input");
    error(queries.readGraphMeta({ brainPath: "" }), "invalid_input");
    error(queries.readGraphMeta(null as unknown as queries.Root), "invalid_input");
  });
  test("a real exclusive lock exhausts the bounded wait with a retryable result", () => {
    const dir = clone();
    const db = new Database(join(dir, "brain.db"));
    try {
      db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      const started = performance.now();
      let nativeTimeout: number | undefined;
      observe(() => error(queries.readGraphMeta({ brainPath: dir }), "busy_index"), connection => {
        if (nativeTimeout === undefined) nativeTimeout = (nativeQuery.call(connection, "PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      });
      expect(nativeTimeout, "the locked API connection must have the bounded native wait").toBe(100);
      expect(performance.now() - started).toBeLessThan(1500);
    }
    finally {
      db.exec("ROLLBACK");
      db.close(true);
    }
  });
});
const nativeQuery = Database.prototype.query;
function observe(run: () => void, hook: (db: Database, sql: string) => void): void {
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) { hook(this, sql); return nativeQuery.call(this, sql); } as typeof nativeQuery);
  try {
    run();
  }
  finally {
    spy.mockRestore();
  }
}
describe("native connection lifetime and read snapshot", () => {
  test("read-only opens refuse writes and close immediately after success", () => {
    const dir = clone();
    const before = readFileSync(join(dir, "brain.db"));
    let seen: Database | undefined;
    let refused = false;
    let result: QueryResult<queries.ListedDocument[]> | undefined;
    observe(() => { result = queries.listIndexDocuments({ brainPath: dir }); }, (db, sql) => {
      if (!seen && sql === "SELECT key, value FROM index_metadata") {
        seen = db;
        try {
          db.run("UPDATE documents SET title = 'Changed Ithaca'");
        }
        catch {
          refused = true;
        }
      }
    });
    expect(refused, "native writes must be refused on the query connection").toBe(true);
    expect(success(result!).length).toBeGreaterThan(0);
    expect(seen).toBeDefined();
    expect(() => seen!.query("SELECT 1")).toThrow("closed");
    expect(readFileSync(join(dir, "brain.db"))).toEqual(before);
  });
  test("native handles close on compatibility refusal and a mid-query error", () => {
    for (const failure of ["version", "mid-query"]) {
      const dir = clone();
      if (failure === "version")
        edit(dir, `UPDATE index_metadata SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
      let seen: Database | undefined;
      observe(() => error(queries.listIndexDocuments({ brainPath: dir }), failure === "version" ? "incompatible_index" : "unavailable_index"), (db, sql) => {
        seen = db;
        if (failure === "mid-query" && sql.startsWith("SELECT d.path, d.title"))
          throw Object.assign(new Error("private native detail"), { code: "SQLITE_IOERR" });
      });
      expect(seen).toBeDefined();
      expect(() => seen!.query("SELECT 1")).toThrow("closed");
    }
  });
  test("compatibility, provenance and documents stay on one WAL snapshot", () => {
    const dir = clone();
    const writer = new Database(join(dir, "brain.db"));
    writer.exec("PRAGMA journal_mode=WAL");
    let committed = false;
    let before: queries.ListedDocument[] = [];
    before = success(queries.listIndexDocuments({ brainPath: dir, limit: 100 }));
    expect(before.length).toBeGreaterThan(0);
    const beforeResult = queries.listIndexDocuments({ brainPath: dir, limit: 100 });
    try {
      observe(() => {
        const result = queries.listIndexDocuments({ brainPath: dir, limit: 100 });
        expect(result.ok, "the in-flight compatibility snapshot stays usable").toBe(true);
        expect(result).toEqual(beforeResult);
      }, (_db, sql) => {
        if (!committed && sql === "SELECT MAX(indexed_at) AS newest FROM documents") {
          committed = true;
          writer.transaction(() => { writer.run("UPDATE documents SET title = 'New Ithaca', indexed_at = '2099-01-01T00:00:00Z'"); writer.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION + 1)]); })();
        }
      });
      expect(committed).toBe(true);
      error(queries.listIndexDocuments({ brainPath: dir }), "incompatible_index");
    }
    finally {
      writer.close(true);
    }
  });
  test("each call opens the replaced checkpointed index and results remain detached", () => {
    const dir = clone();
    const replacement = clone();
    edit(replacement, "UPDATE documents SET title = 'New Ithaca'");
    const checkpoint = new Database(join(replacement, "brain.db"));
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close(true);
    const old = success(queries.listIndexDocuments({ brainPath: dir }));
    expect(old.length).toBeGreaterThan(0);
    expect(old.some(d => d.title !== "New Ithaca")).toBe(true);
    renameSync(join(replacement, "brain.db"), join(dir, "brain.db"));
    const next = success(queries.listIndexDocuments({ brainPath: dir }));
    expect(next.length).toBeGreaterThan(0);
    expect(next.every(d => d.title === "New Ithaca")).toBe(true);
    expect(old.some(d => d.title !== "New Ithaca")).toBe(true);
    next[0].title = "Detached";
    expect(success(queries.listIndexDocuments({ brainPath: dir }))[0].title).toBe("New Ithaca");
  });
});
describe("graph profile edge cases and caps", () => {
  test("default virtual and absent roots preserve counts while explicit direction applies", () => {
    const dir = clone();
    const db = new Database(join(dir, "brain.db"));
    try {
      const ids = db.query<{
        id: number;
        path: string;
      }, [
      ]>("SELECT id, path FROM documents WHERE path IN ('notes/odysseus.md','notes/ithaca.md') ORDER BY path").all();
      expect(ids.length).toBe(2);
      db.transaction(() => {
        db.exec("DELETE FROM graph_root_distances");
        db.run("INSERT INTO graph_root_distances (document_id,distance,parent_id) VALUES (?,1,NULL)", [ids[0].id]);
        db.run("INSERT INTO graph_root_distances (document_id,distance,parent_id) VALUES (?,2,?)", [ids[1].id, ids[0].id]);
        db.run("INSERT OR REPLACE INTO index_metadata (key,value) VALUES ('graph_root','virtual:README.md')");
        db.run("INSERT OR REPLACE INTO index_metadata (key,value) VALUES ('graph_root_links',?)", [JSON.stringify([ids[0].id])]);
      })();
      const value = success(queries.readGraphDiscovery({ brainPath: dir, maxDepth: 1, direction: "both" }));
      expect(value.nodes.some(n => n.id === 0 && n.virtual && n.path === "README.md")).toBe(true);
      expect(value.nodes.length).toBe(2);
      expect(value.edges).toContainEqual({ source: 0, target: ids[0].id });
      expect(value.reachableCount).toBe(2);
      expect(value.unreachableCount).toBe(success(queries.readGraphMeta({ brainPath: dir })).nodeCount - 2);
      expect(value).toEqual(getDiscovery({ brainPath: dir, maxDepth: 1, direction: "both" }));
      db.run("DELETE FROM index_metadata WHERE key = 'graph_root'");
      const absent = success(queries.readGraphDiscovery({ brainPath: dir }));
      expect(absent.nodes.length).toBeGreaterThan(0);
      expect(absent.reachableCount).toBeUndefined();
      expect(absent.unreachableCount).toBeUndefined();
      for (const direction of ["out", "both"] as const) {
        const opts = { brainPath: dir, root: CENTER, direction, maxDepth: 1 };
        expect(success(queries.readGraphDiscovery(opts))).toEqual(getDiscovery(opts));
      }
    }
    finally {
      db.close(true);
    }
  });
  test("real indexed layout bounds nodes and edges and preserves ranked scene ordering", () => {
    const dir = clone();
    const db = new Database(join(dir, "brain.db"));
    try {
      db.exec("DELETE FROM links; DELETE FROM graph_metrics; DELETE FROM graph_layouts; DELETE FROM graph_communities; DELETE FROM graph_root_distances; DELETE FROM documents");
      const document = db.query("INSERT INTO documents (id,path,title,type,status,created,updated,content,indexed_at,asset_type) VALUES (?,?, 'Ithaca','note','active','2026-01-01','2026-01-01','Odysseus','2026-01-01T00:00:00Z',?)");
      const metric = db.query("INSERT INTO graph_metrics (document_id,in_degree,out_degree,component,pagerank,community) VALUES (?,5,5,1,?,1)");
      const link = db.query("INSERT INTO links (source_id,target,target_id) VALUES (?,?,?)");
      db.transaction(() => {
        for (let i = 0; i < 5100; i++) {
          document.run(10000 + i, `notes/ithaca-${i}.md`, "markdown");
          metric.run(10000 + i, i);
        }
        document.run(20000, "assets/ithaca.pdf", "pdf");
        for (let i = 0; i < 5100; i++)
          for (let j = 1; j <= 5; j++)
            link.run(10000 + i, `notes/ithaca-${(i + j) % 5100}.md`, 10000 + (i + j) % 5100);
        for (let i = 6; i < 2000; i++)
          link.run(10000, `notes/ithaca-${i}.md`, 10000 + i);
        link.run(10000, "assets/ithaca.pdf", 20000);
        link.run(10000, "notes/ithaca-0.md", 10000);
        link.run(10000, "duplicate alias", 10001);
      })();
      const opts = { brainPath: dir };
      const meta = success(queries.readGraphMeta(opts));
      expect(meta.nodeCount).toBe(5100);
      expect(meta.edgeCount).toBe(5100 * 5 + 1994);
      const clusters = success(queries.readGraphClusters(opts));
      expect(clusters.nodes.length).toBe(5000);
      expect(clusters.edges.length).toBe(20000);
      expect(clusters.truncated).toBe(true);
      expect(clusters.nodes[0].pagerank).toBe(5099);
      expect(clusters.nodes.every(n => n.path.endsWith(".md"))).toBe(true);
      expect(clusters).toEqual(getClusters(opts));
      const hoodOpts = { brainPath: dir, center: "notes/ithaca-0.md", depth: 1, direction: "out" as const };
      const hood = success(queries.readGraphNeighborhood(hoodOpts));
      expect(hood.nodes.length).toBe(1500);
      expect(hood.truncated).toBe(true);
      expect(hood).toEqual(getNeighborhood(hoodOpts));
      expect(success(queries.readGraphClusters({ brainPath: dir, community: 2 })).nodes).toEqual([]);
      const discovery = success(queries.readGraphDiscovery({ brainPath: dir, root: "notes/ithaca-0.md", maxDepth: 1 }));
      expect(discovery.reachableCount).toBe(5100);
      expect(discovery.unreachableCount).toBe(0);
      expect(discovery.nodes.length).toBeLessThan(5100);
    }
    finally {
      db.close(true);
    }
  });
});
test("each of the nine operations checks and reads inside its own closed native transaction", () => {
  const operations = [() => queries.readGraphMeta({ brainPath }), () => queries.readGraphClusters({ brainPath }), () => queries.readGraphNeighborhood({ brainPath, center: CENTER }), () => queries.readGraphDiscovery({ brainPath, root: CENTER }), () => queries.readGraphMaintenance({ brainPath }), () => queries.readLinkWalk({ brainPath, path: CENTER }), () => queries.readVoiceVocabulary({ brainPath, limit: 20 }), () => queries.listIndexDocuments({ brainPath }), () => queries.findIndexDocuments({ brainPath })];
  const connections = new Set<Database>();
  for (const call of operations) {
    let seen: Database | undefined;
    observe(() => { expect(call().ok).toBe(true); }, (db) => { seen = db; expect(db.inTransaction).toBe(true); });
    expect(seen).toBeDefined();
    connections.add(seen!);
    expect(() => seen!.query("SELECT 1")).toThrow("closed");
  }
  expect(connections.size).toBe(9);
});
