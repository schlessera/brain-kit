/**
 * Route latency of the graph view and the keyterm build, before and after
 * #697 moved them onto core's supported query results.
 *
 *   bun scripts/measure-graph-routes.ts [--cold-runs 10] [--warm-runs 50]
 *
 * Both implementations answer through real Hono routes (`routes.request`) over
 * the same two CLI-produced indexes: the Odysseus fixture corpus, and a
 * generated cap-sized graph (5,100 markdown notes, ~27,500 links) that
 * exercises every node/edge cap. The baseline is the frozen pre-migration
 * reader under tests/helpers/legacy-ui; the replacement is the shipped
 * ui-server route with its lazily resolved core peer.
 *
 * Cold: the first request in a fresh process (module load, peer resolution,
 * first open), one process per sample. Warm: requests after five warm-ups in
 * one process. Keyless and offline; no network, no paid model.
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { cpus, tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const ROUTES = [
  "/graph/meta",
  "/graph/clusters",
  "/graph/neighborhood?center=CENTER",
  "/graph/discovery",
  "/graph/maintenance",
  "keyterms",
] as const;
type Impl = "baseline" | "replacement";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

async function load(impl: Impl, brainPath: string) {
  if (impl === "baseline") {
    const { createGraphRoutes } = await import("../tests/helpers/legacy-ui/graph-routes.js");
    const { buildKeyterms } = await import("../tests/helpers/legacy-ui/keyterm-builder.js");
    return { routes: createGraphRoutes({ brainRoot: brainPath }), keyterms: () => buildKeyterms({ brainPath, cacheDir: brainPath, limit: 500 }) };
  }
  const { createGraphRoutes } = await import("../packages/ui-server/src/routes/graph.js");
  const { buildKeyterms } = await import("../packages/ui-server/src/voice/keyterm-builder.js");
  const { createCoreQueryAccess } = await import("../packages/ui-server/src/core-queries.js");
  const queries = createCoreQueryAccess();
  return { routes: createGraphRoutes({ brainRoot: brainPath, queries }), keyterms: () => buildKeyterms({ brainPath, cacheDir: brainPath, limit: 500, queries }) };
}

async function once(target: Awaited<ReturnType<typeof load>>, route: string, center: string): Promise<number> {
  const start = Bun.nanoseconds();
  if (route === "keyterms") {
    const cache = target.keyterms();
    if (cache.degraded || cache.count === 0) throw new Error("empty keyterms");
  } else {
    const response = await target.routes.request(route.replace("CENTER", encodeURIComponent(center)));
    if (response.status !== 200) throw new Error(`${route}: ${response.status}`);
    await response.arrayBuffer();
  }
  return (Bun.nanoseconds() - start) / 1e6;
}

// Child mode: one cold sample.
if (process.argv[2] === "--child") {
  const [, , , impl, brainPath, route, center] = process.argv;
  const t0 = Bun.nanoseconds();
  const target = await load(impl as Impl, brainPath);
  const ms = await once(target, route, center);
  console.log(JSON.stringify({ ms, withLoad: (Bun.nanoseconds() - t0) / 1e6 }));
  process.exit(0);
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function cliIndex(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "measure-graph-routes-"));
  cpSync(source, dir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `brain.db${suffix}`), { force: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const env: Record<string, string | undefined> = { ...process.env, BRAIN_ROOT: dir };
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "BRAIN_RERANK_MODE"]) delete env[name];
  const child = Bun.spawn([process.execPath, join(ROOT, "packages/core/src/cli/brain.ts"), "index", "--force", "--json"], { env, stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  const db = new Database(join(dir, "brain.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(true);
  return dir;
}

/** The fixture index, rewritten to a graph that hits every cap. */
function capSized(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), "measure-graph-routes-cap-"));
  cpSync(join(fixture, "brain.db"), join(dir, "brain.db"));
  const db = new Database(join(dir, "brain.db"));
  db.exec("DELETE FROM links; DELETE FROM graph_metrics; DELETE FROM graph_layouts; DELETE FROM graph_communities; DELETE FROM graph_root_distances; DELETE FROM documents");
  const doc = db.query("INSERT INTO documents (id,path,title,type,status,created,updated,content,indexed_at,asset_type) VALUES (?,?,?,'note','active','2026-01-01','2026-01-01',?,'2026-01-01T00:00:00Z','markdown')");
  const metric = db.query("INSERT INTO graph_metrics (document_id,in_degree,out_degree,component,pagerank,community) VALUES (?,5,5,1,?,?)");
  const layout = db.query("INSERT INTO graph_layouts (mode,document_id,x,y) VALUES ('clusters',?,?,?)");
  const distance = db.query("INSERT INTO graph_root_distances (document_id,distance,parent_id) VALUES (?,?,NULL)");
  const link = db.query("INSERT INTO links (source_id,target,target_id) VALUES (?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 5100; i++) {
      doc.run(10000 + i, `notes/ithaca-${i}.md`, `Ithaca ${i}`, `**Penelope Icarius** waits on Ithaca ${i}. MCP log.`);
      metric.run(10000 + i, i, i % 12);
      layout.run(10000 + i, i % 100, Math.floor(i / 100));
      distance.run(10000 + i, 1 + (i % 8));
    }
    for (let i = 0; i < 5100; i++) for (let j = 1; j <= 5; j++) link.run(10000 + i, `notes/ithaca-${(i + j) % 5100}.md`, 10000 + ((i + j) % 5100));
    for (let i = 6; i < 2000; i++) link.run(10000, `notes/ithaca-${i}.md`, 10000 + i);
    db.run("INSERT INTO graph_communities (community,size,label,top_terms) SELECT DISTINCT community, 425, 'ithaca', '[\"ithaca\"]' FROM graph_metrics");
    db.run("INSERT OR REPLACE INTO index_metadata (key,value) VALUES ('graph_root','notes/ithaca-0.md')");
  })();
  db.close(true);
  return dir;
}

const coldRuns = arg("--cold-runs", 10);
const warmRuns = arg("--warm-runs", 50);
const fixture = await cliIndex(join(ROOT, "packages/core/fixtures/corpus"));
const cap = capSized(fixture);
const corpora = [
  { name: "fixture corpus", dir: fixture, center: "studies/star-bearings.md" },
  { name: "cap-sized graph", dir: cap, center: "notes/ithaca-0.md" },
];
console.log(`Bun ${Bun.version}, ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"} x${cpus().length}`);
for (const corpus of corpora) {
  const db = new Database(join(corpus.dir, "brain.db"), { readonly: true });
  const counts = db.query<{ d: number; l: number }, []>("SELECT (SELECT COUNT(*) FROM documents) AS d, (SELECT COUNT(*) FROM links) AS l").get()!;
  db.close();
  console.log(`\n## ${corpus.name}: ${counts.d} documents, ${counts.l} links; cold n=${coldRuns}, warm n=${warmRuns} (ms)\n`);
  console.log("| route | baseline cold p50/p95 | replacement cold p50/p95 | baseline warm p50/p95 | replacement warm p50/p95 |");
  console.log("| --- | --- | --- | --- | --- |");
  const warm: Record<Impl, Awaited<ReturnType<typeof load>>> = { baseline: await load("baseline", corpus.dir), replacement: await load("replacement", corpus.dir) };
  for (const route of ROUTES) {
    const row: string[] = [route.replace("CENTER", corpus.center)];
    const cold: Record<Impl, number[]> = { baseline: [], replacement: [] };
    for (let i = 0; i < coldRuns; i++) {
      for (const impl of ["baseline", "replacement"] as const) {
        const child = Bun.spawn([process.execPath, import.meta.path, "--child", impl, corpus.dir, route, corpus.center], { stdout: "pipe", stderr: "inherit" });
        const out = await new Response(child.stdout).text();
        if (await child.exited !== 0) throw new Error(`cold ${impl} ${route} failed`);
        cold[impl].push(JSON.parse(out).ms);
      }
    }
    const warmSamples: Record<Impl, number[]> = { baseline: [], replacement: [] };
    for (const impl of ["baseline", "replacement"] as const) for (let i = 0; i < 5; i++) await once(warm[impl], route, corpus.center);
    for (let i = 0; i < warmRuns; i++) {
      for (const impl of ["baseline", "replacement"] as const) warmSamples[impl].push(await once(warm[impl], route, corpus.center));
    }
    const fmt = (v: number[]) => `${pct(v, 50).toFixed(2)} / ${pct(v, 95).toFixed(2)}`;
    row.push(fmt(cold.baseline), fmt(cold.replacement), fmt(warmSamples.baseline), fmt(warmSamples.replacement));
    console.log(`| ${row.join(" | ")} |`);
  }
}
for (const corpus of corpora) rmSync(corpus.dir, { recursive: true, force: true });
