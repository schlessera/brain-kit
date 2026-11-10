import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main, parseArgs, type Io } from "../test-health";
import { LENS_IDS } from "../test-health/catalog";
import { doctor, type DoctorProbes } from "../test-health/doctor";
import type { Discover } from "../test-health/inventory";
import { scanSource } from "../test-health/signals";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

const OARS = "packages/ithaca/tests/oars.test.ts";
const SAILS = "packages/ithaca/tests/sails.test.ts";
const REEF = "packages/ithaca/tests/sails-reef.test.ts";
const SANDS = "packages/pylos/tests/sands.test.ts";
const OARS_SOURCE = 'export function oars(ship: string): number {\n  return ship === "Odysseus" ? 12 : 0;\n}\n';
const OARS_TEST = [
  'import { expect, test } from "bun:test";',
  'import { oars } from "../src/oars";',
  'test("counts the oars", () => { expect(oars("Odysseus")).toBeDefined(); });',
  "",
].join("\n");
const simple = (source: string, name: string, value: number) =>
  `import { expect, test } from "bun:test";\nimport { ${source} } from "../src/${source}";\ntest("${name}", () => { expect(${source}()).toBe(${value}); });\n`;

/** Bun tests of the fixture, discovered the way the product inventory would report them. */
const discover: Discover = root => {
  const files = Bun.spawnSync(["git", "ls-files"], { cwd: root, stdout: "pipe" }).stdout.toString().split("\n").filter(file => file.endsWith(".test.ts"));
  return files.map(file => {
    const scanned = scanSource(file, readFileSync(join(root, file), "utf8"));
    return { key: `bun::${file}`, file, domain: "unit", scenarios: scanned.tests, assertions: scanned.matchers, measuredSeconds: null };
  });
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-test-health-cli-"));
  scratch.push(dir);
  const root = join(dir, "repo"), ledger = join(dir, "ledger"), state = join(dir, "state");
  mkdirSync(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: ENV });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const write = (file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  git("init", "-q", "-b", "main");
  write("packages/ithaca/package.json", JSON.stringify({ name: "@schlessera/brain-ithaca" }));
  write("packages/pylos/package.json", JSON.stringify({ name: "@schlessera/brain-pylos" }));
  write("packages/ithaca/src/oars.ts", OARS_SOURCE);
  write("packages/ithaca/src/sails.ts", "export const sails = () => 1;\n");
  write("packages/pylos/src/sands.ts", "export const sands = () => 9;\n");
  write(OARS, OARS_TEST);
  write(SAILS, simple("sails", "sets the sail", 1));
  write(REEF, simple("sails", "reefs the sail", 1));
  write(SANDS, simple("sands", "counts the sands", 9));
  git("add", "-A");
  git("commit", "-q", "-m", "the fleet");

  let clock = Date.parse("2026-07-12T08:00:00Z"), runs = 0;
  const io = (out: string[]): Io => ({ root, now: () => new Date(clock), out: text => out.push(text), discover, bunCommand: ["bun", "test"],
    runId: () => `th-run-${++runs}` });
  /** Runs one command against the fixture's own ledger and state, offline. */
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const code = await main([...args, "--ledger-dir", ledger, "--state-dir", state, "--offline", "--base", "main"], io(out));
    const text = out.join("\n");
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* a brief is markdown */ }
    return { code, text, json };
  };
  const advance = (hours: number) => { clock += hours * 3_600_000; };
  return { root, state, git, write, cli, advance };
}

const cleanLenses = (overrides: Record<string, string> = {}) => Object.fromEntries(LENS_IDS.map(lens => [lens, overrides[lens] ?? "clean"]));

/** Takes the first planned cluster through a real fix, a real mutation receipt, a commit and its record. */
async function auditOars(f: ReturnType<typeof fixture>) {
  const plan = (await f.cli("plan")).json;
  f.git("switch", "-q", "-c", plan.batch.branch);
  await f.cli("measure", OARS, "--runs", "2", "--out", join(plan.runDir, "baseline-0.json"));
  f.write(OARS, OARS_TEST.replace("toBeDefined()", "toBe(12)"));
  f.git("add", "--", OARS);
  f.write("packages/ithaca/src/oars.ts", OARS_SOURCE.replace("12 : 0", "11 : 0"));
  const receipt = join(plan.runDir, "receipts", "F1.json");
  const mutation = await f.cli("mutate", "--test", OARS, "--expect", "Expected: 12", "--out", receipt, "--from-worktree", "packages/ithaca/src/oars.ts");
  f.git("commit", "-q", "-m", `test(ithaca): assert the oar count\n\nTest-Health: ${plan.runId}#0`);
  await f.cli("measure", OARS, "--runs", "2", "--out", join(plan.runDir, "after-0.json"));
  const worksheet = join(plan.runDir, "cluster-0.json");
  writeFileSync(worksheet, JSON.stringify({ schemaVersion: 1, runId: plan.runId, cluster: 0, seed: plan.clusters[0].seed,
    members: plan.clusters[0].members, context: [], measurements: { before: "baseline-0.json", after: "after-0.json" },
    audits: plan.clusters[0].members.map((file: string) => ({ file, lenses: cleanLenses(file === OARS ? { "cannot-fail": "findings" } : {}) })),
    findings: [{ id: "F1", file: OARS, test: "counts the oars", lens: "cannot-fail", smell: "weak-matcher", action: "strengthen", status: "fixed",
      note: "toBeDefined could not tell 12 oars from none; it now asserts the count", evidence: { mutation: "receipts/F1.json" } }] }));
  return { plan, mutation, worksheet, commit: f.git("rev-parse", "HEAD") };
}

describe("one run, end to end", () => {
  test("plan picks the package with the worst signals, opens its batch and claims its files", async () => {
    const f = fixture();
    const plan = (await f.cli("plan")).json;
    expect(plan).toMatchObject({ runId: "th-run-1", mode: "hot", package: "ithaca", throttled: null,
      batch: { id: "ithaca-th-run-1", branch: "test-health/ithaca-th-run-1", base: "main", isNew: true } });
    expect(plan.clusters).toEqual([{ index: 0, seed: OARS, members: [OARS] }, { index: 1, seed: REEF, members: [REEF, SAILS] }]);
    expect(existsSync(join(plan.runDir, "plan.json"))).toBe(true);
  });

  test("a second run while the first holds its claim takes other files, and an expired claim frees them", async () => {
    const f = fixture();
    await f.cli("plan");
    const second = (await f.cli("plan")).json;
    expect([second.package, second.clusters.map((cluster: any) => cluster.members), second.stats.claimed]).toEqual(["pylos", [[SANDS]], 3]);
    f.advance(4);
    const third = (await f.cli("plan", "--package", "ithaca")).json;
    expect(third.clusters.flatMap((cluster: any) => cluster.members).sort()).toEqual([OARS, REEF, SAILS]);
    // The open ithaca batch is continued rather than a second one opened.
    expect(third.batch).toMatchObject({ id: "ithaca-th-run-1", isNew: false });
  });

  test("a dry run plans without claiming or writing anything", async () => {
    const f = fixture();
    const dry = (await f.cli("plan", "--dry-run")).json;
    expect(existsSync(dry.runDir)).toBe(false);
    expect((await f.cli("plan")).json.stats.claimed).toBe(0);
  });

  test("the brief names the signal lines, the commit trailer and a worksheet skeleton that cannot be recorded as it stands", async () => {
    const f = fixture();
    const plan = (await f.cli("plan")).json;
    const brief = (await f.cli("brief", "--run", plan.runId, "--cluster", "0")).text;
    expect(brief).toContain(`### ${OARS}`);
    expect(brief).toContain("- signal weak-matcher x1: lines 3 (toBeDefined)");
    expect(brief).toContain("Commit trailer: `Test-Health: th-run-1#0`");
    const skeleton = (await f.cli("brief", "--run", plan.runId, "--cluster", "0", "--json")).json.skeleton;
    const path = join(plan.runDir, "cluster-0.json");
    writeFileSync(path, JSON.stringify(skeleton));
    const validation = await f.cli("validate", path, "--run", plan.runId);
    expect(validation.code).toBe(1);
    expect(validation.json.problems).toHaveLength(LENS_IDS.length);
  });

  test("a fix with a killed mutation is validated, recorded against its commit and counted", async () => {
    const f = fixture();
    const { plan, mutation, worksheet, commit } = await auditOars(f);
    expect([mutation.code, mutation.json.verdict]).toEqual([0, "killed"]);
    expect((await f.cli("validate", worksheet, "--run", plan.runId)).json).toEqual({ ok: true, problems: [] });
    expect((await f.cli("record", "cluster", "--run", plan.runId, "--cluster", "0", "--worksheet", worksheet, "--commit", commit)).json)
      .toEqual({ recorded: "th-run-1#0", files: 1, changed: 1, findings: 1, commit, tests: { before: 1, after: 1, declaredRemoved: 0 } });
    expect((await f.cli("record", "run", "--run", plan.runId, "--outcome", "completed", "--agent", "argus")).json).toMatchObject({ outcome: "completed", clusters: 1 });

    const report = (await f.cli("report", "--full")).json;
    expect(report.coverage).toMatchObject({ files: 4, auditedCurrent: 1, never: 3, share: 0.25 });
    expect(report.findings).toMatchObject({ total: 1, byLens: { "cannot-fail": 1 }, byStatus: { fixed: 1 } });
    expect(report.proof).toMatchObject({ mutationsKilled: 1, testsThatCouldNotFail: 1 });
    expect(report.accounting).toEqual({ testsBefore: 1, testsAfter: 1, declaredRemoved: 0, casesBefore: 1, casesAfter: 1, assertionsBefore: 1, assertionsAfter: 1 });
    expect(report.runs).toMatchObject({ total: 1, byAgent: { argus: 1 } });
    // The fix removed the weak matcher, and the run's snapshot shows it.
    expect(report.trend[0].signals["weak-matcher"]).toBeUndefined();
    expect(readFileSync(join(report.written, "report.md"), "utf8")).toContain("| Audited at their current content | 1 (25.0%) |");
  });

  test("a changed file cannot be recorded without its commit, nor against a commit that lacks the trailer", async () => {
    const f = fixture();
    const { plan, worksheet } = await auditOars(f);
    await expect(f.cli("record", "cluster", "--run", plan.runId, "--cluster", "0", "--worksheet", worksheet)).rejects.toThrow(`${OARS} changed but no --commit was given`);
    f.git("commit", "-q", "--allow-empty", "-m", "unrelated");
    await expect(f.cli("record", "cluster", "--run", plan.runId, "--cluster", "0", "--worksheet", worksheet, "--commit", "HEAD")).rejects.toThrow('lacks the trailer "Test-Health: th-run-1#0"');
  });

  test("a cluster that loses a test without declaring it cannot be recorded", async () => {
    const f = fixture();
    f.write(OARS, `${OARS_TEST}test("rows", () => { expect(oars("Odysseus")).toBe(12); });\n`);
    f.git("add", "-A"); f.git("commit", "-q", "-m", "two tests");
    const again = (await f.cli("plan")).json;
    expect(again.clusters[0].members).toEqual([OARS]);
    f.git("switch", "-q", "-c", again.batch.branch);
    await f.cli("measure", OARS, "--runs", "1", "--out", join(again.runDir, "before.json"));
    f.write(OARS, OARS_TEST); f.git("add", "-A");
    f.git("commit", "-q", "-m", `test: tidy\n\nTest-Health: ${again.runId}#0`);
    await f.cli("measure", OARS, "--runs", "1", "--out", join(again.runDir, "after.json"));
    const sheet = { schemaVersion: 1, runId: again.runId, cluster: 0, seed: OARS, members: [OARS], context: [],
      audits: [{ file: OARS, lenses: cleanLenses() }], findings: [] as unknown[], measurements: { before: "before.json", after: "after.json" } };
    const path = join(again.runDir, "cluster-0.json");
    writeFileSync(path, JSON.stringify(sheet));
    const record = () => f.cli("record", "cluster", "--run", again.runId, "--cluster", "0", "--worksheet", path, "--commit", "HEAD");
    await expect(record()).rejects.toThrow(`${OARS}: 1 test(s) disappeared without being declared: "rows"`);
    await expect(record()).rejects.toThrow("1 executed case(s) fewer than before, and the findings declare 0");
    writeFileSync(path, JSON.stringify({ ...sheet, measurements: undefined }));
    await expect(record()).rejects.toThrow("measurements.before and measurements.after must both measure it");
  });

  test("the batch ripens when its package is exhausted, passes the gate and is offered for landing", async () => {
    const f = fixture();
    const { plan, worksheet, commit } = await auditOars(f);
    await f.cli("record", "cluster", "--run", plan.runId, "--cluster", "0", "--worksheet", worksheet, "--commit", commit);
    const before = (await f.cli("batch", "status")).json;
    expect(before).toMatchObject({ land: null, parkedChangedFiles: 1 });
    expect(before.batches[0]).toMatchObject({ batchId: plan.batch.id, ripe: false, changedFiles: 1, remainingInPackage: 2 });

    const clean = join(plan.runDir, "cluster-1.json");
    writeFileSync(clean, JSON.stringify({ schemaVersion: 1, runId: plan.runId, cluster: 1, seed: REEF, members: [REEF, SAILS], context: [],
      audits: [REEF, SAILS].map(file => ({ file, lenses: cleanLenses() })), findings: [] }));
    expect((await f.cli("record", "cluster", "--run", plan.runId, "--cluster", "1", "--worksheet", clean)).json).toMatchObject({ files: 2, changed: 0 });
    await f.cli("record", "run", "--run", plan.runId, "--outcome", "completed", "--agent", "argus");

    const after = (await f.cli("batch", "status")).json;
    expect(after.batches[0]).toMatchObject({ ripe: true, reasons: ["nothing left to audit in its package"], remainingInPackage: 0 });
    expect(after.land).toBe(plan.batch.id);
    const gate = await f.cli("batch", "verify", "--head", "HEAD");
    expect([gate.code, gate.json.ok, gate.json.stats.commits]).toEqual([0, true, 1]);

    await f.cli("record", "batch", "--batch", plan.batch.id, "--event", "pr", "--pr", "4242");
    expect((await f.cli("batch", "status")).json.landingSlot.open).toBe(false);
    await f.cli("record", "batch", "--batch", plan.batch.id, "--event", "landed", "--merge-sha", commit);
    expect((await f.cli("report")).json.batches).toMatchObject({ open: 0, landed: 1, meanFilesPerLanded: 1 });
  });

  test("the gate refuses a batch whose commit changes product code, with a failing exit code", async () => {
    const f = fixture();
    const { plan, worksheet, commit } = await auditOars(f);
    await f.cli("record", "cluster", "--run", plan.runId, "--cluster", "0", "--worksheet", worksheet, "--commit", commit);
    f.write("packages/ithaca/src/sails.ts", "export const sails = () => 2;\n");
    f.git("add", "-A");
    f.git("commit", "-q", "-m", `fix sails\n\nTest-Health: ${plan.runId}#0`);
    const gate = await f.cli("batch", "verify", "--head", "HEAD");
    expect(gate.code).toBe(1);
    expect(gate.json.violations).toEqual(["packages/ithaca/src/sails.ts: outside test code; a product or tooling change is filed, not made here"]);
  });

  test("dropping a commit from a batch withdraws its audit, so the rotation offers the file again", async () => {
    const f = fixture();
    const { plan, worksheet, commit } = await auditOars(f);
    await f.cli("record", "cluster", "--run", plan.runId, "--cluster", "0", "--worksheet", worksheet, "--commit", commit);
    await f.cli("record", "run", "--run", plan.runId, "--outcome", "completed");
    expect((await f.cli("report")).json.coverage.auditedCurrent).toBe(1);
    const dropped = (await f.cli("record", "batch", "--batch", plan.batch.id, "--event", "dropped", "--commit", commit.slice(0, 12), "--reason", "failed in hosted proof")).json;
    expect(dropped.voidedClusters).toEqual(["th-run-1#0"]);
    expect((await f.cli("report")).json).toMatchObject({ coverage: { auditedCurrent: 0 }, batches: { droppedCommits: 1 } });
    await expect(f.cli("record", "batch", "--batch", plan.batch.id, "--event", "dropped", "--commit", "0000000")).rejects.toThrow("No recorded cluster");
  });
});

describe("output an agent pays for", () => {
  test("a command prints one line holding what the next step needs, and writes the detail to its file", async () => {
    const f = fixture();
    const out = join(f.state, "baseline.json");
    const brief = await f.cli("measure", OARS, "--runs", "2", "--out", out);
    expect(brief.text.split("\n")).toHaveLength(1);
    expect(brief.json.files).toEqual([{ file: OARS, verdict: "stable", runs: 2, failures: 0, medianMs: expect.any(Number),
      slowestCases: [{ name: "counts the oars", medianMs: expect.any(Number) }] }]);
    const detail = JSON.parse(readFileSync(out, "utf8"));
    expect(Object.keys(detail.files[0]).sort()).toEqual(["cases", "failingCases", "failures", "file", "maxMs", "medianMs", "minMs", "runs", "skippedCases", "slowestCases", "variants", "verdict", "zeroAssertionCases"]);
    expect(detail.files[0].cases).toEqual([{ name: "counts the oars", state: "passed", assertions: 1 }]);
    expect((await f.cli("measure", OARS, "--runs", "2", "--full")).json.files[0].variants).toEqual({ repeat: { runs: 2, failures: 0 } });
  });

  test("the report's default output leaves the trend and the breakdowns in its files", async () => {
    const f = fixture();
    const short = (await f.cli("report")).json;
    expect(Object.keys(short).sort()).toEqual(["accounting", "batches", "coverage", "findings", "proof", "published", "refind", "runs", "written"]);
    expect(Object.keys((await f.cli("report", "--full")).json)).toContain("trend");
    expect(JSON.parse(readFileSync(join(short.written, "metrics.json"), "utf8")).schemaVersion).toBe(1);
  });

  test("--pretty indents for a human reader", async () => {
    const f = fixture();
    expect((await f.cli("inventory", "--pretty")).text).toContain('\n  "files": 4');
  });
});

describe("scaling out", () => {
  test("shards are written as work lists, and a run given one stays inside it and names its batch after it", async () => {
    const f = fixture();
    const out = join(f.state, "shards");
    const shards = (await f.cli("shards", "--count", "2", "--tag", "e9", "--out", out)).json.shards;
    // The count is a target: a package with more than its share of the work is split, and each package keeps its own shard.
    expect(shards.map((shard: any) => [shard.id, shard.package, shard.files])).toEqual([["e9-ithaca-01", "ithaca", 2], ["e9-ithaca-02", "ithaca", 1], ["e9-pylos-01", "pylos", 1]]);
    const plan = (await f.cli("plan", "--shard", join(out, "e9-pylos-01.json"), "--profile", "push")).json;
    expect(plan).toMatchObject({ profile: "push", package: "pylos", batch: { id: "e9-pylos-01", branch: "test-health/e9-pylos-01", isNew: true } });
    expect(plan.clusters.map((cluster: any) => cluster.members)).toEqual([[SANDS]]);
    // A second worker on the same shard continues its batch and finds the files claimed.
    const again = (await f.cli("plan", "--shard", join(out, "e9-pylos-01.json"), "--profile", "push")).json;
    expect([again.clusters, again.stats.claimed]).toEqual([[], 1]);
  });

  test("case durations from downloaded CI artifacts reach the brief", async () => {
    const f = fixture();
    const artifacts = join(f.state, "artifacts", "unit-proof-1", "tmp");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "unit-report.xml"), `<testsuites><testsuite name="${OARS}" file="${OARS}">`
      + `<testcase name="counts the oars" classname="" time="2.5" file="${OARS}" line="3" assertions="1" /></testsuite></testsuites>`);
    expect((await f.cli("costs", "ingest", "--artifacts", join(f.state, "artifacts"))).json).toEqual({ reports: 1, cases: 1, files: 1 });
    const plan = (await f.cli("plan")).json;
    expect((await f.cli("brief", "--run", plan.runId, "--cluster", "0")).text).toContain("- slow case 2500 ms: counts the oars");
  });
});

describe("command line and preflight", () => {
  test("flags take inline or following values, and --from-worktree takes every path up to the next flag", () => {
    const parsed = parseArgs(["mutate", "--test=a.test.ts", "--expect", "Expected: 12", "--from-worktree", "src/a.ts", "src/b.ts", "--offline"]);
    expect([parsed.positional, [...parsed.flags], [...parsed.lists]]).toEqual([["mutate"],
      [["test", "a.test.ts"], ["expect", "Expected: 12"], ["offline", true]], [["from-worktree", ["src/a.ts", "src/b.ts"]]]]);
    expect(() => parseArgs(["plan", "--base"])).toThrow("--base needs a value");
  });

  test("an unknown command is an error, not a silent success", async () => {
    const f = fixture();
    await expect(f.cli("audit-everything")).rejects.toThrow("Unknown command: audit-everything");
  });

  const probes = (overrides: Partial<Record<string, number>> = {}, freeGiB = 100, red = false): DoctorProbes => ({
    bunVersion: "1.4.2",
    run: command => {
      const key = command.slice(0, 2).join(" ");
      return { exitCode: overrides[key] ?? 0, stdout: key === "bun scripts/integrate.ts" ? JSON.stringify({ red }) : "" };
    },
    disk: () => ({ freeBytes: freeGiB * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }),
    exists: () => true,
  });

  test("a healthy checkout may audit and land", () => {
    expect(doctor("/ithaca", probes())).toMatchObject({ ok: true, capabilities: { github: true, browserRunner: true, mayLand: true } });
  });

  test("a nearly full disk blocks the run", () => {
    const result = doctor("/ithaca", probes({}, 4));
    expect([result.ok, result.checks.find(check => check.name === "disk")?.ok]).toEqual([false, false]);
  });

  test("a red main, no Docker and no GitHub limit the run without blocking it", () => {
    expect(doctor("/ithaca", probes({}, 100, true))).toMatchObject({ ok: true, capabilities: { mayLand: false } });
    expect(doctor("/ithaca", probes({ "docker info": 1 }))).toMatchObject({ ok: true, capabilities: { browserRunner: false, mayLand: true } });
    expect(doctor("/ithaca", probes({ "gh auth": 1 }))).toMatchObject({ ok: true, capabilities: { github: false, mayLand: false } });
  });

  test("a Bun older than the suite supports blocks the run", () => {
    expect(doctor("/ithaca", { ...probes(), bunVersion: "1.3.14" }).ok).toBe(false);
  });
});
