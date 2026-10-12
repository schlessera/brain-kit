/**
 * #1648: no host process evaluates repository code, runs git or runs the
 * `brain` CLI against a brain a governed turn can write. Each test plants a
 * brain-supplied input that writes a host sentinel when it is evaluated, then
 * drives the server path that evaluates it: the application route's capture
 * plan and index, a server-spawned index refresh and sync, a `bunfig.toml`
 * preload and an `.env`, and a git commit through a symlinked ref. The
 * sentinel sits outside the brain, below a directory the maintenance worker
 * masks, so a host evaluation creates it and a worker evaluation cannot. Each
 * planted input also leaves a proof inside the brain that it did run, so a
 * missing sentinel is never a test that ran nothing.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { probeWorkerHost } from "@schlessera/brain-ui-sdk/internal";
import type { SystemStatus } from "@schlessera/brain-ui-sdk/protocol";
import { boundaryPlanner, createBrainApplication } from "../src/brain/application";
import { createBrainClient } from "../src/brain/client";
import { createHostBoundary, hostExecution } from "../src/brain/host-boundary";
import { createGovernedManifests } from "../src/brain/governed-manifest";
import { createHostExecution, quarantineDirFor } from "../src/brain/host-execution";
import { runJob } from "../src/cron/run-job";
import { SYNC_JOB_COMMAND } from "../src/cron/emit";
import { createUiDb } from "../src/db/client";
import { createWriterGate } from "../src/brain/writer-gate";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createApp, type CreateAppOptions } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";

const ROOT = resolve(import.meta.dir, "../../..");
const CORPUS = join(ROOT, "packages/core/fixtures/corpus");
const CORE = join(ROOT, "packages/core/src/index.ts");
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

/** Whether this host runs the worker boundary at all; every test here needs it. */
let supported = false;
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const probe = mkdtempSync(join(ROOT, "tmp/host-boundary-probe-"));
  try { supported = probeWorkerHost(probe).ok; } finally { rmSync(probe, { recursive: true, force: true }); }
  if (!supported && process.env.CI) throw new Error("CI must run the worker boundary for the host execution proof");
});

/**
 * A corpus brain under the repository's `tmp/`, which sits below `/home` or
 * another masked directory on every supported host… or not: the sentinel
 * directory is passed to every worker as an extra mask, so the proof holds
 * wherever the checkout lives.
 */
function fixture(options: { config?: boolean | "plain" } = {}) {
  const root = mkdtempSync(join(ROOT, "tmp/host-boundary-"));
  roots.push(root);
  const brain = join(root, "brain");
  const outside = join(root, "outside");
  mkdirSync(outside);
  cpSync(CORPUS, brain, { recursive: true });
  const sentinel = join(outside, "host-sentinel");
  const proof = join(brain, "evaluated.log");
  const config = join(brain, "brain.config.ts");
  if (options.config === false) rmSync(config);
  else {
    writeFileSync(join(brain, "helper.ts"), helperSource(sentinel, proof, "config-helper"));
    // "plain": a config the stand-in CLI below can evaluate without core.
    writeFileSync(config, `import "./helper.ts";\n${options.config === "plain" ? "export default {};\n"
      : readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(CORE))}`);
  }
  return { root, brain, outside, sentinel, proof };
}

/** Writes the host sentinel, then records in the brain whether it could see it: only a worker's private view can. */
function helperSource(sentinel: string, proof: string, label: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
try { mkdirSync(dirname(${JSON.stringify(sentinel)}), { recursive: true }); writeFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(label)}); } catch {}
// A read-only view of the brain (the worker host probe's) records nothing.
try { appendFileSync(process.env.BRAIN_WORKER_DATA_ROOT ? process.env.BRAIN_WORKER_DATA_ROOT + "/evaluated.log" : ${JSON.stringify(proof)}, ${JSON.stringify(label)} + " ran; dotenv=" + (process.env.BRAIN_DOTENV_MARK ?? "unset") + "; sentinel " + (existsSync(${JSON.stringify(sentinel)}) ? "written" : "refused") + "\\n"); } catch {}
`;
}

/** A `brain` CLI in the brain that evaluates its config, as the real one does, then answers like `brain`. */
function installCli(brain: string, body = "") {
  const bin = join(brain, "node_modules/.bin/brain");
  mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== "--version") await import(process.cwd() + "/brain.config.ts");
${body}
if (args[0] === "--version") console.log("0.42.0");
else if (args[0] === "stats") console.log(JSON.stringify({ documents: 1 }));
else if (args[0] === "search") console.log(JSON.stringify({ results: [], warnings: [] }));
else console.log("{}");
`);
  chmodSync(bin, 0o755);
}

/** Every evaluation's proof line, and no host sentinel. */
function evaluatedOnlyInWorkers(f: ReturnType<typeof fixture>, label: string) {
  expect(existsSync(f.sentinel), "HOST_SENTINEL_ABSENT: the brain-supplied code never ran on the host").toBe(false);
  expect(readdirSync(f.outside), "nothing was created outside the brain").toEqual([]);
  const lines = readFileSync(f.proof, "utf8").trim().split("\n");
  expect(lines.length, `${label} ran at least once`).toBeGreaterThan(0);
  for (const line of lines) expect(line, "each evaluation saw its own private view of the sentinel").toMatch(/sentinel written$/);
  return lines;
}

/** A real app on this brain and database, with a fake agent backend so no agent runtime is probed. */
function bootApp(brain: string, dbPath: string, options: Pick<CreateAppOptions, "versionRequirements"> = {}) {
  return createApp({ ...options,
    config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: dbPath, BRAIN_PATH: brain, BRAIN_UI_PRICING_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]) });
}

/** Masks the sentinel's directory too, so the proof does not depend on where the checkout lives. */
function boundaryFor(brain: string, outside: string) {
  return createHostBoundary({ brainPath: brain, dbPath: join(outside, "brain-ui.db") });
}

describe("the host execution boundary (#1648)", () => {
  test("a capture applied through the route plans and indexes in a worker: the config's helper never runs on the host", async () => {
    if (!supported) return;
    const f = fixture();
    const boundary = boundaryFor(f.brain, f.outside);
    expect(boundary.isolated(), "the boundary holds on a host that can run a governed turn").toBe(true);
    const apply = createBrainApplication({ root: f.brain, principalId: "owner", turnId: "turn-1", signal: new AbortController().signal,
      policy: { autoAllowed: ["add"], available: ["add"], lock: createKeyedLock() }, isAuthorized: () => true,
      approve: async () => true, record: () => {}, planner: boundaryPlanner(boundary) });
    const result = await apply({ principalId: "owner", turnId: "turn-1",
      input: { operation: "add", content: "Penelope weaves by day and unpicks by night.", title: "Loom", type: "note" } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.indexed, JSON.stringify(result)).toBe(true);
    const lines = evaluatedOnlyInWorkers(f, "the config helper");
    expect(lines.length, "planning and indexing each evaluated the config").toBeGreaterThanOrEqual(2);
    const written = result.changes[0]!.path;
    expect(readFileSync(join(f.brain, written), "utf8")).toContain("Penelope weaves by day");
  }, 120_000);

  test("a server-spawned index refresh and sync evaluate the config in workers", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    installCli(f.brain);
    const brain = createBrainClient({ brainPath: f.brain, exec: {}, boundary: boundaryFor(f.brain, f.outside) });
    await brain.index();
    await brain.sync();
    const lines = evaluatedOnlyInWorkers(f, "the config helper");
    expect(lines.length, "index and sync each evaluated the config").toBe(2);
  }, 60_000);

  test("a bunfig.toml preload and an .env the brain holds never load into a host process", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    installCli(f.brain);
    writeFileSync(join(f.brain, "preload.ts"), helperSource(f.sentinel, f.proof, "bunfig-preload"));
    writeFileSync(join(f.brain, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(f.brain, ".env"), "BRAIN_DOTENV_MARK=from-the-brain\n");
    const brain = createBrainClient({ brainPath: f.brain, exec: {}, boundary: boundaryFor(f.brain, f.outside) });
    // A credential-free reader, then a credentialed one.
    await brain.stats();
    await brain.search("loom");
    const lines = evaluatedOnlyInWorkers(f, "the preload");
    const preloads = lines.filter(line => line.startsWith("bunfig-preload"));
    expect(preloads.length, "the preload ran in both workers").toBe(2);
    // The credential-free worker cannot read the brain's .env; the credentialed one loads it, inside the worker.
    expect(preloads.map(line => line.match(/dotenv=(\S+);/)?.[1])).toEqual(["unset", "from-the-brain"]);
  }, 60_000);

  test("a symlinked refs/heads cannot make a sync's commit write outside the brain", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args],
      { cwd: f.brain, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
    // The attack a governed turn could stage: the branch ref directory now lives outside the brain.
    rmSync(join(f.brain, ".git/refs/heads"), { recursive: true, force: true });
    const refs = join(f.outside, "refs");
    mkdirSync(refs);
    symlinkSync(refs, join(f.brain, ".git/refs/heads"));
    installCli(f.brain, `if (args[0] === "sync") {
  const run = cmd => Bun.spawnSync(["git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...cmd], { cwd: process.env.BRAIN_WORKER_DATA_ROOT ?? process.cwd(), stdout: "ignore", stderr: "pipe" });
  run(["add", "-A"]);
  const commit = run(["commit", "-q", "-m", "Harbor log"]);
  await Bun.write((process.env.BRAIN_WORKER_DATA_ROOT ?? process.cwd()) + "/commit.log", "exit " + commit.exitCode + "\\n" + commit.stderr.toString());
}`);
    const brain = createBrainClient({ brainPath: f.brain, exec: {}, boundary: boundaryFor(f.brain, f.outside) });
    await brain.sync();
    expect(readFileSync(join(f.brain, "commit.log"), "utf8"), "the commit ran, in the worker").toMatch(/^exit /);
    expect(readdirSync(refs), "REF_OUTSIDE_UNCHANGED: no branch ref was written outside the brain").toEqual([]);
    expect(existsSync(f.sentinel)).toBe(false);
  }, 60_000);
});

describe("what the brain cannot use to open the boundary (#1648 review)", () => {
  test("a bunfig.toml preload that fails cannot fail the worker host probe and hand the brain's code back to the host", () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    writeFileSync(join(f.brain, "preload.ts"), "process.exit(42);\n");
    writeFileSync(join(f.brain, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(f.brain, ".env"), "NODE_OPTIONS=--definitely-not-an-option\n");
    expect(probeWorkerHost(f.brain), "PROBE_IGNORES_BRAIN_STARTUP").toEqual({ ok: true });
    expect(boundaryFor(f.brain, f.outside).isolated()).toBe(true);
  });

  test("governed needs a maintenance worker that starts, network namespace included", () => {
    const f = fixture({ config: "plain" });
    const maintenance = spyOn(hostExecution, "maintenanceProbe").mockReturnValue({ ok: false, requirement: "network namespaces are denied" });
    try {
      const boundary = createHostBoundary({ brainPath: f.brain, workerHost: () => ({ ok: true }) });
      expect(boundary.governed(), "MAINTENANCE_PROBED").toEqual({ available: false, reason: "worker_host_unavailable", detail: "network namespaces are denied" });
    } finally { maintenance.mockRestore(); }
  });

  test("at boot the CLI version probe meets the writer gate a cron job holds", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    installCli(f.brain);
    const dbPath = join(f.root, "db/brain-ui.db");
    mkdirSync(join(f.root, "db"));
    const cron = createUiDb(dbPath);
    try {
      const sync = await createWriterGate(cron, f.brain).acquire("exclusive", "cron sync");
      let booted = false;
      const app = bootApp(f.brain, dbPath, { versionRequirements: { brainCli: "0.1.0" } }).then(a => { booted = true; return a; });
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(booted, "BOOT_PROBE_GATED").toBe(false);
      sync.release();
      await (await app).close();
    } finally { cron.close(); }
  }, 60_000);

  test("a reader runs beside turns but never beside an exclusive holder", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    installCli(f.brain);
    const dbPath = join(f.root, "db/brain-ui.db");
    mkdirSync(join(f.root, "db"));
    const execution = createHostExecution({ brainPath: f.brain, dbPath, exec: {} });
    const db = createUiDb(dbPath);
    try {
      execution.attach(db);
      const brain = createBrainClient({ brainPath: f.brain, exec: {}, boundary: execution.boundary });
      const sync = await execution.gate()!.acquire("exclusive", "brain sync");
      let read = false;
      const stats = brain.stats().then(result => { read = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(read, "READER_GATED: a reader's read-write worker waits for the exclusive holder").toBe(false);
      sync.release();
      expect(await stats as unknown).toEqual({ documents: 1 });
    } finally { db.close(); }
  }, 60_000);

  test("an .env that links to a host file is covered in a credential-free worker", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    const secret = mkdtempSync("/var/tmp/brain-boundary-secret-");
    roots.push(secret);
    writeFileSync(join(secret, "credentials"), "BRAIN_DOTENV_MARK=host-secret\n");
    rmSync(join(f.brain, ".env"), { force: true });
    symlinkSync(join(secret, "credentials"), join(f.brain, ".env"));
    const program = `const fs = require("fs"); let read; try { read = fs.readFileSync(${JSON.stringify(join(f.brain, ".env"))}, "utf8"); } catch (e) { read = e.code; }
      console.log(JSON.stringify({ read, loaded: process.env.BRAIN_DOTENV_MARK ?? null }));`;
    const result = await boundaryFor(f.brain, f.outside).run({ argv: ["bun", "-e", program], env: { PATH: process.env.PATH },
      credentials: false, gate: "none", purpose: "test" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout), "ENV_LINK_COVERED").toEqual({ read: "EACCES", loaded: null });
  });
});

describe("cron jobs (#1648)", () => {
  test("a scheduled sync runs in a worker, waits for the writer gate a turn holds, and its config helper never runs on the host", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    installCli(f.brain);
    const dbPath = join(f.root, "db/brain-ui.db");
    mkdirSync(join(f.root, "db"));
    const execution = createHostExecution({ brainPath: f.brain, dbPath, exec: {}, requireGate: true });
    const db = createUiDb(dbPath);
    try {
      execution.attach(db);
      expect(execution.boundary.isolated()).toBe(true);
      const turn = await execution.gate()!.acquire("shared", "governed turn");
      const out: string[] = [];
      let done = false;
      const job = runJob({ jobName: "sync", command: [...SYNC_JOB_COMMAND], dbPath, childEnv: { PATH: process.env.PATH }, exec: {},
        brainPath: f.brain, boundary: execution.boundary, stdout: { write: text => out.push(text) }, stderr: { write: () => {} } })
        .then(code => { done = true; return code; });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(done, "GATE_EXCLUSIVE: the credentialed job waits while a turn holds the gate").toBe(false);
      expect(existsSync(f.proof), "and nothing evaluated the brain meanwhile").toBe(false);
      turn.release();
      expect(await job).toBe(0);
      const lines = evaluatedOnlyInWorkers(f, "the config helper");
      expect(lines.length, "sync and index each evaluated the config").toBe(2);
    } finally { db.close(); }
  }, 60_000);

  test("an abort kills the whole maintenance worker, and the call settles only once it is gone", async () => {
    if (!supported) return;
    const f = fixture({ config: "plain" });
    installCli(f.brain, `if (args[0] === "search") { await Bun.write((process.env.BRAIN_WORKER_DATA_ROOT ?? process.cwd()) + "/started", "x"); await Bun.sleep(60_000); }`);
    const brain = createBrainClient({ brainPath: f.brain, exec: {}, boundary: boundaryFor(f.brain, f.outside) });
    const controller = new AbortController();
    const call = brain.search("loom", { signal: controller.signal });
    const running = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).filter(name => {
      try { return readFileSync(`/proc/${name}/cmdline`, "utf8").includes(join(f.brain, "node_modules/.bin/brain")); } catch { return false; }
    });
    // Read the named output through the actual worker namespace; it has not been published.
    while (!running().some(pid => existsSync(`/proc/${pid}/root/tmp/brain-maintenance-output/started`))) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(join(f.brain, "started"))).toBe(false);
    expect(running().length).toBeGreaterThan(0);
    controller.abort(new Error("deadline"));
    await expect(call).rejects.toThrow("deadline");
    expect(running(), "no process of the worker is left").toEqual([]);
  }, 60_000);
});

describe("governed availability", () => {
  test("a server whose working directory is inside the brain reports governed unavailable and keeps the brain's code on the host it already shares", async () => {
    const f = fixture();
    const cwd = spyOn(hostExecution, "cwd").mockReturnValue(join(f.brain, "notes"));
    try {
      const boundary = createHostBoundary({ brainPath: f.brain });
      expect(boundary.governed()).toMatchObject({ available: false, reason: "server_cwd_in_brain" });
      expect(boundary.status()).toMatchObject({ available: false, reason: "server_cwd_in_brain", hostExecution: "host" });
    } finally { cwd.mockRestore(); }
  });

  test("a server database inside the brain makes governed unavailable", () => {
    const f = fixture();
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.brain, ".brain/brain-ui.db") });
    expect(boundary.governed()).toMatchObject({ available: false, reason: "database_in_brain" });
  });

  test("/api/status names the reason, and a governed history keeps the boundary in force", async () => {
    const f = fixture({ config: "plain" });
    installCli(f.brain);
    const dbPath = join(f.outside, "brain-ui.db");
    const cwd = spyOn(hostExecution, "cwd").mockReturnValue(f.brain);
    const app = await bootApp(f.brain, dbPath);
    try {
      const status = (await (await app.fetch(new Request("http://localhost/api/status"))).json()) as SystemStatus;
      expect(status.runtime?.workerHost?.governed).toMatchObject({ available: false, reason: "server_cwd_in_brain",
        detail: expect.stringContaining("start the server from a directory outside the brain"), hostExecution: "host" });
      const db = new Database(dbPath);
      try {
        createGovernedManifests(db, { brainPath: f.brain, quarantineDir: quarantineDirFor(dbPath) }).begin("turn-history");
      } finally { db.close(); }
      const checked = await (await app.fetch(new Request("http://localhost/api/status/worker-host",
        { method: "POST" }))).json() as { governed?: unknown };
      expect(checked.governed, "once a governed turn ran on this brain its code stays off the host").toMatchObject({ available: false, hostExecution: "worker" });
    } finally { cwd.mockRestore(); await app.close(); }
  });
});

describe("crash recovery", () => {
  test("a brain.config.ts created mid-turn by a turn whose server died is quarantined at boot before anything evaluates it", async () => {
    if (!supported) return;
    const f = fixture({ config: false });
    installCli(f.brain, `if (args[0] === "--version") { try { await import(process.cwd() + "/brain.config.ts"); } catch {} }`);
    const dbPath = join(f.outside, "db/brain-ui.db");
    mkdirSync(join(f.outside, "db"));
    const db = createUiDb(dbPath);
    try {
      createGovernedManifests(db, { brainPath: f.brain, quarantineDir: quarantineDirFor(dbPath) }).begin("turn-crashed");
      // The server that ran the turn is gone: the row names an exited process.
      const gone = Bun.spawnSync(["/bin/true"]);
      expect(gone.exitCode).toBe(0);
      db.query("UPDATE governed_turn_manifests SET pid = ?, pid_start = ? WHERE turn_id = ?").run(gone.pid, "exited", "turn-crashed");
    } finally { db.close(); }
    // What the turn left behind: a config that runs the attacker's helper when anything evaluates it.
    const planted = `import "./helper.ts";\nexport default {};\n`;
    writeFileSync(join(f.brain, "helper.ts"), helperSource(f.sentinel, f.proof, "planted-config"));
    writeFileSync(join(f.brain, "brain.config.ts"), planted);
    const app = await bootApp(f.brain, dbPath, { versionRequirements: { brainCli: "0.1.0" } });
    try {
      expect(existsSync(join(f.brain, "brain.config.ts")), "QUARANTINED: the planted config left the brain").toBe(false);
      const quarantined = join(quarantineDirFor(dbPath), "turn-crashed", "brain.config.ts");
      expect(readFileSync(quarantined, "utf8"), "kept, byte for byte, in the host-private quarantine").toBe(planted);
      expect(existsSync(f.proof), "EVALUATED_NEVER: nothing evaluated the planted config, not even in a worker").toBe(false);
      expect(existsSync(f.sentinel)).toBe(false);
      const check = new Database(dbPath);
      try {
        const row = check.query("SELECT ended_at, reconciliation FROM governed_turn_manifests WHERE turn_id = 'turn-crashed'").get() as { ended_at: number | null; reconciliation: string };
        expect(row.ended_at).not.toBeNull();
        expect(JSON.parse(row.reconciliation).quarantined.map((q: { path: string }) => q.path)).toEqual(["brain.config.ts"]);
      } finally { check.close(); }
    } finally { await app.close(); }
  }, 120_000);
});
