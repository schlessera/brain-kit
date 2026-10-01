import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../../core/tests/cli-harness";
import { ADAPTERS } from "../src/scrape";
import { ALL_SOURCES } from "../src/types";

const curated = ["remoteok", "weworkremotely", "workingnomads", "remotelyde"];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

function fixture(moduleKey = "@schlessera/brain-module-jobs") {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  mkdirSync(join(root, "career"));
  writeFileSync(join(root, "career/criteria.md"), readFileSync(join(import.meta.dir, "fixtures/criteria.md"), "utf8"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { [moduleKey]: { criteria: "career/criteria.md" } } }));
  return root;
}

async function scrape(root: string, source?: string, direct = false) {
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "helpers/default-boards-preload.ts"), ...(direct
    ? [join(import.meta.dir, "helpers/default-boards-direct.ts")]
    : [BRAIN_BIN, "jobs", "scrape", "--json"])], {
    env: { ...keylessEnv(root), ...(source ? { JOBS_FIXTURE_SOURCE: source } : {}) }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr + stdout).toBe(0);
  const result = JSON.parse(stdout);
  return direct ? result : result.report;
}

test("direct runScrape without sources executes the same curated boards as the CLI", async () => {
  const root = fixture();
  const direct = await scrape(root, undefined, true);
  expect(direct.sources.map((entry: { source: string }) => entry.source)).toEqual(curated);
  const cli = await scrape(root);
  expect(cli.sources.map((entry: { source: string }) => entry.source)).toEqual(curated);
  for (const report of [direct, cli]) {
    expect(report.sources).toHaveLength(4);
    expect(report.sources.every((entry: { status: string }) => entry.status === "empty")).toBe(true);
    expect(report.total_errors).toEqual([]);
  }
});

test("every board policy names an actual adapter", () => {
  expect(ALL_SOURCES.length).toBeGreaterThan(0);
  expect(Object.keys(ADAPTERS)).toEqual([...ALL_SOURCES]);
});

test("fixture declarations contribute choices and on/off defaults without editing a selection list or UI", async () => {
  // Load an independent copy through the real module loader. Only the two
  // declarations and factories change; schema, CLI, settings and runner do not.
  const root = fixture("./modules/fixture-jobs");
  const source = join(root, "modules/fixture-jobs");
  cpSync(join(import.meta.dir, "../src"), source, { recursive: true });
  const policyPath = join(source, "boards.ts");
  writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace("export const JOB_BOARDS = [", `export const JOB_BOARDS = [
  { source: "fixture-on", defaultSelected: true },
  { source: "fixture-off", defaultSelected: false, caveat: "Fixture needs explicit selection" },`));
  const registryPath = join(source, "scrape.ts");
  writeFileSync(registryPath, readFileSync(registryPath, "utf8").replace("= {\n  remoteok:", `= {
  "fixture-on": () => Object.assign(new RemoteOKAdapter(), { source: "fixture-on" }),
  "fixture-off": () => Object.assign(new RemoteOKAdapter(), { source: "fixture-off" }),
  remoteok:`));
  const cli = await runCli(root, ["module", "settings", "jobs", "--json"]);
  expect(cli.code, cli.stderr + cli.stdout).toBe(0);
  const snapshot = JSON.parse(cli.stdout);
  expect(snapshot.values.boards).toEqual(["fixture-on", ...curated]);
  expect(snapshot.schema.properties.boards.default).toEqual(["fixture-on", ...curated]);
  const choices = snapshot.ui.fields.find((field: { key: string }) => field.key === "boards").options;
  expect(choices).toHaveLength(12);
  expect(choices.find((choice: { value: string }) => choice.value === "fixture-on").help).toBe("Selected by default");
  expect(choices.find((choice: { value: string }) => choice.value === "fixture-off").help).toBe("Not selected by default · Fixture needs explicit selection");
  for (const direct of [false, true]) {
    const report = await scrape(root, source, direct);
    expect(report.sources.map((entry: { source: string }) => entry.source)).toEqual(["fixture-on", ...curated]);
    expect(report.sources.every((entry: { status: string }) => entry.status === "empty")).toBe(true);
    expect(report.total_errors).toEqual([]);
  }
});
