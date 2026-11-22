import { expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import * as sandbox from "../../ui-sdk/src/server/worker-sandbox.js";
import type { MaintenanceGitManifest } from "../../ui-sdk/src/server/maintenance-git-input.js";
import { createHostBoundary, hostExecution } from "../src/brain/host-boundary.js";
import { prepareMaintenanceGitTargets } from "../src/brain/maintenance-git.js";
import { createTestApp } from "./helpers/test-app.js";
import { createRecordingObservability } from "../src/observability/index.js";
import * as sdk from "@schlessera/brain-ui-sdk/internal";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { runMirrorSync } from "../src/brain/sync-mirror.js";

for (const operation of ["run", "launch", "sync-run", "sync-launch"] as const) test(`maintenance ${operation} prepares missing fixed Git targets before checkpoint acquisition without a boot probe`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-git-targets-")), brain = join(root, "brain"), stage = join(root, "stage");
  mkdirSync(join(brain, ".git/hooks"), { recursive: true }); mkdirSync(join(brain, ".git/info")); mkdirSync(stage);
  const original = lstatSync(join(brain, ".git/hooks"));
  const captured = new Error("fixture checkpoint captured"), results: number[] = [], targets: string[][] = [];
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async path => {
    targets.push(readdirSync(join(path, ".git")).sort());
    cpSync(join(path, ".git"), join(stage, ".git"), { recursive: true });
    // A separate UID cannot create children in the retained server-owned 0755
    // metadata parent. Remove owner-write here to exercise the same denial
    // without privilege changes, namespaces or native proof on this host.
    chmodSync(join(stage, ".git"), 0o555);
    const input: MaintenanceGitManifest = { relative: `.brain-maintenance-git-${crypto.randomUUID()}`, maximum: 1024 ** 2,
      files: ["config.json", "empty-config", "bin/git"].map(path => ({ path, data: Buffer.from("Odysseus fixture").toString("base64"), executable: path === "bin/git" })),
      scaffolds: (["hooks", "info", "modules"] as const).filter(name => !existsSync(join(stage, ".git", name))).map(name => ({ name })) };
    const installed = Bun.spawnSync([process.execPath, "--config=/dev/null", "--no-env-file",
      join(import.meta.dir, "../../ui-sdk/src/server/maintenance-git-input.ts"), String(input.maximum)],
    { env: { BRAIN_ROOT: stage }, stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
    results.push(installed.exitCode);
    throw captured;
  });
  try {
    const boundary = createHostBoundary({ brainPath: brain, dbPath: join(root, "ui.db"), nativeManager: {} as never, workerHost: () => ({ ok: true }) });
    boundary.status();
    expect(existsSync(join(brain, ".git/modules")), "STATUS_DOES_NOT_PREPARE_GIT_TARGETS").toBe(false);
    const command = { argv: [process.execPath, "--version"], env: {}, credentials: false, gate: "none" as const, purpose: "Odysseus checkpoint control" };
    if (operation === "sync-launch") {
      const worker = await boundary.launch({ ...command, sync: true });
      const [code, , error] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
      expect(code).toBe(1); expect(error).toBe(captured.message);
    } else await expect(operation === "sync-run" ? boundary.run({ ...command, sync: true }) : boundary[operation](command)).rejects.toBe(captured);
    expect(targets, "MAINTENANCE_CHECKPOINT_INCLUDES_FIXED_GIT_TARGETS").toEqual([["hooks", "info", "modules"]]);
    expect(results, "MAINTENANCE_CHECKPOINT_HAS_FIXED_GIT_TARGETS_FOR_NONWRITABLE_PARENT").toEqual([0]);
    expect(readdirSync(join(brain, ".git")).sort()).toEqual(["hooks", "info", "modules"]);
    const retained = lstatSync(join(brain, ".git/hooks"));
    expect([retained.ino, retained.mode, retained.uid, retained.gid, retained.mtimeMs, retained.ctimeMs], "EXISTING_GIT_TARGET_UNCHANGED")
      .toEqual([original.ino, original.mode, original.uid, original.gid, original.mtimeMs, original.ctimeMs]);
  } finally { acquire.mockRestore(); if (existsSync(join(stage, ".git"))) chmodSync(join(stage, ".git"), 0o755); rmSync(root, { recursive: true, force: true }); }
});

test("sync prepares targets again immediately before its local adapter checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-sync-git-targets-")), brain = join(root, "brain");
  mkdirSync(join(brain, ".git"), { recursive: true });
  const captured = new Error("local sync checkpoint"), targets: boolean[] = [];
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async path => {
    targets.push(existsSync(join(path, ".git/modules")));
    if (targets.length === 2) throw captured;
    return createFixtureWorkerStartupView(path);
  });
  const worker = spyOn(sdk, "runMaintenanceWorker").mockImplementation(async input => {
    expect(input.command.slice(-1), "SYNC_ORIGIN_PROBE_REACHED").toEqual(["remote.origin.url"]);
    // The local phase must prepare its own checkpoint, even if a target
    // disappears after the origin probe's immutable view was acquired.
    rmSync(join(brain, ".git/modules"), { recursive: true, force: true });
    return { exitCode: 1, killed: false, stdout: "", stderr: "" };
  });
  try {
    await expect(runMirrorSync({ command: { brainPath: brain, command: [process.execPath, "--version"], env: {}, credentials: false },
      nativeManager: {} as never, mirror: join(root, "mirror.git") })).rejects.toBe(captured);
    expect(targets, "EACH_SYNC_CHECKPOINT_PREPARES_ITS_OWN_GIT_TARGETS").toEqual([true, true]);
    expect(worker).toHaveBeenCalledTimes(1);
  } finally { acquire.mockRestore(); worker.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

for (const alias of [".git", ".git/modules"] as const) test(`maintenance target preparation refuses linked ${alias} before checkpoint or external writes`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-git-target-link-")), brain = join(root, "brain"), foreign = join(root, "foreign");
  mkdirSync(brain); mkdirSync(foreign);
  if (alias !== ".git") mkdirSync(join(brain, ".git"));
  symlinkSync(foreign, join(brain, alias));
  const captured = new Error("unexpected checkpoint"), acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockRejectedValue(captured);
  try {
    const boundary = createHostBoundary({ brainPath: brain, nativeManager: {} as never, workerHost: () => ({ ok: true }) });
    const command = { argv: [process.execPath, "--version"], env: {}, credentials: false, gate: "none" as const, purpose: "Odysseus Git target control" };
    await expect(boundary.run(command)).rejects.toThrow();
    expect(acquire, "LINKED_GIT_TARGET_PARENT_REFUSED_BEFORE_CHECKPOINT").not.toHaveBeenCalled();
    expect(readdirSync(foreign), "LINKED_GIT_TARGET_PARENT_NEVER_WRITTEN").toEqual([]);
    unlinkSync(join(brain, alias));
    if (alias === ".git") mkdirSync(join(brain, ".git"));
    await expect(boundary.run(command)).rejects.toBe(captured);
    expect(acquire, "REPAIRED_GIT_TARGET_RETRIES_WITHOUT_RESTART").toHaveBeenCalledTimes(1);
    expect(readdirSync(join(brain, ".git")).sort()).toEqual(["hooks", "info", "modules"]);
  } finally { acquire.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("a linked Git target permits app boot and health while refusing and recording one maintenance operation", async () => {
  const observability = createRecordingObservability();
  const probe = spyOn(sdk.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const maintenance = spyOn(hostExecution, "maintenanceProbe").mockResolvedValue({ ok: true });
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined, failure: unknown;
  try {
    try {
      app = await createTestApp({ appOptions: { observability }, prepare(brain) {
        mkdirSync(join(brain, ".git")); mkdirSync(join(brain, "foreign")); symlinkSync("../foreign", join(brain, ".git/modules"));
      } });
    } catch (error) { failure = error; }
    expect(failure, "GIT_TARGET_FAILURE_DOES_NOT_REFUSE_APP_BOOT").toBeUndefined();
    if (!app) throw Error("Missing app fixture");
    expect((await app.fetch("/api/health")).status, "BOOT_PAST_GIT_TARGET_FAILURE").toBe(200);
    const operation = await app.fetch("/api/brain/index", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: "{}" });
    expect(operation.status, "GIT_TARGET_REFUSES_ONLY_MAINTENANCE_OPERATION").toBe(500);
    expect(await operation.json()).toEqual({ error: "Invalid maintenance Git mask target" });
    expect(observability.logs.records().filter(row => String(row.body).includes("version probe failed")).map(row => row.attributes?.reason), "GIT_REFUSAL_RECORDED_BY_EXISTING_BOOT_DIAGNOSTIC")
      .toContain("Invalid maintenance Git mask target");
    expect((await app.fetch("/api/health")).status, "GIT_REFUSAL_LEAVES_HOST_HEALTHY").toBe(200);
    expect(readdirSync(join(app.brainPath, "foreign"))).toEqual([]);
  } finally { await app?.teardown(); maintenance.mockRestore(); probe.mockRestore(); }
});

test("maintenance target preparation leaves absent Git metadata and unrelated paths absent", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-without-git-"));
  try {
    prepareMaintenanceGitTargets(brain);
    expect(readdirSync(brain), "MAINTENANCE_DOES_NOT_CREATE_A_REPOSITORY_OR_POLICY_PARENTS").toEqual([]);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});

test("maintenance target preparation preserves existing private target modes", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-private-git-targets-")), hooks = join(brain, ".git/hooks");
  mkdirSync(hooks, { recursive: true }); chmodSync(hooks, 0);
  try {
    prepareMaintenanceGitTargets(brain);
    expect(lstatSync(hooks).mode & 0o7777, "EXISTING_PRIVATE_GIT_TARGET_NEVER_WIDENED").toBe(0);
    expect(readdirSync(join(brain, ".git")).sort()).toEqual(["hooks", "info", "modules"]);
  } finally { chmodSync(hooks, 0o700); rmSync(brain, { recursive: true, force: true }); }
});

test("maintenance target preparation leaves foreign-owned metadata to its worker installer", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-worker-git-targets-"));
  mkdirSync(join(brain, ".git"));
  const identity = spyOn(process, "getuid").mockReturnValue(lstatSync(join(brain, ".git")).uid + 1);
  try {
    prepareMaintenanceGitTargets(brain);
    expect(readdirSync(join(brain, ".git")), "FOREIGN_GIT_METADATA_IS_NOT_PREPARED_AS_SERVER").toEqual([]);
  } finally { identity.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
});

test("maintenance target preparation refuses mounted metadata without writing through it", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-mounted-git-targets-"));
  mkdirSync(join(brain, ".git"));
  const mounts = spyOn(sandbox, "mountPointsUnder").mockReturnValue([join(brain, ".git")]);
  try {
    expect(() => prepareMaintenanceGitTargets(brain)).toThrow("Maintenance Git targets contain a mount point");
    expect(readdirSync(join(brain, ".git")), "MOUNTED_GIT_METADATA_NEVER_WRITTEN").toEqual([]);
    mounts.mockRestore();
    prepareMaintenanceGitTargets(brain);
    expect(readdirSync(join(brain, ".git")).sort(), "UNMOUNTED_GIT_METADATA_RECOVERS_WITHOUT_A_LATCH").toEqual(["hooks", "info", "modules"]);
  } finally { mounts.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
});
