import { expect, test, spyOn } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareWorkerSandbox, WORKER_STATE, workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
import { createWorkerSpawn } from "../src/worker-spawn.js";
import { createClaudeWorkerState } from "../src/worker-state.js";
import { createStateLedger } from "../src/worker-state-budget.js";
import { createFixtureWorkerStartupView, prepareFixtureNativeWorkerOutput } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import * as nativeOutput from "../../ui-sdk/src/server/worker-native-output.js";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";

test("a failed host probe refuses before the SDK query/spawn is called", async () => {
  let called = 0;
  const probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: false, requirement: "fixture capability missing" });
  try {
    const backend = createClaudeBackend({ brainPath: "/brain", queryFn: (() => { called++; throw new Error("spawn reached"); }) as never });
    await expect(backend.startTurn({ prompt: "Odysseus", signal: new AbortController().signal,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } })).rejects.toThrow("fixture capability missing");
    expect(called, "runtime initialization must not be reached").toBe(0);
  } finally { probe.mockRestore(); }
});
const MiB = 1024 * 1024;
const limits = { allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB };
test("Claude state snapshot cannot share an inode with the brain and only persists its transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-test-")); const brain = join(root, "brain"), saved = join(root, "config"), tmpfs = join(root, "tmpfs");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(tmpfs);
  let state: ReturnType<typeof createClaudeWorkerState> | undefined;
  try {
    writeFileSync(join(saved, "settings.json"), "{}");
    state = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { limits, ledger: createStateLedger() });
    state.populate(tmpfs);
    const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
    mkdirSync(join(tmpfs, project), { recursive: true });
    writeFileSync(join(tmpfs, project, "11111111-1111-4111-8111-111111111111.jsonl"), "Odysseus transcript\n");
    writeFileSync(join(tmpfs, "settings.json"), "untrusted settings");
    state.persist(tmpfs);
    expect(readFileSync(join(saved, project, "11111111-1111-4111-8111-111111111111.jsonl"), "utf8")).toBe("Odysseus transcript\n");
    expect(readFileSync(join(saved, "settings.json"), "utf8")).toBe("{}");
    // The worker's runtime state is a private tmpfs of exactly the allowance, never a host bind.
    const argv = workerCommand({ brainPath: brain, stateBytes: state.bytes, command: [process.execPath], env: {} });
    expect(argv.join(" ")).toContain(`--size ${64 * MiB} --tmpfs ${WORKER_STATE}`);
    expect(argv).not.toContain(saved);
    expect(argv.filter(arg => arg === "--bind")).toHaveLength(0);
  } finally { state?.release(); rmSync(root, { recursive: true, force: true }); }
});
test("state setup refuses a brain config path and a hardlink credential alias", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-alias-")), brain = join(root, "brain"), saved = join(root, "config");
  mkdirSync(brain); mkdirSync(saved); writeFileSync(join(brain, "policy.md"), "Athena policy");
  try {
    expect(() => createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: brain }, { limits, ledger: createStateLedger() })).toThrow("outside");
    linkSync(join(brain, "policy.md"), join(saved, "settings.json"));
    expect(() => createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { limits, ledger: createStateLedger() })).toThrow("alias");
    expect(readFileSync(join(brain, "policy.md"), "utf8")).toBe("Athena policy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("worker transcript export refuses symlinks and concurrent saved-state overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-export-")), brain = join(root, "brain"), saved = join(root, "config"), tmpfs = join(root, "tmpfs");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(tmpfs);
  const state = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { limits, ledger: createStateLedger() });
  state.populate(tmpfs);
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  try {
    mkdirSync(join(tmpfs, project), { recursive: true });
    writeFileSync(join(brain, "policy.md"), "Athena policy");
    symlinkSync(join(brain, "policy.md"), join(tmpfs, project, "alias.jsonl"));
    expect(() => state.persist(tmpfs)).toThrow(); expect(readFileSync(join(brain, "policy.md"), "utf8")).toBe("Athena policy");
    rmSync(join(tmpfs, project, "alias.jsonl"));
    mkdirSync(join(saved, project), { recursive: true });
    writeFileSync(join(saved, project, "11111111-1111-4111-8111-111111111111.jsonl"), "Concurrent transcript"); writeFileSync(join(tmpfs, project, "11111111-1111-4111-8111-111111111111.jsonl"), "Worker transcript");
    expect(() => state.persist(tmpfs)).toThrow("changed concurrently");
    expect(readFileSync(join(saved, project, "11111111-1111-4111-8111-111111111111.jsonl"), "utf8")).toBe("Concurrent transcript");
    expect(existsSync(join(saved, project, "alias.jsonl"))).toBe(false);
  } finally { state.release(); rmSync(root, { recursive: true, force: true }); }
});
test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))("a real worker's linked turn-temp file is promoted and the saved answer links the copy (#1655)", async () => {
  const repo = resolve(import.meta.dir, "../../..");
  mkdirSync(join(repo, "tmp"), { recursive: true });
  const root = mkdtempSync(join(repo, "tmp/claude-promotion-")), brain = join(root, "brain"), saved = join(root, "config"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(home); writeFileSync(join(saved, "settings.json"), "{}");
  const turnId = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", session = "33333333-3333-4333-8333-333333333333";
  const project = `projects/${realpathSync(brain).replace(/[^a-zA-Z0-9]/g, "-")}`;
  const records: unknown[] = [];
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  const view = createFixtureWorkerStartupView(brain);
  const outputSpy = spyOn(nativeOutput, "prepareNativeWorkerOutput").mockImplementation(prepareFixtureNativeWorkerOutput);
  try {
    const sandbox = prepareWorkerSandbox(brain, { home, maintenance: { startupView: view } });
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined, sandbox, undefined,
      { turnId, report: found => records.push(...found), log: () => {} }, {}, undefined, undefined, view);
    const program = `import * as fs from "node:fs";
      fs.writeFileSync(process.env.BRAIN_WORKER_SCRATCH + "/report.pdf", "Odysseus: the voyage report.");
      const dir = process.env.CLAUDE_CONFIG_DIR + "/${project}";
      fs.mkdirSync(dir, { recursive: true });
      const text = "The report: [voyage](/tmp/brain-worker-scratch/report.pdf).";
      fs.writeFileSync(dir + "/${session}.jsonl", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n");`;
    const child = spawner.spawn({ command: process.execPath, args: ["-e", program], env: { CLAUDE_CONFIG_DIR: saved, HOME: home },
      signal: new AbortController().signal } as never);
    child.stdin.end();
    const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
    await spawner.finish();
    expect(code).toBe(0);
    const destination = `.brain/scratch/turns/${turnId}/report.pdf`;
    expect(readFileSync(join(brain, destination), "utf8")).toBe("Odysseus: the voyage report.");
    const transcript = JSON.parse(readFileSync(join(saved, project, `${session}.jsonl`), "utf8"));
    expect(transcript.message.content[0].text).toBe(`The report: [voyage](${destination}).`);
    expect(records).toEqual([{ kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination, bytes: 28,
      originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: destination }]);
  } finally { await view.cleanup(); outputSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("a throwing worker-start callback kills and drains its real child before releasing state", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-worker-start-"));
  const brain = join(root, "brain"), saved = join(root, "config"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(home); writeFileSync(join(saved, "settings.json"), "{}");
  const ledger = createStateLedger(), exits: unknown[] = [], errors: string[] = [];
  let worker: import("@schlessera/brain-ui-sdk/internal").LaunchedWorker | undefined;
  const sandbox = prepareWorkerSandbox(brain, { home, profile: "governed", areas: [] });
  const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined, sandbox, undefined, undefined,
    { ledger, limits, turnTempLimits: { allowanceBytes: 1024 * 1024, budgetBytes: 1024 * 1024 } }, undefined,
    started => { worker = started as import("@schlessera/brain-ui-sdk/internal").LaunchedWorker; throw Error("Odysseus scope freezer refused"); });
  try {
    const child = spawner.spawn({ command: "/bin/sh", args: ["-c", "while :; do sleep 1; done"],
      env: { CLAUDE_CONFIG_DIR: saved, HOME: home }, signal: new AbortController().signal } as never);
    child.on("error", error => errors.push(error.message)); child.on("exit", (code, signal) => exits.push([code, signal]));
    child.stdout.resume(); child.stdin.end();
    await expect(spawner.finish()).rejects.toThrow("scope freezer refused");
    expect(worker, "WORKER_START_CALLBACK_REACHED_REAL_CHILD").toBeDefined();
    await worker!.exited;
    expect(existsSync(`/proc/${worker!.pid}`), "WORKER_START_FAILURE_DRAINS_BEFORE_RELEASE").toBe(false);
    expect(ledger.live, "WORKER_START_FAILURE_RELEASES_RESERVATION").toBe(0);
    expect(errors).toEqual(["Odysseus scope freezer refused"]);
    expect(exits).toEqual([[null, "SIGKILL"]]);
  } finally {
    worker?.kill("SIGKILL"); await worker?.exited.catch(() => {}); await spawner.finish().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
