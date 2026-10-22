import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeJob, type TimingSnapshot } from "../scripts/ci-timings";

const repository = "odysseus/chronicle";
function fixture(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ci-timing-collection-"));
  const out = join(dir, "archive"), calls = join(dir, "calls");
  const ghFixture = fileURLToPath(new URL("./fixtures/ci-timings-gh.ts", import.meta.url));
  writeFileSync(join(dir, "gh"), `#!${process.execPath}\nimport ${JSON.stringify(ghFixture)};\n`, { mode: 0o755 });
  writeFileSync(join(dir, "git"), `#!${process.execPath}\nconsole.error("Reservation ref unavailable"); process.exit(1);\n`, { mode: 0o755 });
  symlinkSync(Bun.which("unzip")!, join(dir, "unzip"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const invoke = (args: readonly string[] = []) => Bun.spawnSync([process.execPath, process.env.TIMING_FIXTURE_COLLECTOR ?? "scripts/ci-timings.ts", "collect",
    "--repo", repository, "--since", "2026-07-12T00:00:00Z", "--out", out, ...args], {
    env: { ...process.env, PATH: dir, TIMING_FIXTURE: join(dir, "config.json"), TIMING_CALLS: calls },
    stdout: "pipe", stderr: "pipe", timeout: 30000 });
  return { dir, out, invoke,
    seed: (files: Record<string, unknown>) => {
      const source = join(dir, "seed"); mkdirSync(source);
      for (const [name, value] of Object.entries(files)) writeFileSync(join(source, name), JSON.stringify(value));
      const zip = join(dir, "seed.zip");
      const child = Bun.spawnSync([Bun.which("zip")!, "-q", zip, ...Object.keys(files)], { cwd: source, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, seedZip: zip }));
    },
    calls: () => readFileSync(calls, "utf8").trim().split("\n"),
    json: (file: string) => JSON.parse(readFileSync(join(out, file), "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("native collector stops at the hard request budget and archives the gap with exit zero", () => {
  const f = fixture({ count: 250 });
  try {
    const child = f.invoke();
    expect(f.calls()).toHaveLength(200);
    expect(child.exitCode).toBe(0);
    const collection = f.json("collection.json"), report = f.json("summary.json");
    expect(collection.requestBudget.requests).toBe(200);
    expect(collection.requestBudget.stopped).toContain("request limit");
    expect(collection.status).toBe("partial");
    expect(report.collectionCoverage.missingAttempts.length).toBeGreaterThan(0);
    expect(report.collectionCoverage.scopes[0].requestBudget.stopped).toContain("request limit");
    expect(f.calls().filter(p => p.includes("/logs"))).toEqual([]);
  } finally { f.cleanup(); }
});

test.each([{ remaining: 503, calls: 4 }, { remaining: 500, calls: 1 },
  { remaining: 1000, quotaDropAt: 2, calls: 2 }])("native collector preserves the quota reserve: %j", config => {
  const f = fixture(config);
  try {
    const child = f.invoke();
    expect(f.calls()).toHaveLength(config.calls);
    expect(child.exitCode).toBe(0);
    expect(f.json("collection.json").requestBudget.remaining).toBe(500);
    expect(f.json("collection.json").requestBudget.stopped).toContain("quota reserve 500");
    expect(f.json("collection.json").status).toBe("partial");
    expect(readFileSync(join(f.out, "summary.md"), "utf8")).toContain("budget stops: 1");
  } finally { f.cleanup(); }
});

test.each([{ rateLimitAt: 2 }, { badQuota: true }])("native collector stops without retry when quota is unavailable: %j", config => {
  const f = fixture(config);
  try {
    const child = f.invoke();
    expect(f.calls()).toHaveLength(config.rateLimitAt ?? 1);
    expect(child.exitCode).toBe(0);
    expect(f.json("collection.json").requestBudget.stopped).toMatch(/quota unavailable|rate limit response/);
    expect(f.json("collection.json").status).toBe("partial");
  } finally { f.cleanup(); }
});

test.each([{ count: 1, args: ["--resources", "--request-budget", "4"], limit: 4 },
  { count: 1, pullCount: 3, args: ["--request-budget", "7"], limit: 7 }])("logs and lifecycle requests share the collection budget: %j", config => {
  const f = fixture(config);
  try {
    const child = f.invoke(config.args);
    expect(f.calls()).toHaveLength(config.limit);
    expect(child.exitCode).toBe(0);
    expect(f.json("collection.json").requestBudget.requests).toBe(config.limit);
    expect(f.json("collection.json").status).toBe("partial");
    expect(f.calls().filter(p => p.includes("pulls?state="))).toHaveLength(config.pullCount ? 1 : 0);
    expect(f.calls().filter(p => p.includes("/logs"))).toEqual([]);
  } finally { f.cleanup(); }
});

function seededSnapshot(id: number): TimingSnapshot {
  const started = "2026-07-12T10:00:00Z";
  return { version: 1, repository, collectedAt: "2026-07-12T11:00:00Z", problems: [],
    run: { id, attempt: 1, head: "a".repeat(40), workflow: "CI", path: ".github/workflows/ci.yml", event: "pull_request",
      createdAt: started, startedAt: started, status: "completed", conclusion: "success", prs: [42], attribution: "run payload" },
    jobs: [normalizeJob({ id: id * 10 + 1, run_id: id, name: "unit", status: "completed", conclusion: "success",
      started_at: started, completed_at: "2026-07-12T10:01:00Z", steps: [{ name: "Unit proof", number: 1,
        status: "completed", conclusion: "success", started_at: started }] })] };
}

test("scheduled seeded collection fetches only new, incomplete and rerun attempts and reuses merged lifecycle data", () => {
  const f = fixture({ count: 3, rerun: true, pullCount: 1, headerlessDownloads: true });
  const incomplete = seededSnapshot(13); incomplete.jobs = []; incomplete.problems = ["jobs unavailable"];
  const old = seededSnapshot(15); old.run.createdAt = "2026-07-04T10:00:00Z";
  try {
    f.seed({ "run-12-attempt-1.json": seededSnapshot(12), "run-13-attempt-1.json": incomplete,
      "run-15-attempt-1.json": old,
      "pull-42.json": { version: 1, repository, number: 42, collectedAt: "2026-07-12T11:00:00Z",
        head: "a".repeat(40), merge: "b".repeat(40), createdAt: "2026-07-12T10:00:00Z", mergedAt: "2026-07-12T10:01:00Z",
        closedAt: "2026-07-12T10:01:00Z", baseBranch: "main", changedFiles: 1, additions: 1, deletions: 0, problems: [], timeline: [] } });
    const child = f.invoke(["--seed", "main", "--request-budget", "200", "--reserve", "500", "--reservations"]);
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
    expect(f.calls().filter(p => p.includes("/jobs?")).sort()).toEqual([
      "repos/odysseus/chronicle/actions/runs/12/attempts/2/jobs?per_page=100&page=1",
      "repos/odysseus/chronicle/actions/runs/13/attempts/1/jobs?per_page=100&page=1",
      "repos/odysseus/chronicle/actions/runs/14/attempts/1/jobs?per_page=100&page=1"]);
    expect(f.calls().filter(p => p.includes("pulls?state="))).toHaveLength(1);
    expect(f.calls().some(p => p.endsWith("pulls/42"))).toBe(false);
    expect(f.calls()).toHaveLength(10);
    expect(f.json("collection.json").seed).toEqual({ run: 99, artifact: 77, snapshots: 2, pulls: 1, error: null });
    expect(f.json("summary.json").coverage.runAttempts).toBe(4);
    expect(f.json("summary.json").coverage.incompleteAttempts).toBe(0);
    expect(f.json("summary.json").throughput.reservation).toBeNull();
    expect(existsSync(join(f.out, "run-15-attempt-1.json"))).toBe(false);
    const warm = f.invoke(["--seed", "main", "--request-budget", "200", "--reserve", "500", "--reservations"]);
    expect(warm.exitCode).toBe(0);
    expect(f.calls().slice(10)).toHaveLength(7);
    expect(f.calls().slice(10).some(p => p.includes("/jobs?") || p.includes("/logs"))).toBe(false);
  } finally { f.cleanup(); }
});

test("scheduled artifact seed requests count toward the hard limit", () => {
  const f = fixture({ count: 2, headerlessDownloads: true });
  try {
    f.seed({ "run-12-attempt-1.json": seededSnapshot(12) });
    const child = f.invoke(["--seed", "main", "--request-budget", "6", "--reserve", "500", "--reservations"]);
    expect(f.calls()).toHaveLength(6);
    expect(f.calls()[0]).toBe("rate_limit");
    expect(f.calls()[3]).toContain("actions/artifacts/77/zip");
    expect(child.exitCode).toBe(0);
    expect(f.json("collection.json").requestBudget.requests).toBe(6);
    expect(f.json("summary.json").coverage.incompleteAttempts).toBe(1);
    expect(f.json("run-13-attempt-1.json").problems[0]).toContain("TimingBudgetStop:");
  } finally { f.cleanup(); }
});

test("native discovery failure retains its fixed window and writes coverage instead of throwing past the archive", () => {
  const f = fixture({ discoveryFailure: true });
  try {
    const before = Date.now(), child = f.invoke();
    expect(existsSync(join(f.out, "collection.json"))).toBe(true);
    expect(child.exitCode).toBe(1);
    const c = f.json("collection.json");
    expect(c.errors.some((e: any) => e.error.includes("changing run inventory"))).toBe(true);
    expect(Date.parse(c.until)).toBeLessThanOrEqual(Date.now() - 15 * 60000);
    expect(Date.parse(c.until)).toBeGreaterThanOrEqual(before - 15 * 60000);
    expect(existsSync(join(f.out, "summary.json"))).toBe(true);
    expect(f.calls().some(p => p.includes("contract.yml"))).toBe(true);
  } finally { f.cleanup(); }
});

test("native reservation acquisition failure is a coverage gap and timing collection continues", () => {
  const f = fixture({ count: 1 });
  try {
    const child = f.invoke(["--reservations"]);
    expect(existsSync(join(f.out, "run-12-attempt-1.json"))).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(f.json("reservations.json").error).toContain("Reservation ref unavailable");
    const report = f.json("summary.json");
    expect(report.reservationAcquisition.scopes[0].error).toContain("Reservation ref unavailable");
    expect(report.reservationAcquisition.complete).toBe(false);
    expect(report.coverage.runAttempts).toBe(1);
  } finally { f.cleanup(); }
});
