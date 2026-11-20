/**
 * The cron runner gives a module job its GitHub relay (#4259) only for the
 * GitHub repositories the host granted it, for exactly the run's lifetime, and
 * records each relayed write on the job's Activity run. The worker is a stub
 * boundary that calls the relay the way a job inside the worker would; the
 * upstream is a loopback GitHub stand-in.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../src/cron/run-job.js";
import { createUiDb } from "../src/db/client.js";
import { parseModuleGitHubWrites } from "../src/github/module-relay.js";
import type { HostBoundary, BrainExecution } from "../src/brain/host-boundary.js";

const TOKEN = "odysseus-module-github-token";
let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ method: string; path: string; authorization: string | null }> = [];
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "odysseus-cron-github-"));
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push({ method: request.method, path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    return Response.json({ id: 1 });
  } });
});
afterAll(() => { upstream.stop(true); rmSync(dir, { recursive: true, force: true }); });

const JOB = { jobName: "beacon-run", command: ["brain", "beacon", "run"] };
const finished = () => ({ stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }),
  exited: Promise.resolve(0), settled: Promise.resolve(), signalCode: null, kill() {} });

test("a job granted a GitHub repository reaches its API through the run's relay, which records writes and ends with the run", async () => {
  const launched: BrainExecution[] = [];
  const statuses: number[] = [];
  const boundary = { isolated: () => true, brainPath: dir, launch: async (execution: BrainExecution) => {
    launched.push(execution);
    const socket = join(execution.githubRelay!, "github.sock");
    for (const [method, path, body] of [["GET", "/repos/ithaca/watchtower/issues", undefined], ["POST", "/repos/ithaca/watchtower/issues/7/comments", { body: "Why closed?" }]] as const) {
      const response = await fetch(`http://localhost${path}`, { method, unix: socket, ...(body ? { body: JSON.stringify(body) } : {}) } as RequestInit);
      statuses.push(response.status); await response.arrayBuffer();
    }
    return finished();
  } } as unknown as HostBoundary;
  const dbPath = join(dir, "ui.db");
  // The runner's own configuration never forwards the relay's token to a job.
  const { resolveCronConfig } = await import("../src/config/env.js");
  const config = resolveCronConfig({ BRAIN_PATH: dir, DB_PATH: dbPath, PATH: "/usr/bin:/bin", BRAIN_UI_MODULE_GITHUB_TOKEN: TOKEN,
    BRAIN_UI_SUBPROCESS_ENV_EXTRA: "BRAIN_UI_MODULE_GITHUB_TOKEN" }, ["BRAIN_UI_MODULE_GITHUB_TOKEN"]);
  expect(config.moduleGitHub.token(), "RUNNER_READS_TOKEN").toBe(TOKEN);
  expect(JSON.stringify(config.childEnv), "CHILD_ENV_HAS_NO_TOKEN").not.toContain(TOKEN);
  const code = await runJob({ ...JOB, dbPath, childEnv: config.childEnv, exec: {}, boundary,
    stdout: { write() {} }, stderr: { write() {} },
    repositories: async () => ({ ok: true, notes: [], repositories: [{ url: "https://github.com/ithaca/watchtower", mirror: join(dir, "mirror.git") },
      { url: "http://127.0.0.1:9/ithaca/harbor", mirror: join(dir, "harbor.git") }] }),
    githubRelay: { token: () => TOKEN, writes: parseModuleGitHubWrites("https://github.com/ithaca/watchtower#issue_comment").writes, origin: upstream.url.origin } },
  { sinkPath: join(dir, "sink.jsonl") });
  expect(code).toBe(0);
  expect(statuses, "JOB_REACHES_RELAY").toEqual([200, 200]);
  expect(seen.every(entry => entry.authorization === `Bearer ${TOKEN}`), "HOST_TOKEN_ADDED").toBe(true);
  expect(launched[0]!.env, "TOKEN_NOT_IN_JOB_ENV").not.toHaveProperty("BRAIN_UI_MODULE_GITHUB_TOKEN");
  expect(JSON.stringify(launched[0]!.env)).not.toContain(TOKEN);
  expect(existsSync(launched[0]!.githubRelay!), "RELAY_ENDS_WITH_RUN").toBe(false);
  const db = createUiDb(dbPath);
  try {
    const events = db.query("SELECT payload FROM activity_events WHERE event_type = 'github_write'").all() as { payload: string }[];
    expect(events.map(row => JSON.parse(row.payload).v), "WRITE_ON_ACTIVITY_RUN").toEqual([{ repository: "ithaca/watchtower", operation: "issue_comment", number: 7, status: 200 }]);
  } finally { db.close(); }
});

test("a job granted no GitHub repository gets no relay", async () => {
  const launched: BrainExecution[] = [];
  const boundary = { isolated: () => true, brainPath: dir, launch: async (execution: BrainExecution) => { launched.push(execution); return finished(); } } as unknown as HostBoundary;
  const code = await runJob({ ...JOB, dbPath: join(dir, "ui-none.db"), childEnv: { PATH: "/usr/bin:/bin" }, exec: {}, boundary,
    stdout: { write() {} }, stderr: { write() {} },
    repositories: async () => ({ ok: true, notes: [], repositories: [{ url: "http://127.0.0.1:9/ithaca/harbor", mirror: join(dir, "harbor.git") }] }),
    githubRelay: { token: () => TOKEN, writes: new Map() } }, { sinkPath: join(dir, "sink-none.jsonl") });
  expect(code).toBe(0);
  expect(launched[0]!.githubRelay, "NO_GITHUB_GRANT_NO_RELAY").toBeUndefined();
});
