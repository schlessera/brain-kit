/**
 * The runtime a scheduled `brain sync` ran (#290): both scheduling paths read
 * the CLI's `--json` result and record it on their own run's root span, in a
 * real activity store, and `/api/status` reads it back beside chat's.
 *
 * The brain CLI is a stand-in that prints whatever `scenario.json` beside it
 * says, so a test can change what the next sync reports between runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readSyncRuntime } from "../src/activity/sync-runtime";
import { createActivityStore, type ActivityStore, type SpanRow } from "../src/activity/store";
import { BrainSyncError, createBrainClient } from "../src/brain/client";
import { parseSyncResult, type BrainSyncOutput } from "../src/brain/sync-result";
import { SYNC_JOB_COMMAND } from "../src/cron/emit";
import { runJob } from "../src/cron/run-job";
import { createCronScheduler } from "../src/cron/scheduler";
import { createUiDb } from "../src/db/client";
import { createTestApp } from "./helpers/test-app";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Scenario {
  stdout: string;
  stderr?: string;
  exit: number;
}

/** A sync result, as `brain sync --json` prints it. */
function result(agent: BrainSyncOutput["agent"], status: BrainSyncOutput["run"]["status"] = "needs-judgment"): string {
  return JSON.stringify(
    { run: { status, report: `brain sync: ${status} — the report`, steps: [] }, agent },
    null,
    2
  );
}

const INVOKED_KNOWN = result({
  invoked: true,
  runner: "claude",
  outcome: "success",
  runtime: { name: "claude-code", version: "9.8.7-sync" },
  text: "the agent merged it",
});
const NOT_INVOKED = result({ invoked: false, reason: "not-needed" }, "complete");
const INVOKED_UNKNOWN = result({ invoked: true, runner: "codex", outcome: "success", runtime: null, text: "done" });
const FAILED_AFTER_INIT = result({
  invoked: true,
  runner: "claude",
  outcome: "failed",
  runtime: { name: "claude-code", version: "9.8.7-sync" },
  text: null,
  error: "claude CLI failed (exit 1): boom",
});

/**
 * A brain root whose CLI (`node_modules/.bin/brain`, also on `bin` for a
 * shell) records its argv and answers `sync` from the scenario file.
 */
function fakeBrain(): { root: string; bin: string; set(s: Scenario): void; argv(): string[][] } {
  const root = mkdtempSync(join(tmpdir(), "sync-runtime-"));
  roots.push(root);
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const scenario = join(root, "scenario.json");
  const argvLog = join(root, "argv.log");
  writeFileSync(
    join(bin, "brain"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "index") { console.log("indexed"); process.exit(0); }
const s = JSON.parse(readFileSync(${JSON.stringify(scenario)}, "utf8"));
if (s.stdout) process.stdout.write(s.stdout + "\\n");
if (s.stderr) process.stderr.write(s.stderr + "\\n");
process.exit(s.exit);
`
  );
  chmodSync(join(bin, "brain"), 0o755);
  return {
    root,
    bin,
    set: (s) => writeFileSync(scenario, JSON.stringify(s)),
    argv: () =>
      (existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line)),
  };
}

/** Every root span of the `sync` job, oldest first. */
function syncRoots(db: ReturnType<typeof createUiDb>, store: ActivityStore): SpanRow[] {
  const ids = db
    .query("SELECT span_id FROM activity_spans WHERE job_name = 'sync' AND parent_span_id IS NULL ORDER BY started_at")
    .all() as Array<{ span_id: string }>;
  return ids.map((r) => store.getSpan(r.span_id)!);
}

describe("BrainClient.sync reads the result", () => {
  test("asks for --json, and returns the readable message with the result", async () => {
    const brain = fakeBrain();
    brain.set({ stdout: INVOKED_KNOWN, exit: 0 });
    const synced = await createBrainClient({ brainPath: brain.root }).sync();

    expect(brain.argv()).toEqual([["sync", "--json"]]);
    expect(synced.message).toBe("brain sync: needs-judgment — the report\nthe agent merged it");
    expect(synced.result?.agent).toMatchObject({ invoked: true, runtime: { version: "9.8.7-sync" } });
  });

  test("a failure after init rejects, carrying the runtime it observed", async () => {
    const brain = fakeBrain();
    brain.set({ stdout: FAILED_AFTER_INIT, stderr: "claude CLI failed (exit 1): boom", exit: 2 });
    const error = await createBrainClient({ brainPath: brain.root }).sync().catch((e) => e);

    expect(error).toBeInstanceOf(BrainSyncError);
    expect(error.message).toBe("brain sync failed (exit 2): claude CLI failed (exit 1): boom");
    expect(error.result.agent.runtime).toEqual({ name: "claude-code", version: "9.8.7-sync" });
  });

  test("a malformed result never turns a failed sync into success, and claims no runtime", async () => {
    const brain = fakeBrain();
    brain.set({ stdout: '{"run": {"status": "complete"', exit: 1 });
    const error = await createBrainClient({ brainPath: brain.root }).sync().catch((e) => e);
    expect(error).toBeInstanceOf(BrainSyncError);
    expect(error.result).toBeUndefined();

    brain.set({ stdout: "Already in sync", exit: 0 });
    expect(await createBrainClient({ brainPath: brain.root }).sync()).toEqual({ message: "Already in sync" });
  });

  test("parseSyncResult refuses shapes that would misstate the agent", () => {
    const base = JSON.parse(INVOKED_KNOWN);
    const variants: unknown[] = [
      { ...base, agent: { ...base.agent, runner: undefined } },
      { ...base, agent: { ...base.agent, runtime: { name: "claude-code", version: 9 } } },
      { ...base, agent: { ...base.agent, runtime: { version: "9.8.7" } } },
      { ...base, agent: { invoked: false } },
      { ...base, agent: { invoked: "yes" } },
      { ...base, run: { ...base.run, status: "done" } },
      { agent: base.agent },
    ];
    for (const v of variants) expect(parseSyncResult(JSON.stringify(v))).toBeNull();
    expect(parseSyncResult(INVOKED_KNOWN)).not.toBeNull();
  });
});

describe("the in-process scheduler records the runtime on its run", () => {
  async function trigger(cron: ReturnType<typeof createCronScheduler>): Promise<void> {
    const before = cron.getCronStatus().find((j) => j.name === "sync")?.lastRunAt ?? null;
    expect(await cron.triggerJob("sync")).toBe(true);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const job = cron.getCronStatus().find((j) => j.name === "sync")!;
      if (job.lastRunAt !== before && job.lastStatus !== "running") return;
      if (Date.now() > deadline) throw new Error("sync did not settle");
      await Bun.sleep(10);
    }
  }

  test("each run keeps only its own observation, and status tells latest from last observed", async () => {
    const brain = fakeBrain();
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "server-test" });
    const cron = createCronScheduler({ db, brain: createBrainClient({ brainPath: brain.root }), activity: store });

    brain.set({ stdout: INVOKED_KNOWN, exit: 0 });
    await trigger(cron);
    await Bun.sleep(2); // distinct started_at
    brain.set({ stdout: NOT_INVOKED, exit: 0 });
    await trigger(cron);

    const [first, second] = syncRoots(db, store);
    expect(first!.outcome).toBe("success");
    expect(first!.attrs).toMatchObject({
      "brain.sync.agent": "invoked",
      "brain.runtime.name": "claude-code",
      "brain.runtime.version": "9.8.7-sync",
    });
    expect(second!.attrs["brain.sync.agent"]).toBe("not-invoked");
    expect(second!.attrs["brain.runtime.version"]).toBeUndefined();

    const status = readSyncRuntime(db);
    expect(status.latest).toMatchObject({ runId: second!.runId, agent: "not-invoked", runtime: null });
    expect(status.lastObserved).toMatchObject({
      runId: first!.runId,
      runtime: { name: "claude-code", version: "9.8.7-sync" },
      latestRun: false,
    });
  });

  test("a failure after init is an error run that keeps the observation", async () => {
    const brain = fakeBrain();
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "server-test" });
    const cron = createCronScheduler({ db, brain: createBrainClient({ brainPath: brain.root }), activity: store });

    brain.set({ stdout: FAILED_AFTER_INIT, stderr: "claude CLI failed (exit 1): boom", exit: 2 });
    await trigger(cron);

    expect(cron.getCronStatus().find((j) => j.name === "sync")!.lastStatus).toBe("error");
    const [run] = syncRoots(db, store);
    expect(run!.outcome).toBe("error");
    expect(run!.attrs).toMatchObject({ "brain.sync.agent_outcome": "failed", "brain.runtime.version": "9.8.7-sync" });
    expect(readSyncRuntime(db).lastObserved).toMatchObject({ runId: run!.runId, latestRun: true });
  });

  test("an unreadable result and an unknown version record no version", async () => {
    const brain = fakeBrain();
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "server-test" });
    const cron = createCronScheduler({ db, brain: createBrainClient({ brainPath: brain.root }), activity: store });

    brain.set({ stdout: "not a result", exit: 0 });
    await trigger(cron);
    await Bun.sleep(2);
    brain.set({ stdout: INVOKED_UNKNOWN, exit: 0 });
    await trigger(cron);

    const [unreadable, unknown] = syncRoots(db, store);
    expect(unreadable!.outcome).toBe("success");
    expect(unreadable!.attrs["brain.sync.agent"]).toBe("unknown");
    expect(unknown!.attrs).toMatchObject({ "brain.sync.agent": "invoked", "brain.sync.agent_runner": "codex" });
    expect(unknown!.attrs["brain.runtime.name"]).toBeUndefined();
    const status = readSyncRuntime(db);
    expect(status.latest).toMatchObject({ agent: "invoked", runtime: null });
    expect(status.lastObserved).toBeNull();
  });
});

describe("the container cron wrapper reads the sync job's result", () => {
  function sink() {
    let text = "";
    return { sink: { write: (t: string) => void (text += t) }, read: () => text };
  }

  async function wrap(
    brain: ReturnType<typeof fakeBrain>,
    dbPath: string,
    jobName: string,
    command: readonly string[]
  ) {
    const stdout = sink();
    const stderr = sink();
    const code = await runJob({
      jobName,
      command: [...command],
      dbPath,
      childEnv: { PATH: `${brain.bin}:${process.env.PATH}` },
      stdout: stdout.sink,
      stderr: stderr.sink,
    });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  }

  function dbFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "sync-runtime-db-"));
    roots.push(dir);
    return join(dir, "brain-ui.db");
  }

  test("the sync job: the runtime on its run, its report in the log, the reindex after", async () => {
    const brain = fakeBrain();
    const dbPath = dbFile();
    brain.set({ stdout: INVOKED_KNOWN, exit: 0 });
    const run = await wrap(brain, dbPath, "sync", SYNC_JOB_COMMAND);

    expect(run.code).toBe(0);
    expect(brain.argv()).toEqual([["sync", "--json"], ["index"]]);
    expect(run.stdout).toBe("brain sync: needs-judgment — the report\nthe agent merged it\n");
    expect(run.stderr).toContain("indexed");

    const db = createUiDb(dbPath);
    const store = createActivityStore(db, { writer: "reader" });
    const [root] = syncRoots(db, store);
    expect(root!.attrs).toMatchObject({ "brain.sync.agent": "invoked", "brain.runtime.version": "9.8.7-sync" });
    const output = db
      .query("SELECT payload FROM activity_events WHERE span_id = ? AND event_type = 'job_output'")
      .get(root!.spanId) as { payload: string };
    const logged = JSON.parse(output.payload).v as string;
    expect(logged).toContain("the agent merged it");
    expect(logged).not.toContain('"invoked"');
    db.close();
  });

  test("a failure after init: the child's exit code, and the observation kept", async () => {
    const brain = fakeBrain();
    const dbPath = dbFile();
    brain.set({ stdout: FAILED_AFTER_INIT, stderr: "claude CLI failed (exit 1): boom", exit: 2 });
    const run = await wrap(brain, dbPath, "sync", SYNC_JOB_COMMAND);

    expect(run.code).toBe(2);
    expect(brain.argv()).toEqual([["sync", "--json"]]);
    const db = createUiDb(dbPath);
    const [root] = syncRoots(db, createActivityStore(db, { writer: "reader" }));
    expect(root!.outcome).toBe("error");
    expect(root!.attrs).toMatchObject({ "brain.sync.agent_outcome": "failed", "brain.runtime.version": "9.8.7-sync" });
    db.close();
  });

  test("any other command's stdout is passed through and never read as a sync result", async () => {
    const brain = fakeBrain();
    const dbPath = dbFile();
    brain.set({ stdout: INVOKED_KNOWN, exit: 0 });
    // Same job name, a command this module did not emit; then another job.
    const handWritten = await wrap(brain, dbPath, "sync", ["brain", "sync", "--json"]);
    const other = await wrap(brain, dbPath, "maintain", ["brain", "sync", "--json"]);

    expect(handWritten.stdout).toBe(`${INVOKED_KNOWN}\n`);
    expect(other.stdout).toBe(`${INVOKED_KNOWN}\n`);
    const db = createUiDb(dbPath);
    const attrs = (db.query("SELECT attrs FROM activity_spans WHERE parent_span_id IS NULL").all() as Array<{
      attrs: string;
    }>).map((r) => JSON.parse(r.attrs));
    expect(attrs).toHaveLength(2);
    for (const a of attrs) {
      expect(a["brain.sync.agent"]).toBeUndefined();
      expect(a["brain.runtime.version"]).toBeUndefined();
    }
    db.close();
  });
});

describe("/api/status shows the sync runtime beside chat's", () => {
  test("a wrapper-recorded sync reaches the mounted status, apart from the chat runtime", async () => {
    const t = await createTestApp();
    try {
      const brain = fakeBrain();
      brain.set({ stdout: INVOKED_KNOWN, exit: 0 });
      const code = await runJob({
        jobName: "sync",
        command: [...SYNC_JOB_COMMAND],
        dbPath: t.dbPath,
        childEnv: { PATH: `${brain.bin}:${process.env.PATH}` },
        stdout: { write() {} },
        stderr: { write() {} },
      });
      expect(code).toBe(0);

      const body = await (await t.fetch("/api/status")).json();
      expect(body.runtime.sync.latest).toMatchObject({
        agent: "invoked",
        outcome: "success",
        runtime: { name: "claude-code", version: "9.8.7-sync" },
      });
      expect(body.runtime.sync.lastObserved).toMatchObject({
        runtime: { name: "claude-code", version: "9.8.7-sync" },
        latestRun: true,
      });
      expect(typeof body.runtime.sync.lastObserved.startedAt).toBe("string");
      // No chat turn ran: the sync's version is not presented as chat's.
      expect(body.runtime.lastObserved).toBeUndefined();
    } finally {
      await t.teardown();
    }
  });
});
