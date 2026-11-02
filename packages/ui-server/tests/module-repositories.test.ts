/**
 * Repositories a module cron job may read (#3380): the module's config asks,
 * the operator's host allow-list decides, the host fetches with its credential
 * and the job reads a mirror without one.
 *
 * Keyless and offline: a loopback smart-HTTP Git fixture that requires Basic
 * auth with a synthetic token, fictional Odysseus repositories, and the
 * transport's exact launched argv and environment run on the host. The same
 * path through real maintenance workers is proved in
 * host-execution-boundary.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { maintenanceLaunch, type MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import { canonicalRepository, defaultBranch, grantModuleRepositories, moduleRepositoryMirrorPath, moduleRepositoryWorkerAccess,
  parseRepositoryAllowList, type ModuleRepositoryAccess } from "../src/brain/module-repositories";
import { modulesForJob, prepareJobRepositories } from "../src/cron/job-repositories";
import { runJob } from "../src/cron/run-job";
import { resolveCronConfig } from "../src/config/env";
import { emitEnvironment } from "../src/cron/emit";
import type { BrainModuleListPayload } from "../src/cron/emit";
import type { HostBoundary } from "../src/brain/host-boundary";
import { createUiDb } from "../src/db/client";
import { fixtureGit, fixtureRepository, GIT_FIXTURE_ENV, serveGitFixture } from "./helpers/git-http-fixture";

const ROOT = resolve(import.meta.dir, "../../..");
const TOKEN = "fixture-module-repository-token-never-for-a-job";
let fixture: string, brain: string, state: string, served: ReturnType<typeof serveGitFixture>, received: ReturnType<typeof serveGitFixture>["received"];
const git = fixtureGit;

beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  fixture = mkdtempSync(join(ROOT, "tmp/module-repositories-"));
  brain = join(fixture, "brain"); mkdirSync(brain);
  state = join(fixture, "state"); mkdirSync(state);
  fixtureRepository(join(fixture, "srv"), "ithaca", "watchtower", "The beacon on the watchtower is lit.");
  fixtureRepository(join(fixture, "srv"), "ithaca", "treasury", "Penelope's treasury ledger.");
  served = serveGitFixture(join(fixture, "srv"), TOKEN);
  received = served.received;
});
afterAll(() => { served?.server.stop(true); if (fixture) rmSync(fixture, { recursive: true, force: true }); });

const watchtower = () => served.url("ithaca/watchtower");
const treasury = () => served.url("ithaca/treasury");
const origin = () => served.origin;

/** The transport's exact argv, run on the host with exactly the environment its worker would get. */
async function hostRun(command: MaintenanceCommand & { timeoutMs: number }) {
  const launch = maintenanceLaunch(command);
  const child = Bun.spawn([...command.command], { cwd: fixture, env: launch.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode, killed: false };
}

/** The module list a brain reports: the beacon module's `run` job asks for what its config names. */
function moduleList(repositories: string[]): BrainModuleListPayload {
  return { available: [], enabled: [{ name: "beacon", key: "./modules/beacon", description: null, types: [], commands: ["beacon"],
    cron: [{ name: "run", schedule: "*/30 * * * *", command: "beacon run" }], repositories }] };
}

const JOB = { jobName: "beacon-run", command: ["brain", "beacon", "run"] };
const env = { PATH: "/usr/bin:/bin", BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN };

describe("the grant", () => {
  test("canonical spellings compare equal; unsafe ones never canonicalize", () => {
    expect(canonicalRepository("https://GitHub.com/ithaca/watchtower.git/")).toBe("https://github.com/ithaca/watchtower");
    expect(canonicalRepository("http://127.0.0.1:8080/ithaca/watchtower")).toBe("http://127.0.0.1:8080/ithaca/watchtower");
    for (const bad of ["http://github.com/ithaca/watchtower", "https://token@github.com/ithaca/watchtower", "https://github.com/ithaca/../treasury",
      "https://github.com/ithaca/watchtower?x=1", "https://github.com", "file:///srv/ithaca/watchtower", "-uhttps://github.com/a/b"]) expect(canonicalRepository(bad), bad).toBeNull();
    expect(parseRepositoryAllowList(" https://github.com/ithaca/watchtower,\nhttps://github.com/ithaca/watchtower.git not-a-url "))
      .toEqual({ allowed: ["https://github.com/ithaca/watchtower"], invalid: ["not-a-url"] });
  });

  test("only a repository on both the module's request and the operator's list is granted", () => {
    expect(grantModuleRepositories(["https://github.com/ithaca/watchtower", "https://github.com/ithaca/treasury"], ["https://github.com/ithaca/watchtower.git"]),
      "GRANT_IS_INTERSECTION").toEqual({ granted: ["https://github.com/ithaca/watchtower"], refused: ["https://github.com/ithaca/treasury"] });
    expect(grantModuleRepositories(["https://github.com/ithaca/treasury"], []), "BRAIN_CONFIG_ALONE_GRANTS_NOTHING")
      .toEqual({ granted: [], refused: ["https://github.com/ithaca/treasury"] });
  });

  test("the allow-list is host configuration the runner reads and no job receives", () => {
    const config = resolveCronConfig({ BRAIN_UI_MODULE_REPOSITORIES: "https://github.com/ithaca/watchtower", DB_PATH: join(state, "ui.db") });
    expect(config.moduleRepositories.allowed).toEqual(["https://github.com/ithaca/watchtower"]);
    expect(config.childEnv.BRAIN_UI_MODULE_REPOSITORIES, "ALLOW_LIST_NOT_FORWARDED_TO_JOB").toBeUndefined();
    expect(config.moduleDiscoveryEnv.BRAIN_UI_MODULE_REPOSITORIES).toBeUndefined();
    expect(config.controlEnv.BRAIN_UI_MODULE_REPOSITORIES, "ALLOW_LIST_REACHES_CRON_RUNNER").toBe("https://github.com/ithaca/watchtower");
    expect(emitEnvironment({ ...config.childEnv, ...config.controlEnv }, [])).toContain("BRAIN_UI_MODULE_REPOSITORIES=");
  });

  test("a job maps to its module by name and command; a look-alike does not", () => {
    const payload = moduleList(["https://github.com/ithaca/watchtower"]);
    expect(modulesForJob(payload, "beacon-run", ["brain", "beacon", "run"]).map(m => m.name)).toEqual(["beacon"]);
    expect(modulesForJob(payload, "beacon-run", ["brain", "beacon", "run", "--all"])).toEqual([]);
    expect(modulesForJob(payload, "beacon-other", ["brain", "beacon", "run"])).toEqual([]);
    expect(defaultBranch("ref: refs/heads/watch\tHEAD\nabc\tHEAD\n")).toBe("refs/heads/watch");
    expect(defaultBranch("ref: refs/heads/../config\tHEAD\n")).toBeNull();
  });
});

describe("the host fetch (loopback Git fixture, synthetic credential)", () => {
  test("an allow-listed repository is fetched with the host credential into a host mirror", async () => {
    const before = received.length;
    const result = await prepareJobRepositories({ ...JOB, brainPath: brain, dbPath: join(state, "ui.db"), env, allowList: [watchtower()],
      listModules: async () => moduleList([watchtower()]), run: hostRun, credentialOrigin: origin() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.repositories, "ALLOW_LISTED_REPOSITORY_FETCHED").toHaveLength(1);
    const { mirror } = result.repositories[0]!;
    expect(mirror).toBe(moduleRepositoryMirrorPath(brain, join(state, "ui.db"), watchtower()));
    expect(git(mirror, "rev-parse", "refs/heads/watch")).toBe(git(join(fixture, "srv/ithaca/watchtower.git"), "rev-parse", "watch"));
    expect(readFileSync(join(mirror, "HEAD"), "utf8"), "MIRROR_HEAD_FOLLOWS_REMOTE_DEFAULT").toBe("ref: refs/heads/watch\n");
    expect(readFileSync(join(mirror, "config"), "utf8"), "MIRROR_CONFIG_HOLDS_NO_CREDENTIAL").not.toMatch(/credential|token|include/i);
    const requests = received.slice(before);
    expect(requests.some(r => r.authorized && r.path.startsWith("/ithaca/watchtower")), "TRANSPORT_AUTHENTICATED_WITH_HOST_CREDENTIAL").toBe(true);
  }, 60_000);

  test("a repository missing from the operator list is refused, and nothing is fetched", async () => {
    const before = received.length;
    const result = await prepareJobRepositories({ ...JOB, brainPath: brain, dbPath: join(state, "ui.db"), env, allowList: [watchtower()],
      listModules: async () => moduleList([watchtower(), treasury()]), run: hostRun, credentialOrigin: origin() });
    expect(result.ok, "UNLISTED_REPOSITORY_REFUSED").toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(treasury());
    expect(result.reason).toContain("BRAIN_UI_MODULE_REPOSITORIES");
    expect(received.slice(before), "NO_REQUEST_FOR_A_REFUSED_JOB").toEqual([]);
    expect(existsSync(moduleRepositoryMirrorPath(brain, join(state, "ui.db"), treasury()))).toBe(false);
  }, 60_000);

  test("an edit to brain.config.ts alone cannot grant access: with no operator list, every request is refused", async () => {
    const before = received.length;
    for (const allowList of [[], parseRepositoryAllowList(undefined).allowed]) {
      const result = await prepareJobRepositories({ ...JOB, brainPath: brain, dbPath: join(state, "ui.db"), env, allowList,
        listModules: async () => moduleList([treasury()]), run: hostRun, credentialOrigin: origin() });
      expect(result.ok, "BRAIN_CONFIG_EDIT_ALONE_REFUSED").toBe(false);
    }
    expect(received.slice(before)).toEqual([]);
  }, 60_000);

  test("a job no module owns, or a core job, fetches nothing and needs no module list", async () => {
    let listed = 0;
    const listModules = async () => { listed++; return moduleList([watchtower()]); };
    expect(await prepareJobRepositories({ jobName: "sync", command: ["brain", "sync"], brainPath: brain, env, allowList: [watchtower()], listModules, run: hostRun }))
      .toEqual({ ok: true, repositories: [], notes: [] });
    expect(listed, "CORE_JOB_SKIPS_MODULE_LIST").toBe(0);
    expect(await prepareJobRepositories({ jobName: "ithaca-hand", command: ["brain", "hand"], brainPath: brain, env, allowList: [watchtower()], listModules, run: hostRun }))
      .toEqual({ ok: true, repositories: [], notes: [] });
  });

  test("the job's worker reads the mirror through a URL rewrite and its environment never holds the credential", async () => {
    const result = await prepareJobRepositories({ ...JOB, brainPath: brain, dbPath: join(state, "ui.db"), env, allowList: [watchtower()],
      listModules: async () => moduleList([watchtower()]), run: hostRun, credentialOrigin: origin() });
    if (!result.ok) throw new Error(result.reason);
    const access = moduleRepositoryWorkerAccess(result.repositories);
    // The job's launch as the boundary builds it: a credentialed module job, its cron environment, its repositories.
    const launch = maintenanceLaunch({ brainPath: brain, command: ["/usr/bin/git", "clone", "-q", `${watchtower()}.git`, "watchtower"], credentials: true,
      env: { ...env, ...GIT_FIXTURE_ENV, GIT_TERMINAL_PROMPT: "0" },
      readPaths: access.readPaths, gitConfig: access.gitConfig });
    expect(JSON.stringify(launch), "JOB_WORKER_NEVER_HOLDS_CREDENTIAL").not.toContain(TOKEN);
    expect(JSON.stringify(access)).not.toMatch(/token|credential|password/i);
    const before = received.length;
    const clone = mkdtempSync(join(fixture, "job-"));
    const child = Bun.spawnSync([...launch.command], { cwd: clone, env: launch.env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(readFileSync(join(clone, "watchtower/scripts/beacon.ts"), "utf8"), "JOB_CLONES_FROM_MIRROR").toContain("The beacon on the watchtower is lit.");
    expect(received.slice(before), "JOB_CLONE_NEVER_REACHES_THE_NETWORK").toEqual([]);
  }, 60_000);
});

describe("the cron run", () => {
  const boundary = (launched: unknown[]) => ({ isolated: () => true, brainPath: brain, launch: async (execution: unknown) => {
    launched.push(execution);
    return { stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0), settled: Promise.resolve(), signalCode: null, kill() {} };
  } }) as unknown as HostBoundary;

  test("a refused repository fails the run before the job starts, and the reason is recorded", async () => {
    const dir = mkdtempSync(join(fixture, "cron-"));
    const launched: unknown[] = [];
    let err = "";
    const dbPath = join(dir, "brain-ui.db");
    const code = await runJob({ ...JOB, dbPath, childEnv: env, exec: {}, boundary: boundary(launched),
      stdout: { write() {} }, stderr: { write(text: string) { err += text; } },
      repositories: () => prepareJobRepositories({ ...JOB, brainPath: brain, dbPath, env, allowList: [], listModules: async () => moduleList([treasury()]), run: hostRun }) },
    { sinkPath: join(dir, "sink.jsonl") });
    expect(code).toBe(1);
    expect(launched, "REFUSED_JOB_NEVER_LAUNCHES").toEqual([]);
    expect(err).toContain("BRAIN_UI_MODULE_REPOSITORIES");
    const db = createUiDb(dbPath);
    try {
      const row = db.query("SELECT status, error_message AS error FROM cron_runs WHERE job_name = 'beacon-run'").get() as { status: string; error: string };
      expect(row.status).toBe("error");
      expect(row.error).toContain(treasury());
    } finally { db.close(); }
  }, 60_000);

  test("a granted repository reaches the launch as host mirror access, not as a credential", async () => {
    const dir = mkdtempSync(join(fixture, "cron-"));
    const launched: { repositories?: ModuleRepositoryAccess[]; env: Record<string, string> }[] = [];
    const dbPath = join(state, "ui.db");
    const code = await runJob({ ...JOB, dbPath: join(dir, "brain-ui.db"), childEnv: env, exec: {}, boundary: boundary(launched as unknown[]),
      stdout: { write() {} }, stderr: { write() {} },
      repositories: () => prepareJobRepositories({ ...JOB, brainPath: brain, dbPath, env, allowList: [watchtower()], listModules: async () => moduleList([watchtower()]),
        run: hostRun, credentialOrigin: origin() }) }, { sinkPath: join(dir, "sink.jsonl") });
    expect(code).toBe(0);
    expect(launched[0]?.repositories, "GRANT_REACHES_LAUNCH").toEqual([{ url: watchtower(), mirror: moduleRepositoryMirrorPath(brain, dbPath, watchtower()) }]);
  }, 60_000);
});
