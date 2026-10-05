/**
 * Module hygiene checks read the content index through core's root-bound
 * `ctx.queries` (#699), never a raw database. These run the real loader
 * against CLI-produced indexes: the jobs module's complete opportunity
 * selection (with the former SQL predicate's exact case semantics), source
 * and config ownership, root binding against unsafe inputs and context
 * mutation, and failed-check reporting for a missing or incompatible index.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { auditWithModules } from "../packages/core/src/lib/auditor";
import { initContext, setContext, type BrainContext } from "../packages/core/src/lib/context";
import type { AuditIssue } from "../packages/core/src/lib/types";

const REPO = resolve(import.meta.dir, "..");
const BRAIN_BIN = join(REPO, "packages/core/src/cli/brain.ts");
const NOW = "2026-07-12";
const temporary: string[] = [];
afterAll(() => {
  setContext(null);
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const opportunity = (title: string, status: string | null, stage?: string) =>
  `---\ntype: opportunity\ntitle: "${title}"\ncreated: 2026-07-01\nupdated: ${NOW}\n` +
  `${status === null ? "" : `status: ${status}\n`}relevance: primary\n${stage ? `stage: ${stage}\n` : ""}---\n\n## Overview\n`;

/** The probe records what its hygiene check observed through the real loader. */
const PROBE = `export default {
  name: "probe",
  configSchema: { parse(input) { return { label: (input ?? {}).label ?? "unset", parsed: true }; } },
  setup: () => ({
    hygieneChecks: [
      async (ctx) => {
        await Promise.resolve();
        const seen = { keys: Object.keys(ctx).sort(), hasDb: "db" in ctx, config: ctx.config, root: ctx.root, frozen: Object.isFrozen(ctx.queries) };
        const opportunities = (q) => q.ok ? q.value.map((row) => row.path) : q.error.code;
        seen.direct = opportunities(ctx.queries.findIndexDocuments({ type: "opportunity" }));
        seen.unsafeOption = opportunities(ctx.queries.findIndexDocuments({ type: "opportunity", brainPath: "/nonexistent" }));
        seen.getterOption = opportunities(ctx.queries.findIndexDocuments({ type: "opportunity", get brainPath() { return "/nonexistent"; } }));
        seen.metaArgument = ctx.queries.readGraphMeta({ brainPath: "/nonexistent" }).ok;
        try { ctx.queries.findIndexDocuments = () => ({ ok: true, value: [] }); seen.reassigned = true; } catch { seen.reassigned = false; }
        ctx.root = "/nonexistent";
        seen.afterRootMutation = opportunities(ctx.queries.findIndexDocuments({ type: "opportunity" }));
        seen.listed = opportunities(ctx.queries.listIndexDocuments({ type: "opportunity", limit: 2 }));
        seen.results = Object.fromEntries(Object.entries({
          readGraphMeta: () => ctx.queries.readGraphMeta(),
          readGraphClusters: () => ctx.queries.readGraphClusters(),
          readGraphNeighborhood: () => ctx.queries.readGraphNeighborhood({ center: "career/aeolus/status.md" }),
          readGraphDiscovery: () => ctx.queries.readGraphDiscovery(),
          readGraphMaintenance: () => ctx.queries.readGraphMaintenance({ now: "2026-07-12T00:00:00Z" }),
          readLinkWalk: () => ctx.queries.readLinkWalk({ path: "career/aeolus/status.md" }),
          readVoiceVocabulary: () => ctx.queries.readVoiceVocabulary({ limit: 5 }),
          listIndexDocuments: () => ctx.queries.listIndexDocuments(),
          findIndexDocuments: () => ctx.queries.findIndexDocuments(),
        }).map(([name, run]) => [name, run().ok]));
        (globalThis.__hygieneProbe ??= []).push(seen);
        return [];
      },
    ],
  }),
};
`;

function brainDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "module-hygiene-queries-"));
  temporary.push(root);
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    modules: {
      "@schlessera/brain-module-jobs": { criteria: "criteria.md" },
      "./local/probe": { label: "ithaca" },
    },
  }));
  mkdirSync(join(root, "local", "probe"), { recursive: true });
  writeFileSync(join(root, "local", "probe", "module.ts"), PROBE);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

async function cliIndex(root: string): Promise<void> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const key of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY"]) delete env[key];
  env.BRAIN_ROOT = root;
  const proc = Bun.spawn(["bun", BRAIN_BIN, "index", "--json"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
}

/** Rows the indexer may not produce (`.MD` names, a null status) but another writer could. */
function addRows(root: string, rows: { path: string; status: string | null }[]): void {
  const db = new Database(join(root, "brain.db"));
  // A statement left unfinalized makes close(true) fail as "database is locked".
  const insert = db.prepare(
    "INSERT INTO documents (path,title,type,status,relevance,created,updated,content,indexed_at) VALUES (?, 'Odysseus', 'opportunity', ?, 'primary', '2026-07-01', ?, 'Ithaca', '2026-07-12T00:00:00Z') ON CONFLICT(path) DO UPDATE SET status = excluded.status"
  );
  try {
    for (const row of rows) insert.run(row.path, row.status, NOW);
  } finally {
    insert.finalize();
    db.close(true);
  }
}

type Probe = Record<string, unknown> & { results: Record<string, boolean> };
async function runAudit(brain: BrainContext, root = brain.root, failed: string[] = []): Promise<{ issues: AuditIssue[]; probes: Probe[] }> {
  (globalThis as { __hygieneProbe?: Probe[] }).__hygieneProbe = [];
  const db = new Database(join(brain.root, "brain.db"), { readonly: true });
  try {
    const issues = await auditWithModules(db, { ...brain, root }, { onCheckFailed: (name) => failed.push(name) });
    return { issues, probes: (globalThis as { __hygieneProbe?: Probe[] }).__hygieneProbe ?? [] };
  } finally {
    db.close(); // the core audit may leave its own statements to finalize
  }
}
const stagePaths = (issues: AuditIssue[]) => issues.filter((i) => i.category === "jobs-stage").map((i) => i.path);

describe("module hygiene through root-bound queries", () => {
  let brain: BrainContext;
  const UPPER_NESTED = "career/scylla/STATUS.MD";
  const NULL_STATUS = "career/lotus/status.md";

  beforeAll(async () => {
    const root = brainDir({
      "status.md": opportunity("Return to Ithaca", "active"),
      "career/aeolus/status.md": opportunity("Aeolus — Wind Logistics", "active"),
      "career/circe/STATUS.md": opportunity("Circe — Island Operations", "active"),
      "career/calypso/Status.md": opportunity("Calypso — Retention Lead", "active"),
      "career/ithaca/status.md": opportunity("Ithaca — Steward", "active", "applied"),
      "career/cyclops/status.md": opportunity("Cyclops — Shepherd", "archived"),
      "career/sirens/notstatus.md": opportunity("Sirens — Outreach", "active"),
      "notstatus.md": opportunity("Phaeacian Fleet", "active"),
      "notes/status.md": `---\ntype: note\ntitle: "Voyage status"\ncreated: 2026-07-01\nupdated: ${NOW}\n---\n\nAt sea.\n`,
      [UPPER_NESTED]: opportunity("Scylla — Strait Pilot", "active"),
      [NULL_STATUS]: opportunity("Lotus Eaters — Hospitality", null),
    });
    await cliIndex(root);
    addRows(root, [{ path: UPPER_NESTED, status: "active" }, { path: NULL_STATUS, status: null }]);
    brain = await initContext({ root });
  });

  test("jobs selects the former SQL candidate set exactly, completely and in path order", async () => {
    const { issues } = await runAudit(brain);
    const flagged = stagePaths(issues);
    // Root exact, nested ASCII-case-insensitive; near-names, notes, archived and null status excluded.
    expect(flagged).toEqual(["career/aeolus/status.md", "career/calypso/Status.md", "career/circe/STATUS.md", UPPER_NESTED, "status.md"]);
    const db = new Database(join(brain.root, "brain.db"), { readonly: true });
    const statement = db.prepare(
      `SELECT path FROM documents WHERE type = 'opportunity' AND status != 'archived' AND (path = 'status.md' OR path LIKE '%/status.md') ORDER BY path`
    );
    try {
      const former = statement.all() as { path: string }[];
      statement.finalize();
      // Every former candidate without a stage is flagged; the staged one is selected but clean.
      expect(former.map((r) => r.path).filter((p) => p !== "career/ithaca/status.md")).toEqual(flagged);
      expect(former.length).toBe(6);
    } finally {
      db.close(true);
    }
  });

  test("the context carries parsed config, the root and frozen bound queries, never a database", async () => {
    const { probes } = await runAudit(brain);
    expect(probes).toHaveLength(1);
    const probe = probes[0]!;
    expect(probe).toMatchObject({ keys: ["config", "queries", "root"], hasDb: false, config: { label: "ithaca", parsed: true }, root: brain.root, frozen: true, reassigned: false });
    const opportunities = probe.direct as string[];
    expect(opportunities).toContain("career/aeolus/status.md");
    expect(opportunities).toHaveLength(10);
    // Neither an option, a getter, an ignored argument nor a later ctx.root edit redirects a query.
    expect(probe.unsafeOption).toEqual(opportunities);
    expect(probe.getterOption).toEqual(opportunities);
    expect(probe.metaArgument).toBe(true);
    expect(probe.afterRootMutation).toEqual(opportunities);
    expect(probe.listed).toHaveLength(2);
    expect(Object.keys(probe.results)).toHaveLength(9);
    expect(probe.results).toMatchObject({ readGraphMeta: true, readGraphNeighborhood: true, readLinkWalk: true, readVoiceVocabulary: true, listIndexDocuments: true, findIndexDocuments: true });
  });

  test("stages come from the source file under the root, selection from the index", async () => {
    const root = brainDir({
      "career/penelope/status.md": opportunity("Penelope — Weaving Operations", "active"),
      "career/telemachus/status.md": opportunity("Telemachus — Search Coordinator", "active"),
    });
    await cliIndex(root);
    writeFileSync(join(root, "career/telemachus/status.md"), opportunity("Telemachus — Search Coordinator", "active", "interviewing"));
    // Root uppercase is not the root status file; only `.md`-named rows reach the indexer, so add it.
    writeFileSync(join(root, "STATUS.MD"), opportunity("Ithaca Council", "active"));
    addRows(root, [{ path: "STATUS.MD", status: "active" }]);
    const { issues } = await runAudit(await initContext({ root }));
    expect(stagePaths(issues)).toEqual(["career/penelope/status.md"]);
  });

  test.each([
    ["a missing", (dir: string) => dir, "missing_index", "run `brain index`"],
    ["an incompatible", (dir: string) => {
      cpSync(join(brain.root, "brain.db"), join(dir, "brain.db"));
      const db = new Database(join(dir, "brain.db"));
      try { db.run("UPDATE index_metadata SET value = '999' WHERE key = 'schema_version'"); } finally { db.close(true); }
      return dir;
    }, "incompatible_index", "run `brain index --force`"],
  ] as const)("%s index fails the jobs check instead of reporting a clean result", async (_label, prepare, code, action) => {
    const other = mkdtempSync(join(tmpdir(), "module-hygiene-queries-other-"));
    temporary.push(other);
    cpSync(join(brain.root, "career"), join(other, "career"), { recursive: true });
    const failed: string[] = [];
    const { issues } = await runAudit(brain, prepare(other), failed);
    expect(stagePaths(issues)).toEqual([]);
    expect(failed).toEqual(["jobs"]);
    const failure = issues.find((i) => i.category === "module-hygiene");
    expect(failure).toMatchObject({ path: "(module)", severity: "warning" });
    expect(failure!.message).toBe(`hygiene check from module "jobs" failed: opportunity stages could not read the content index (${code}): ${action}`);
  });
});
