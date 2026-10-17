/** Disposable root-side controls of actual manager checkpoints; no provider is contacted. */
import { expect } from "bun:test";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeBrainManagerClient } from "../../../ui-sdk/src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView, type WorkerStartupView } from "../../../ui-sdk/src/server/worker-startup-view.js";
import { retainNativeRouteInputs } from "../../src/native-route-inputs.js";

export async function qualifyNativeCheckpointRoutes(brain: string, socketPath: string) {
  const manager = createNativeBrainManagerClient({ socketPath });
  const checks: string[] = [];
  function command(argv: string[]) {
    const child = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  }
  let fakeCalls = 0;
  await expect(retainNativeRouteInputs({ brain, root: brain, storage: { root: brain, retain() { fakeCalls++; }, release() { fakeCalls++; } }, cleanup() { fakeCalls++; } }), "NATIVE_ROUTE_FORGED_VIEW_REFUSED").rejects.toThrow();
  expect(fakeCalls, "NATIVE_ROUTE_FORGED_CALLBACK_NOT_CALLED").toBe(0); checks.push("forged-view");
  const closed = await prepareNativeWorkerStartupView(brain, manager);
  await closed.cleanup();
  await expect(retainNativeRouteInputs(closed), "NATIVE_ROUTE_CLOSED_VIEW_REFUSED").rejects.toThrow(); checks.push("closed-view");

  for (const phase of ["before-acquisition", "before-dispatch"] as const) {
    const view = await prepareNativeWorkerStartupView(brain, manager), held = view.root + "-held";
    let guard: Awaited<ReturnType<typeof retainNativeRouteInputs>> | undefined;
    let replaced = false;
    try {
      if (phase === "before-dispatch") guard = await retainNativeRouteInputs(view);
      renameSync(view.root, held); replaced = true;
      command(["btrfs", "subvolume", "snapshot", "-r", brain, view.root]);
      if (guard) expect(() => guard!.assertUnchanged(), "NATIVE_ROUTE_REPLACED_CHECKPOINT_REFUSED").toThrow();
      else await expect(retainNativeRouteInputs(view), "NATIVE_ROUTE_FOREIGN_CHECKPOINT_UUID_REFUSED").rejects.toThrow();
      checks.push(phase);
    } finally {
      if (replaced) { command(["btrfs", "subvolume", "delete", view.root]); renameSync(held, view.root); }
      await guard?.close(); await view.cleanup();
    }
  }

  const view = await prepareNativeWorkerStartupView(brain, manager);
  let guard: Awaited<ReturnType<typeof retainNativeRouteInputs>> | undefined;
  let foreign: number | undefined;
  const foreignPath = "/proof/odysseus-foreign-fd";
  try {
    guard = await retainNativeRouteInputs(view);
    guard.assertUnchanged();
    const fd = readdirSync("/proc/self/fd").map(Number).find(candidate => {
      try { return readlinkSync(`/proc/self/fd/${candidate}`) === view.root; } catch { return false; }
    });
    expect(fd, "NATIVE_ROUTE_OWN_FD_OBSERVED").toBeDefined();
    closeSync(fd!); writeFileSync(foreignPath, "Odysseus prepares the voyage."); foreign = openSync(foreignPath, "r");
    expect(foreign, "NATIVE_ROUTE_ACTUAL_FD_REUSED").toBe(fd!);
    expect(() => guard!.assertUnchanged(), "NATIVE_ROUTE_REUSED_FD_REFUSED").toThrow();
    await guard.close(); guard = undefined;
    expect(fstatSync(foreign).isFile(), "NATIVE_ROUTE_CLEANUP_PRESERVES_FOREIGN_REUSE").toBe(true);
    checks.push("fd-reuse");
  } finally { await guard?.close(); if (foreign !== undefined) closeSync(foreign); rmSync(foreignPath, { force: true }); await view.cleanup(); }

  const closedFdView = await prepareNativeWorkerStartupView(brain, manager);
  const closedFdGuard = await retainNativeRouteInputs(closedFdView);
  try {
    const fd = readdirSync("/proc/self/fd").map(Number).find(candidate => {
      try { return readlinkSync(`/proc/self/fd/${candidate}`) === closedFdView.root; } catch { return false; }
    });
    expect(fd, "NATIVE_ROUTE_CLOSE_FD_OBSERVED").toBeDefined();
    await closedFdView.cleanup();
    expect(existsSync(closedFdView.root), "NATIVE_ROUTE_OWN_REFERENCE_RETAINS_CHECKPOINT").toBe(true);
    closeSync(fd!);
    expect(() => closedFdGuard.assertUnchanged(), "NATIVE_ROUTE_CLOSED_FD_REFUSED").toThrow();
    await closedFdGuard.close();
    expect(existsSync(closedFdView.root), "NATIVE_ROUTE_CLOSED_FD_STILL_RELEASES_CHECKPOINT").toBe(false);
    checks.push("closed-fd-cleanup");
  } finally { await closedFdGuard.close(); await closedFdView.cleanup(); }

  const project = join(brain, ".claude");
  const projectExisted = existsSync(project), settings = join(project, "settings.json");
  const heldSettings = mkdtempSync(join(brain, ".route-alias-"));
  if (!projectExisted) mkdirSync(project);
  const settingsExisted = existsSync(settings);
  if (settingsExisted) renameSync(settings, join(heldSettings, "settings.json"));
  writeFileSync(join(heldSettings, "route.json"), "{}"); symlinkSync(join(heldSettings, "route.json"), settings);
  let alias: WorkerStartupView | undefined;
  try { alias = await prepareNativeWorkerStartupView(brain, manager); await expect(retainNativeRouteInputs(alias), "NATIVE_ROUTE_CHECKPOINT_CHILD_ALIAS_REFUSED").rejects.toThrow(); checks.push("child-alias"); }
  finally {
    await alias?.cleanup(); rmSync(settings);
    if (settingsExisted) renameSync(join(heldSettings, "settings.json"), settings);
    if (!projectExisted) rmdirSync(project);
    rmSync(heldSettings, { recursive: true });
  }

  const immutable = await prepareNativeWorkerStartupView(brain, manager);
  let pinned: Awaited<ReturnType<typeof retainNativeRouteInputs>> | undefined;
  try {
    pinned = await retainNativeRouteInputs(immutable);
    expect(() => mkdirSync(join(immutable.root, ".claude-route-input-probe")), "NATIVE_ROUTE_IMMUTABLE_PROJECT_ABA_WRITE_REFUSED").toThrow(expect.objectContaining({ code: "EROFS" }));
    pinned.assertUnchanged(); checks.push("immutable-project-write");
    await immutable.cleanup(); pinned.assertUnchanged(); checks.push("retained-owner-lifetime");
  } finally { await pinned?.close(); await immutable.cleanup(); }
  writeFileSync("/proof/checkpoint-route-checks.json", JSON.stringify({ actualCheckpointRouteChecks: checks }));
  console.log(JSON.stringify({ actualCheckpointRouteChecks: checks }));
}
