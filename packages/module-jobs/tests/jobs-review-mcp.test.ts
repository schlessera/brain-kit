/** The first real module tool, exercised through the public stdio protocol. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../../core/tests/cli-harness";
import { openDatabase } from "../src/db";
import { ingestJobs } from "../src/scrape";
import type { JobRow, RawJob } from "../src/types";

const roots: string[] = [];
const clients: Client[] = [];
const packageRoot = resolve(import.meta.dir, "..");
afterAll(async () => {
  for (const client of clients) await client.close();
  for (const root of roots) cleanup(root);
});

function fixture(dbPath = "jobs.db", seed = true): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  const moduleDir = join(root, "modules/jobs");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "module.ts"),
    `export { default } from ${JSON.stringify(join(packageRoot, "src/module.ts"))};\n`);
  cpSync(join(packageRoot, "skills"), join(moduleDir, "skills"), { recursive: true });
  cpSync(join(packageRoot, "README.md"), join(moduleDir, "README.md"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    modules: { "./modules/jobs": { criteria: "career/criteria.md", dbPath } },
  }));
  if (seed) {
    const path = join(root, dbPath);
    mkdirSync(dirname(path), { recursive: true });
    const db = openDatabase(path);
    try {
      const jobs: RawJob[] = Array.from({ length: 66 }, (_, i) => ({
        source: i % 2 === 0 ? "remoteok" : "remotive", source_id: `ithaca-${i}`,
        title: `Ithaca navigation role ${i}`, company: "Ithaca Fleet",
        description: "Odysseus is comparing this fictional opportunity.",
        location: i % 2 === 0 ? "Ithaca" : undefined, remote_type: "fully_remote",
        tags: i % 2 === 0 ? ["navigation", "sailing"] : undefined,
        salary_min: i === 0 ? 200_000 : undefined,
        salary_max: i === 0 ? 240_000 : undefined, salary_currency: i === 0 ? "USD" : undefined,
        salary_raw: i === 1 ? "$120000 per year" : undefined,
        url: i === 2 ? undefined : `https://example.com/jobs/ithaca-${i}`,
        published_at: i === 2 ? undefined : `2026-09-${String(30 - (i % 20)).padStart(2, "0")}T12:00:00Z`,
      }));
      expect(ingestJobs(db, jobs, false, { USD: 0.5 }).new).toBe(66);
      const update = db.query("UPDATE jobs SET relevance_score = ?, review_status = ? WHERE source_id = ?");
      for (let i = 0; i < jobs.length; i++) {
        update.run(99 - i * 0.8, ["queued", "interested", "dismissed"][i % 3]!, `ithaca-${i}`);
      }
      db.exec("UPDATE jobs SET is_duplicate = 1 WHERE source_id = 'ithaca-65'");
      db.exec("UPDATE jobs SET tags = 'not-json' WHERE source_id = 'ithaca-2'");
    } finally { db.close(); }
  }
  return root;
}

async function connect(root: string): Promise<Client> {
  const client = new Client({ name: "jobs-review-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root), stderr: "pipe",
  }));
  return client;
}

async function call(client: Client, arguments_: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name: "jobs_review", arguments: arguments_ }));
}

let root: string;
let client: Client;
beforeAll(async () => { root = fixture(); client = await connect(root); });

test("tools/list discovers the enabled real jobs module and its read-only review schema", async () => {
  const listed = await runCli(root, ["module", "list", "--json"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).enabled.map((m: { name: string }) => m.name)).toContain("jobs");
  const tool = (await client.listTools()).tools.find((t) => t.name === "jobs_review");
  expect(tool).toBeDefined();
  expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  expect(tool!.description).toContain("50");
  expect(tool!.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  expect(tool!.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
});

function projected(row: JobRow) {
  let tags: unknown = [];
  try { tags = row.tags === null ? [] : JSON.parse(row.tags); } catch { /* invalid stored JSON */ }
  return {
    id: row.id, title: row.title, company: row.company, location: row.location,
    remote_type: row.remote_type, salary_raw: row.salary_raw,
    salary_min: row.salary_min, salary_max: row.salary_max, salary_currency: row.salary_currency,
    source: row.source, published_at: row.published_at, review_status: row.review_status,
    relevance_score: row.relevance_score,
    tags: Array.isArray(tags) && tags.every((t) => typeof t === "string") ? tags : [], url: row.url,
  };
}

test("tools/list matches the pinned jobs_review input schema", async () => {
  const tool = (await client.listTools()).tools.find((t) => t.name === "jobs_review");
  expect(tool).toBeDefined();
  const pinned = JSON.parse(readFileSync(join(import.meta.dir, "jobs-review-input-schema.json"), "utf8"));
  expect(tool!.inputSchema).toEqual(pinned);
});

for (const [name, input, flags, expectedIds] of [
  ["default queued", {}, [], Array.from({ length: 20 }, (_, i) => 1 + i * 3)],
  ["minimum score", { min_score: 85 }, ["--min-score", "85"], [1, 4, 7, 10, 13, 16]],
  ["all statuses with limit", { status: "all", limit: 3 }, ["--all", "--limit", "3"], [1, 2, 3]],
  ["source", { source: "remotive" }, ["--source", "remotive"], [4, 10, 16, 22, 28, 34, 40, 46, 52, 58, 64]],
] as const) {
  test(`jobs_review matches non-empty CLI rows and their projection: ${name}`, async () => {
    const cli = await runCli(root, ["jobs", "review", ...flags, "--json"]);
    expect(cli.code).toBe(0);
    const rows = JSON.parse(cli.stdout).jobs as JobRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.id)).toEqual([...expectedIds]);
    const result = await call(client, input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ jobs: rows.map(projected) });
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
  });
}

test("salary bounds retain ingested annual EUR cents and source currency provenance", async () => {
  const result = await call(client, { limit: 1 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ jobs: [{
    id: 1, salary_min: 10_000_000, salary_max: 12_000_000, salary_currency: "USD",
    tags: ["navigation", "sailing"],
  }] });
  const human = await runCli(root, ["jobs", "review", "--limit", "1", "--human"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("€");
});

test("the tool clamps oversized positive limits to 50 with more than 50 eligible jobs", async () => {
  const cli = await runCli(root, ["jobs", "review", "--all", "--limit", "500", "--json"]);
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.stdout).jobs).toHaveLength(65);
  const result = await call(client, { status: "all", limit: 500 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent?.jobs).toHaveLength(50);
  const cappedCli = await runCli(root, ["jobs", "review", "--all", "--limit", "50", "--json"]);
  expect(cappedCli.code).toBe(0);
  expect(result.structuredContent).toEqual({ jobs: JSON.parse(cappedCli.stdout).jobs.map(projected) });
});

test("invalid tool inputs are named tool errors", async () => {
  for (const [input, field] of [
    [{ limit: 0 }, "limit"], [{ limit: 1.5 }, "limit"], [{ status: "unknown" }, "status"],
    [{ source: "unknown" }, "source"], [{ unexpected: true }, "unexpected"],
  ] as const) {
    const result = await call(client, input);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(field);
  }
});

test("invalid CLI options fail with usage guidance before opening a database", async () => {
  const empty = fixture("jobs.db", false);
  for (const flags of [["--limit", "abc"], ["--limit", "0"], ["--limit", "1.5"], ["--status", "unknown"], ["--source", "unknown"]]) {
    const result = await runCli(empty, ["jobs", "review", ...flags, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Usage: brain jobs review");
    expect(result.stderr).not.toContain("SQLITE");
    expect(existsSync(join(empty, "jobs.db"))).toBe(false);
  }
});

test("an absent database returns an empty tool queue and does not create jobs.db", async () => {
  const empty = fixture("jobs.db", false);
  expect(existsSync(join(empty, "jobs.db"))).toBe(false);
  const result = await call(await connect(empty));
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ jobs: [] });
  expect(existsSync(join(empty, "jobs.db"))).toBe(false);
});

test("an absent database returns the unchanged empty CLI envelope without creating it", async () => {
  const empty = fixture("jobs.db", false);
  const result = await runCli(empty, ["jobs", "review", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ jobs: [] });
  expect(existsSync(join(empty, "jobs.db"))).toBe(false);
});

test("the tool reads the owning module's custom dbPath", async () => {
  const custom = fixture("data/review.db");
  const result = await call(await connect(custom), { limit: 1 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent?.jobs).toHaveLength(1);
  expect(existsSync(join(custom, "jobs.db"))).toBe(false);
});

test("a configured database symlink outside the brain is refused by the tool", async () => {
  const outside = fixture();
  const contained = fixture("escape/jobs.db", false);
  symlinkSync(outside, join(contained, "escape"));
  const result = await call(await connect(contained));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("escapes the brain root");
});

test("the real module passes module lint", async () => {
  const result = await runCli(root, ["module", "lint", "jobs", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).errors).toBe(0);
});

test("stored jobs from a retired board remain readable in the projected queue", async () => {
  const historic = fixture();
  const db = openDatabase(join(historic, "jobs.db"));
  try { db.exec("UPDATE jobs SET source = 'remoteineurope' WHERE id = 1"); }
  finally { db.close(); }
  const cli = await runCli(historic, ["jobs", "review", "--limit", "1", "--json"]);
  expect(cli.code).toBe(0);
  const rows = JSON.parse(cli.stdout).jobs as JobRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.source as string).toBe("remoteineurope");
  const result = await call(await connect(historic), { limit: 1 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ jobs: rows.map(projected) });
});
