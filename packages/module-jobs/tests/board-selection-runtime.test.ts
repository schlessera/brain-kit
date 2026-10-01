import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../../core/tests/cli-harness";
import manifest, { configSchema } from "../src/module";
import { ALL_SOURCES, RETIRED_SOURCES } from "../src/types";
import { openDatabase } from "../src/db";
import { ingestJobs } from "../src/scrape";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
const curated = ["remoteok", "weworkremotely", "workingnomads", "remotelyde"];
const schedule = manifest.setup(configSchema.parse({ criteria: "career/criteria.md" })).cron!.find((entry) => entry.name === "scrape")!;

function fixture(boards?: string[]) {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  mkdirSync(join(root, "career"));
  mkdirSync(join(root, "settings"));
  writeFileSync(join(root, "career/criteria.md"), readFileSync(join(import.meta.dir, "fixtures/criteria.md"), "utf8"));
  writeFileSync(join(root, "brain.config.ts"), `export default ${JSON.stringify({ modules: { "@schlessera/brain-module-jobs": { criteria: "career/criteria.md", boards } } })};\n`);
  return root;
}

async function scrape(root: string, args: string[], json = true) {
  const receipt = join(root, "selection-receipt.json");
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "helpers/board-selection-preload.ts"), BRAIN_BIN, ...args, json ? "--json" : "--human"], {
    env: { ...keylessEnv(root), JOBS_SELECTION_RECEIPT: receipt }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const observed: string[] = JSON.parse(readFileSync(receipt, "utf8")).observed;
  return { code, stdout, stderr, observed };
}

for (const positional of [["remoteok", "nosuchboard"], ["nosuchboard", "another-typo"], ["remoteok", "remoteineurope"], ["remoteok", "remoteineurope", "nosuchboard"]]) {
  test(`real CLI rejects the complete positional selection: ${positional.join(", ")}`, async () => {
    expect(positional.length).toBeGreaterThan(0);
    const root = fixture();
    const result = await scrape(root, ["jobs", "scrape", ...positional]);
    expect(result.code, result.stderr + result.stdout).toBe(1);
    for (const name of positional.filter((name) => !(ALL_SOURCES as readonly string[]).includes(name))) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain(ALL_SOURCES.join(", "));
    if (positional.includes("remoteineurope")) expect(result.stderr).toContain(RETIRED_SOURCES.remoteineurope);
    expect(result.observed).toEqual([]);
    expect(existsSync(join(root, "jobs.db"))).toBe(false);
  });
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { env: keylessEnv(root) });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

function initializeGit(root: string) {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Alex Example"]);
  git(root, ["config", "user.email", "alex@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "brain.config.ts", "career"]);
  git(root, ["commit", "-m", "fixture"]);
}

for (const invalid of ["nosuchboard", "remoteineurope"]) {
  test(`hand-edited ${invalid} settings fail shared validation before CLI selection`, async () => {
    const root = fixture(["workingnomads"]);
    const path = join(root, "settings/jobs.json");
    const boards = ["remoteok", invalid];
    expect(boards).toHaveLength(2);
    const source = JSON.stringify({ boards });
    writeFileSync(path, source);
    const result = await scrape(root, ["validate"]);
    const body = JSON.parse(result.stdout);
    expect(body).toHaveProperty("configError");
    expect(result.code, result.stderr + result.stdout).toBe(1);
    const diagnostic = body.configError;
    expect(diagnostic).toContain(invalid);
    expect(diagnostic).toContain('"boards"');
    expect(diagnostic).toContain(ALL_SOURCES.join(", "));
    if (invalid === "remoteineurope") expect(diagnostic).toContain(RETIRED_SOURCES.remoteineurope);
    expect(result.observed).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(source);
    expect(existsSync(join(root, "jobs.db"))).toBe(false);
  });

  test(`shared writer and hand-edited loader reject ${invalid} with the same field diagnostic`, async () => {
    const root = fixture(["workingnomads"]);
    initializeGit(root);
    const path = join(root, "settings/jobs.json");
    const before = '{ "boards": ["remoteok"], "queries": ["fixture query"] }\n';
    writeFileSync(path, before);
    git(root, ["add", "settings/jobs.json"]);
    git(root, ["commit", "-m", "existing settings"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const config = readFileSync(join(root, "brain.config.ts"), "utf8");
    const boards = ["remoteok", invalid];
    expect(boards).toHaveLength(2);
    const saved = await runCli(root, ["module", "settings", "jobs", "--set", `boards=${JSON.stringify(boards)}`, "--json"]);
    expect(saved.code, saved.stderr + saved.stdout).toBe(1);
    const body = JSON.parse(saved.stdout);
    expect(body.status).toBe(422);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].path).toBe("boards.1");
    expect(body.errors[0].message).toContain(invalid);
    expect(body.errors[0].message).toContain(ALL_SOURCES.join(", "));
    if (invalid === "remoteineurope") expect(body.errors[0].message).toContain(RETIRED_SOURCES.remoteineurope);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    expect(readFileSync(join(root, "brain.config.ts"), "utf8")).toBe(config);

    const handEdited = JSON.stringify({ boards });
    writeFileSync(path, handEdited);
    for (const args of [["validate"], ["jobs", "scrape"], schedule.command.split(/\s+/)]) {
      const loaded = await scrape(root, args);
      expect(loaded.code, loaded.stderr + loaded.stdout).toBe(1);
      expect(loaded.stderr + loaded.stdout).toContain(body.errors[0].message);
      const diagnostic = args[0] === "validate" ? JSON.parse(loaded.stdout).configError : loaded.stderr;
      expect(diagnostic).toContain('"boards"');
      expect(loaded.observed).toEqual([]);
      expect(existsSync(join(root, "jobs.db"))).toBe(false);
    }
    expect(readFileSync(path, "utf8")).toBe(handEdited);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
  });

  test(`invalid TypeScript boards prevent manual and contributed scheduled scrapes: ${invalid}`, async () => {
    const root = fixture(["remoteok", invalid]);
    const config = readFileSync(join(root, "brain.config.ts"), "utf8");
    for (const args of [["jobs", "scrape"], schedule.command.split(/\s+/)]) {
      const result = await scrape(root, args);
      expect(result.code, result.stderr + result.stdout).toBe(1);
      expect(result.stderr).toContain(invalid);
      expect(result.observed).toEqual([]);
      expect(existsSync(join(root, "jobs.db"))).toBe(false);
    }
    expect(readFileSync(join(root, "brain.config.ts"), "utf8")).toBe(config);
  });
}

for (const scenario of [
  { name: "omitted selection", configured: undefined, saved: undefined, expected: curated },
  { name: "JSON without boards", configured: ["workingnomads"], saved: { queries: ["fixture query"] }, expected: ["workingnomads"] },
  { name: "empty JSON overrides nonempty TypeScript", configured: ["workingnomads"], saved: { boards: [] }, expected: [] },
  { name: "empty TypeScript overrides defaults", configured: [], saved: undefined, expected: [] },
]) {
  test(`manual and contributed scheduled selection: ${scenario.name}`, async () => {
    const root = fixture(scenario.configured);
    const config = readFileSync(join(root, "brain.config.ts"), "utf8");
    if (scenario.saved) writeFileSync(join(root, "settings/jobs.json"), JSON.stringify(scenario.saved));
    const settings = await runCli(root, ["module", "settings", "jobs", "--json"]);
    expect(settings.code, settings.stderr + settings.stdout).toBe(0);
    expect(JSON.parse(settings.stdout).values.boards).toEqual(scenario.expected);
    for (const args of [["jobs", "scrape"], schedule.command.split(/\s+/)]) {
      const result = await scrape(root, args);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const report = JSON.parse(result.stdout).report;
      expect(report.sources.map((entry: { source: string }) => entry.source)).toEqual(scenario.expected);
      expect(result.observed).toEqual(scenario.expected);
      expect(report.total_errors).toEqual([]);
      if (!scenario.expected.length) expect(report).toEqual({ sources: [], dedup: { checked: 0, duplicates_found: 0 }, scored: 0, total_new: 0, total_errors: [] });
    }
    if (!scenario.expected.length) {
      const human = await scrape(root, ["jobs", "scrape"], false);
      expect(human.code, human.stderr + human.stdout).toBe(0);
      expect(human.stdout).toContain("no boards selected");
      expect(human.observed).toEqual([]);
    }
    expect(readFileSync(join(root, "brain.config.ts"), "utf8")).toBe(config);
  });
}

test("saving an intentional empty selection uses the shared writer and preserves TypeScript", async () => {
  const root = fixture(["workingnomads"]);
  initializeGit(root);
  const config = readFileSync(join(root, "brain.config.ts"), "utf8");
  const saved = await runCli(root, ["module", "settings", "jobs", "--set", "boards=[]", "--json"]);
  expect(saved.code, saved.stderr + saved.stdout).toBe(0);
  expect(JSON.parse(saved.stdout).values.boards).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, "settings/jobs.json"), "utf8")).boards).toEqual([]);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
  const result = await scrape(root, schedule.command.split(/\s+/));
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).report.sources).toEqual([]);
  expect(result.observed).toEqual([]);
  expect(readFileSync(join(root, "brain.config.ts"), "utf8")).toBe(config);
});

test("an intentionally empty scrape leaves an existing nonempty jobs database alone", async () => {
  const root = fixture([]);
  const path = join(root, "jobs.db");
  const db = openDatabase(path);
  ingestJobs(db, [
    { source: "remoteok", source_id: "fixture-1", title: "Senior Engineer", company: "Acme" },
    { source: "workingnomads", source_id: "fixture-2", title: "Senior Engineer", company: "Acme" },
  ]);
  const before = db.query("SELECT * FROM jobs ORDER BY id").all();
  expect(before).toHaveLength(2);
  db.close();
  const result = await scrape(root, ["jobs", "scrape"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).report).toEqual({ sources: [], dedup: { checked: 0, duplicates_found: 0 }, scored: 0, total_new: 0, total_errors: [] });
  expect(result.observed).toEqual([]);
  const after = openDatabase(path);
  try {
    expect(after.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(before);
    expect(after.query("SELECT * FROM scrape_runs").all()).toEqual([]);
  } finally { after.close(); }
});
