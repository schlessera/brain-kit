import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createActivityStore } from "../src/activity/store.js";
import type { ExecutionResult, HostBoundary } from "../src/brain/host-boundary.js";
import { createUiDb } from "../src/db/client.js";
import { createCronScheduler } from "../src/cron/scheduler.js";
import { emitCrontab, type BrainModuleListPayload } from "../src/cron/emit.js";
import {
  discoverModules,
  MODULE_DISCOVERY_JOB_NAME,
  MODULE_DISCOVERY_RETRY_DELAYS_MS,
  persistModuleDiscovery,
  readModuleList,
  type DiscoveryAttempt,
} from "../src/cron/module-discovery.js";

const MODULES: BrainModuleListPayload = {
  enabled: [{ name: "odysseus", key: "odysseus", description: null, types: [], commands: [],
    cron: [{ name: "beacon-run", schedule: "15 5 * * *", command: "odysseus beacon run" }] }],
  available: [],
};
const MODULE_LINE = "15 5 * * * root cd / && /absolute/brain-ui-cron run odysseus-beacon-run -- brain odysseus beacon run 2>&1 | logger -t brain-odysseus-beacon-run";
const SKIPPED_COMMENT = "# (brain module list unavailable — module cron skipped)";

function crontab(modules: BrainModuleListPayload | null): string {
  return emitCrontab({ modules, wrapperCommand: "/absolute/brain-ui-cron run", digestCommand: "/absolute/brain-ui-cron digest",
    pathLine: "PATH=/usr/bin:/bin", user: "root", legacyScraperPresent: false });
}

/** A host boundary that answers `brain module list` from a script of results. */
function scriptedBoundary(results: (ExecutionResult | Error)[]): HostBoundary & { calls: number } {
  const boundary = {
    calls: 0,
    async run() {
      const next = results[Math.min(boundary.calls, results.length - 1)];
      boundary.calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return boundary as unknown as HostBoundary & { calls: number };
}

const ok = (stdout: string): ExecutionResult => ({ stdout, stderr: "", exitCode: 0 });

let directory: string;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "brain-ui-cron-discovery-")); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("discoverModules", () => {
  test("a discovery that fails once and then succeeds emits the module job", async () => {
    const boundary = scriptedBoundary([
      { stdout: "", stderr: "native manager not ready yet\n", exitCode: 1 },
      ok(JSON.stringify(MODULES)),
    ]);
    const lines: string[] = [], slept: number[] = [];
    const outcome = await discoverModules({ attempt: () => readModuleList({}, boundary), report: line => lines.push(line),
      sleep: async ms => { slept.push(ms); } });

    expect(boundary.calls).toBe(2);
    expect(outcome).toEqual({ modules: MODULES, attempts: 2 });
    expect(slept).toEqual([MODULE_DISCOVERY_RETRY_DELAYS_MS[0]]);
    expect(lines).toEqual(["module discovery attempt 1 of 3 failed; retrying in 5s. brain module list exited 1; stderr: native manager not ready yet"]);
    const emitted = crontab(outcome.modules);
    expect(emitted, "CRON_DISCOVERY_RETRY_RECOVERS_MODULE_JOB").toContain(`${MODULE_LINE}\n`);
    expect(emitted).not.toContain(SKIPPED_COMMENT);
    // The successful crontab is byte-identical to one discovered first time.
    expect(emitted).toBe(crontab(MODULES));
  });

  test("a thrown attempt, such as a host that cannot be qualified yet, is retried", async () => {
    let calls = 0;
    const outcome = await discoverModules({ report: () => {}, sleep: async () => {}, attempt: async (): Promise<DiscoveryAttempt> => {
      calls += 1;
      if (calls === 1) throw new Error("native manager socket refused the connection");
      return { modules: MODULES };
    } });
    expect(outcome).toEqual({ modules: MODULES, attempts: 2 });
  });

  test("a persistent failure is bounded, names its cause and falls back to core jobs", async () => {
    const boundary = scriptedBoundary([{ stdout: "", stderr: "Error: cannot load brain.config.ts\n    at load (config.ts:12)\n", exitCode: 3 }]);
    const lines: string[] = [], slept: number[] = [];
    const outcome = await discoverModules({ attempt: () => readModuleList({}, boundary), report: line => lines.push(line),
      sleep: async ms => { slept.push(ms); } });

    expect(boundary.calls).toBe(MODULE_DISCOVERY_RETRY_DELAYS_MS.length + 1);
    expect(slept).toEqual([...MODULE_DISCOVERY_RETRY_DELAYS_MS]);
    const cause = "brain module list exited 3; stderr: Error: cannot load brain.config.ts | at load (config.ts:12)";
    expect(outcome).toEqual({ modules: null, attempts: 3, cause });
    expect(lines.at(-1), "CRON_DISCOVERY_FAILURE_NAMES_CAUSE").toBe(
      `module discovery unavailable; emitting core jobs only (module cron skipped after 3 attempts). ${cause}`);
    expect(lines.filter(line => line.includes("\n"))).toEqual([]);
    expect(crontab(outcome.modules)).toContain(`${SKIPPED_COMMENT}\n`);
  });

  test("a cause no retry can change stops after one attempt", async () => {
    const lines: string[] = [];
    let calls = 0;
    const outcome = await discoverModules({ report: line => lines.push(line), sleep: async () => { throw new Error("must not wait"); },
      attempt: async () => { calls += 1; return { modules: null, retryable: false, cause: "not configured" }; } });
    expect(calls).toBe(1);
    expect(outcome).toEqual({ modules: null, attempts: 1, cause: "not configured" });
    expect(lines).toEqual(["module discovery unavailable; emitting core jobs only (module cron skipped after 1 attempt). not configured"]);
  });
});

describe("readModuleList causes", () => {
  const cases: [string, ExecutionResult | Error, string][] = [
    ["empty stdout", ok("  \n"), "brain module list printed nothing"],
    ["non-JSON stdout", ok("Loading modules…"), "brain module list printed output that is not JSON"],
    ["a payload without the lists", ok("{\"enabled\":{}}"), "brain module list printed JSON without enabled and available lists"],
    ["a timed-out worker", { stdout: "", stderr: "", exitCode: 137, timedOut: true }, "brain module list timed out"],
    ["a launch failure", new Error("maintenance worker unavailable"), "brain module list could not run: maintenance worker unavailable"],
  ];
  for (const [name, result, cause] of cases) {
    test(`${name} names its cause`, async () => {
      expect(await readModuleList({}, scriptedBoundary([result]))).toEqual({ modules: null, cause, retryable: true });
    });
  }

  test("a long stderr keeps only its tail", async () => {
    const attempt = await readModuleList({}, scriptedBoundary([{ stdout: "", stderr: `${"x".repeat(2_000)}END`, exitCode: 1 }]));
    expect(attempt.modules).toBeNull();
    const cause = (attempt as { cause: string }).cause;
    expect(cause).toEndWith("xxEND");
    expect(cause.length).toBeLessThan(600);
  });
});

describe("persistModuleDiscovery", () => {
  function brainAndDb(name: string) {
    const root = join(directory, name), brainPath = join(root, "brain");
    mkdirSync(brainPath, { recursive: true });
    return { brainPath, dbPath: join(root, "brain-ui.db") };
  }

  test("a skipped module cron is recorded as an error in cron status and Activity", () => {
    const { brainPath, dbPath } = brainAndDb("skipped");
    const lines: string[] = [];
    const outcome = { modules: null, attempts: 3, cause: "brain module list exited 3" };
    expect(persistModuleDiscovery({ brainPath, dbPath, hostQualified: true, outcome, report: line => lines.push(line) })).toBe(true);
    expect(lines).toEqual([]);

    const db = createUiDb(dbPath);
    try {
      const status = createCronScheduler({ db, brain: {} as never }).getCronStatus().find(job => job.name === MODULE_DISCOVERY_JOB_NAME);
      expect(status?.lastStatus, "CRON_DISCOVERY_SKIP_IS_OPERATOR_VISIBLE").toBe("error");
      expect(status?.lastError).toBe("module cron skipped: brain module list exited 3");
      const store = createActivityStore(db);
      const spanId = (db.query("SELECT span_id FROM activity_spans WHERE job_name = ?").get(MODULE_DISCOVERY_JOB_NAME) as { span_id: string }).span_id;
      const span = store.getSpan(spanId);
      expect(span?.kind).toBe("cron");
      expect(span?.outcome).toBe("error");
      expect(span?.outcomeReason).toBe("module cron skipped: brain module list exited 3");
      expect(span?.attrs).toMatchObject({ "brain.module_discovery.attempts": 3, "brain.module_discovery.skipped": true });
    } finally { db.close(); }
  });

  test("a later successful discovery clears the signal", () => {
    const { brainPath, dbPath } = brainAndDb("recovered");
    persistModuleDiscovery({ brainPath, dbPath, hostQualified: true, outcome: { modules: null, attempts: 3, cause: "boom" }, report: () => {} });
    persistModuleDiscovery({ brainPath, dbPath, hostQualified: true, outcome: { modules: MODULES, attempts: 1 }, report: () => {} });
    const db = createUiDb(dbPath);
    try {
      const status = createCronScheduler({ db, brain: {} as never }).getCronStatus().find(job => job.name === MODULE_DISCOVERY_JOB_NAME);
      expect(status?.lastStatus).toBe("success");
      expect(status?.lastError).toBeNull();
    } finally { db.close(); }
  });

  test("an unqualified host never creates the UI database", () => {
    const { brainPath, dbPath } = brainAndDb("unqualified");
    expect(persistModuleDiscovery({ brainPath, dbPath, hostQualified: false, outcome: { modules: null, attempts: 1, cause: "x" }, report: () => {} })).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
    createUiDb(dbPath).close();
    expect(persistModuleDiscovery({ brainPath, dbPath, hostQualified: false, outcome: { modules: null, attempts: 1, cause: "x" }, report: () => {} })).toBe(true);
  });

  test("a database inside the brain or in memory is never written", () => {
    const { brainPath } = brainAndDb("inside");
    const inside = join(brainPath, "brain-ui.db"), lines: string[] = [];
    expect(persistModuleDiscovery({ brainPath, dbPath: inside, hostQualified: true, outcome: { modules: null, attempts: 1, cause: "x" }, report: line => lines.push(line) })).toBe(false);
    expect(existsSync(inside)).toBe(false);
    expect(lines[0]).toStartWith("module discovery outcome not recorded: ");
    expect(persistModuleDiscovery({ brainPath, dbPath: ":memory:", hostQualified: true, outcome: { modules: null, attempts: 1, cause: "x" }, report: () => {} })).toBe(false);
  });
});
