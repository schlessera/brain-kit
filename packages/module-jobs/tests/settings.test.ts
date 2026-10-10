import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, keylessEnv, makeTempBrain, runCli } from "../../core/tests/cli-harness";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { configSchema } from "../src/module";
import { jobsSettings, planScoringMigration } from "../src/settings";
import { loadScoringConfig, parseScoringConfig, scoreJob } from "../src/score";
import { ADAPTERS, getAdapterOptions } from "../src/scrape";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
const source = readFileSync(join(import.meta.dir, "fixtures/criteria.md"), "utf8");

function fixture(criteria = source): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  mkdirSync(join(root, "career"));
  writeFileSync(join(root, "career/criteria.md"), criteria);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "@schlessera/brain-module-jobs": { criteria: "career/criteria.md" } } }));
  return root;
}

function git(root: string, args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", root, ...args], { env: keylessEnv(root) });
  expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
  return new TextDecoder().decode(p.stdout).trim();
}
function initialize(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Alex Example"]);
  git(root, ["config", "user.email", "alex@example.com"]);
  git(root, ["add", "brain.config.json", "career/criteria.md"]);
  git(root, ["commit", "-m", "fixture"]);
}
async function cli(root: string, args: string[]) {
  const result = await runCli(root, ["module", "settings", "jobs", ...args, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

test("jobs migration preserves complete source form and proves parser equivalence", () => {
  const input = source.replace("distributed systems", "Distributed Systems").replace("scoring:\n", "title: Criteria\nscoring:\n  futureRule: { Mode: Keep }\n");
  const root = fixture(input);
  const plan = planScoringMigration(root, { criteria: "career/criteria.md" });
  const original = parseFrontmatter(input);
  const remaining = parseFrontmatter(plan.changes[0]!.after);
  const moved = plan.values.scoring as Record<string, unknown>;
  expect(moved.groups).toEqual(original.data.scoring.groups);
  expect(moved.groups).toHaveLength(2);
  expect(moved.futureRule).toBeUndefined();
  expect(remaining.data.scoring).toEqual({ futureRule: { Mode: "Keep" } });
  expect(remaining.data.title).toBe("Criteria");
  expect(remaining.content).toBe(original.content);
  expect(plan.changes[0]!.after).toContain("  futureRule: { Mode: Keep }\n");
  expect(plan.details.parserEquivalent).toBe(true);
  expect(parseScoringConfig(moved)).toEqual(parseScoringConfig(original.data.scoring));
});

test("source validation retains both forms, odd match, numeric strings and absent defaults", () => {
  const scoring = { groups: [{ name: "systems", weight: "25", match: "legacy-value", titleBoost: 1.5, tiers: [{ points: "15", keywords: ["Consensus"] }], keywords: ["UnusedCase"] }] };
  const parsed = configSchema.parse({ criteria: "career/criteria.md", scoring });
  expect(parsed.scoring).toEqual(scoring);
  expect(Object.keys(parsed.scoring!)).toEqual(["groups"]);
  expect(parseScoringConfig(parsed.scoring)).toEqual(parseScoringConfig(scoring));
  expect(configSchema.safeParse({ criteria: "career/criteria.md", scoring: { groups: [{ name: "bad", weight: -1, keywords: ["Staff"] }] } }).success).toBe(false);
});

test.each([
  "groups: [{name: Systems, weight: 25, keywords: [Consensus]}], future: {Mode: Keep}, queueThreshold: 60",
  "future: {Mode: Keep}, groups: [{name: Systems, weight: 25, keywords: [Consensus]}], queueThreshold: 60",
  "groups: [{name: Systems, weight: 25, keywords: [Consensus]}], queueThreshold: 60, future: {Mode: Keep}",
])("flow-map migration retains unknown source bytes: %s", (scoring) => {
  const input = `---\ntitle: 'Keep this spelling'\nscoring: {${scoring}}\nother: [one, two]\n---\nKeep this prose.\n`;
  const root = fixture(input);
  const plan = planScoringMigration(root, { criteria: "career/criteria.md" });
  const after = plan.changes[0]!.after;
  expect(after).toContain("future: {Mode: Keep}");
  expect(after).toContain("title: 'Keep this spelling'\n");
  expect(after).toContain("other: [one, two]\n---\nKeep this prose.\n");
  expect(parseFrontmatter(after).data.scoring).toEqual({ future: { Mode: "Keep" } });
  expect(parseScoringConfig(plan.values.scoring)).toEqual(parseScoringConfig(parseFrontmatter(input).data.scoring));
});

test("migration removes an all-known scoring entry from flow frontmatter without rewriting its neighbors", () => {
  const input = "---\n{title: 'Keep spelling', scoring: {groups: [{name: Systems, weight: 25, keywords: [Consensus]}]}, other: [one, two]}\n---\nKeep prose.\n";
  const root = fixture(input);
  const after = planScoringMigration(root, { criteria: "career/criteria.md" }).changes[0]!.after;
  expect(after).toContain("title: 'Keep spelling'");
  expect(after).toContain("other: [one, two]");
  expect(parseFrontmatter(after).data).toEqual({ title: "Keep spelling", other: ["one", "two"] });
  expect(parseFrontmatter(after).content).toBe(parseFrontmatter(input).content);
});

test("real migration commits once, removes only legacy scoring and leaves scores identical", async () => {
  const root = fixture();
  initialize(root);
  const config = loadScoringConfig(root, "career/criteria.md");
  const job = { title: "Staff systems engineer", company: "Example", description_text: "Distributed systems and consensus", location: "Europe", tags: ["remote"], salary_min: 15000000, salary_max: 16000000, remote_type: "remote" };
  const previousScore = scoreJob(job, config);
  const preview = await cli(root, ["--migrate", "--preview"]);
  expect(preview.parserEquivalent).toBe(true);
  const result = await cli(root, ["--migrate", "--revision", preview.revision]);
  expect(result.changed).toBe(true);
  expect(result.provenance["scoring.groups"]).toBe("migrated");
  expect(result.inherited.scoring).toBeUndefined();
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
  expect(git(root, ["show", "--pretty=", "--name-only", "HEAD"]).split("\n").sort()).toEqual(["career/criteria.md", "settings/jobs.json"]);
  expect(JSON.parse(readFileSync(join(root, "settings/jobs.json"), "utf8")).scoring).toEqual(parseFrontmatter(source).data.scoring);
  expect(parseFrontmatter(readFileSync(join(root, "career/criteria.md"), "utf8")).data.scoring).toBeUndefined();
  expect(loadScoringConfig(root, "career/criteria.md")).toEqual(config);
  expect(scoreJob(job, loadScoringConfig(root, "career/criteria.md"))).toEqual(previousScore);
  expect((await cli(root, ["--migrate"])).changed).toBe(false);
});

test("stale migration and commit failure leave both source files unchanged", async () => {
  const root = fixture();
  initialize(root);
  const preview = await cli(root, ["--migrate", "--preview"]);
  writeFileSync(join(root, "career/criteria.md"), source + "\nChanged prose.\n");
  const stale = await runCli(root, ["module", "settings", "jobs", "--migrate", "--revision", preview.revision, "--json"]);
  expect(stale.code).toBe(1);
  expect(JSON.parse(stale.stdout).status).toBe(409);
  expect(readFileSync(join(root, "career/criteria.md"), "utf8")).toBe(source + "\nChanged prose.\n");
  const hook = join(root, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  const failed = await runCli(root, ["module", "settings", "jobs", "--migrate", "--json"]);
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout).status).toBe(500);
  expect(readFileSync(join(root, "career/criteria.md"), "utf8")).toBe(source + "\nChanged prose.\n");
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
});

test("board choices follow adapter registry additions and expose documented blocked status", () => {
  expect(getAdapterOptions().find((o) => o.source === "remotive")).toMatchObject({ status: "blocked", caveat: expect.stringContaining("permission") });
  const registry = ADAPTERS as Record<string, typeof ADAPTERS.remoteok>;
  registry.fixture = ADAPTERS.remoteok;
  try { expect(jobsSettings().fields.find((f) => f.key === "boards")!.options!.some((o) => o.value === "fixture")).toBe(true); }
  finally { delete registry.fixture; }
});


test.each([
  ["BOM", "\uFEFF---\n", "\n---\n", "scoring: {groups: [{name: Systems, weight: 25, keywords: [Consensus]}]}\nother: 'Keep spelling'"],
  ["CRLF and YAML language tag", "---yaml\r\n", "\r\n---\r\n", "scoring: {groups: [{name: Systems, weight: 25, keywords: [Consensus]}]}\r\nother: 'Keep spelling'"],
  ["JSON language tag", "---json\n", "\n---\n", '{"scoring":{"groups":[{"name":"Systems","weight":25,"keywords":["Consensus"]}]},"other":"Keep spelling"}'],
  ["unclosed frontmatter", "---\n", "", "scoring: {groups: [{name: Systems, weight: 25, keywords: [Consensus]}]}\nother: 'Keep spelling'"],
])("migration keeps parser-accepted %s source forms", (_name, opening, closing, data) => {
  const input = opening + data + closing + (closing ? "Keep prose.\n" : "");
  const root = fixture(input);
  const original = parseFrontmatter(input);
  const plan = planScoringMigration(root, { criteria: "career/criteria.md" });
  const after = plan.changes[0]!.after;
  expect(after.startsWith(opening)).toBe(true);
  expect(after).toContain("Keep spelling");
  expect(parseFrontmatter(after).data).toEqual({ other: "Keep spelling" });
  expect(parseFrontmatter(after).content).toBe(original.content);
  expect(parseScoringConfig(plan.values.scoring)).toEqual(parseScoringConfig(original.data.scoring));
});


test("migration preserves comments and blank lines belonging to retained frontmatter", () => {
  for (const future of ["  # Keep future spelling\n\n  futureRule: {Mode: Keep}\n", ""]) {
    const input = "---\nscoring:\n  groups: [{name: Systems, weight: 25, keywords: [Consensus]}]\n" + future + "# Keep title comment\n\ntitle: 'Keep spelling'\n---\nKeep prose.\n";
    const root = fixture(input);
    const after = planScoringMigration(root, { criteria: "career/criteria.md" }).changes[0]!.after;
    expect(after).toContain("# Keep title comment\n\ntitle: 'Keep spelling'\n");
    if (future) expect(after).toContain(future);
    expect(parseFrontmatter(after).content).toBe("Keep prose.\n");
  }
});
