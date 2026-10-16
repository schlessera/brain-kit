import "../src/server/worker-launcher.js";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import { NativeBrainManagerError } from "../src/server/native-brain-manager-protocol.js";
import { processStateLedger } from "../src/server/worker-state-budget.js";
import { hostOutputStagingLimits } from "../src/server/worker-state-limits.js";
import { createWorkerStartupView, hasNativeBrainBoundary, isNativeWorkerStartupRoot, prepareNativeWorkerStartupView, retainWorkerStartupView } from "../src/server/worker-startup-view.js";
import { resolveWorkerProtection } from "../src/server/worker-protection.js";

function fixture() {
  const store = fs.mkdtempSync(join(tmpdir(), "odysseus-native-view-")), brain = join(store, "brain");
  fs.mkdirSync(brain);
  const actual = fs.statfsSync(brain), stat = spyOn(fs, "statfsSync").mockReturnValue({ ...actual, type: 0x9123683e });
  const releases: { id: string; signal: AbortSignal | undefined }[] = [];
  const manager = {
    async checkpoint(id: string, _signal?: AbortSignal) {
      const path = join(store, ".brain-native", "checkpoints", id); fs.mkdirSync(path, { recursive: true });
      return { id, path, readOnly: true as const, sourceUuid: "0123456789abcdef0123456789abcdef", fsid: "00000000-0000-0000-0000-000000000001",
        uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" };
    },
    async release(id: string, signal?: AbortSignal) { releases.push({ id, signal }); return { id, state: "deleted" as const }; },
  };
  return { brain, manager, releases, cleanup() { stat.mockRestore(); fs.rmSync(store, { recursive: true, force: true }); } };
}

test("the synchronous production path refuses without reading or copying inputs", () => {
  expect(() => createWorkerStartupView("/does-not-exist"), "NO_FULL_COPY_STARTUP_FALLBACK").toThrow("full-copy startup fallback is unavailable");
});

test("only an acquired subvolume-root identity permits the native brain boundary", async () => {
  const f = fixture(), actual = fs.lstatSync(f.brain, { bigint: true }), lstat = fs.lstatSync;
  let device = actual.dev;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (args[0] === f.brain && args[1]?.bigint) return { ...actual, dev: device, ino: 256n, isDirectory: () => true };
    return Reflect.apply(lstat, fs, args);
  }) as typeof fs.lstatSync);
  try {
    expect(hasNativeBrainBoundary(f.brain), "NO_GENERIC_BTRFS_BOUNDARY_EXEMPTION").toBe(false);
    const view = await prepareNativeWorkerStartupView(f.brain, f.manager);
    expect(hasNativeBrainBoundary(f.brain), "ACQUIRED_NATIVE_BOUNDARY_ATTESTED").toBe(true);
    await view.cleanup();
    expect(hasNativeBrainBoundary(f.brain), "LIVE_SUBVOLUME_BOUNDARY_OUTLIVES_CHECKPOINT").toBe(true);
    device++;
    expect(hasNativeBrainBoundary(f.brain), "REPLACED_NATIVE_ROOT_INVALIDATES_ATTESTATION").toBe(false);
    device = actual.dev;
    expect(hasNativeBrainBoundary(f.brain), "INVALIDATED_BOUNDARY_REQUIRES_FRESH_ACQUISITION").toBe(false);
  } finally { stat.mockRestore(); f.cleanup(); }
});

test("an attested native boundary still refuses a protected hardlink inside the brain", async () => {
  const f = fixture(), actual = fs.lstatSync(f.brain, { bigint: true }), lstat = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (args[0] === f.brain && args[1]?.bigint) return { ...actual, ino: 256n, isDirectory: () => true };
    return Reflect.apply(lstat, fs, args);
  }) as typeof fs.lstatSync);
  try {
    const view = await prepareNativeWorkerStartupView(f.brain, f.manager);
    fs.writeFileSync(join(f.brain, "brain.config.ts"), "export default {};\n");
    fs.linkSync(join(f.brain, "brain.config.ts"), join(f.brain, "odysseus-alias.md"));
    expect(resolveWorkerProtection(f.brain, { paths: ["brain.config.ts"] }).reason ?? "",
      "NATIVE_PROTECTED_ALIAS_STILL_REFUSED").toContain("brain.config.ts is hardlinked");
    await view.cleanup();
  } finally { stat.mockRestore(); hasNativeBrainBoundary(f.brain); f.cleanup(); }
});

test("each consumer pins the complete prepared checkpoint until its final awaited release", async () => {
  const f = fixture();
  try {
    const owner = await prepareNativeWorkerStartupView(f.brain, f.manager), first = retainWorkerStartupView(owner), last = retainWorkerStartupView(owner);
    expect(isNativeWorkerStartupRoot(owner.root), "NATIVE_OUTPUT_LOWER_IS_HELD").toBe(true);
    let deleted = false;
    const gate = Promise.withResolvers<void>(), release = f.manager.release;
    f.manager.release = async (...args) => { await gate.promise; deleted = true; return release(...args); };
    await owner.cleanup(); await first.cleanup();
    expect(() => retainWorkerStartupView(owner), "APPROVED_INPUT_LIFETIME_ENDED").toThrow("closed");
    expect(f.releases.length, "ACTIVE_EXECUTION_LEASE_PINS_VIEW").toBe(0);
    const completion = last.cleanup(); expect(deleted).toBe(false);
    gate.resolve(); await completion;
    expect(f.releases.length).toBe(1); expect(deleted).toBe(true);
    expect(isNativeWorkerStartupRoot(owner.root), "NATIVE_OUTPUT_LOWER_CANNOT_OUTLIVE_LEASE").toBe(false);
    await last.cleanup(); expect(f.releases.length).toBe(1);
    expect(() => retainWorkerStartupView(owner)).toThrow("closed");
  } finally { f.cleanup(); }
});

test("an unknown cancelled checkpoint is reconciled with the same identity without the cancelled signal", async () => {
  const f = fixture(), abort = new AbortController(); let requested = "";
  try {
    f.manager.checkpoint = async id => { requested = id; abort.abort(); throw new Error("unknown committed checkpoint"); };
    await expect(prepareNativeWorkerStartupView(f.brain, f.manager, abort.signal)).rejects.toThrow("unknown committed checkpoint");
    expect(f.releases).toEqual([{ id: requested, signal: undefined }]);
  } finally { f.cleanup(); }
});

test("a malformed checkpoint is released and cannot become execution input", async () => {
  const f = fixture(), checkpoint = f.manager.checkpoint;
  try {
    f.manager.checkpoint = async id => ({ ...await checkpoint(id), path: f.brain });
    await expect(prepareNativeWorkerStartupView(f.brain, f.manager)).rejects.toThrow("expected complete immutable checkpoint identity");
    expect(f.releases.length).toBe(1);
  } finally { f.cleanup(); }
});

test("failed ownership cleanup surfaces both errors and the recoverable identity", async () => {
  const f = fixture();
  try {
    f.manager.checkpoint = async () => { throw new Error("checkpoint reply lost"); };
    f.manager.release = async () => { throw new Error("release reply lost"); };
    await expect(prepareNativeWorkerStartupView(f.brain, f.manager)).rejects.toThrow("unknown outcome; reconcile its durable manager intent");
  } finally { f.cleanup(); }
});

test("manager-wide stage capacity keeps the worker_state_busy refusal and reconciles its owned identity", async () => {
  const f=fixture();let stages=0,releases=0;
  const manager={...f.manager,async prepareStage(){stages++;throw new NativeBrainManagerError("capacity","aggregate budget busy");},async inspectStage():Promise<never>{throw Error("unused");},async releaseStage(id:string){releases++;return {id,state:"deleted" as const};}};
  const view=await prepareNativeWorkerStartupView(f.brain,manager);
  try {await expect(prepareNativeWorkerOutput(f.brain,{startupView:view}),"NATIVE_STAGE_CAPACITY_CLASS_IS_WORKER_STATE_BUSY").rejects.toMatchObject({errorClass:"worker_state_busy"});
    expect(stages).toBe(1);expect(releases).toBe(1);expect(f.releases).toHaveLength(0);
    expect(processStateLedger().outputStagingHeld).toBe(0);
  } finally {await view.cleanup();f.cleanup();}
});
test("a process admission refusal never releases an unrequested stage or masks the busy error", async () => {
  const f=fixture();let stages=0,releases=0;
  const manager={...f.manager,async prepareStage():Promise<never>{stages++;throw Error("unused");},async inspectStage():Promise<never>{throw Error("unused");},async releaseStage():Promise<never>{releases++;throw Error("unowned stage cannot be released");}};
  const view=await prepareNativeWorkerStartupView(f.brain,manager),limits=hostOutputStagingLimits();
  const held=processStateLedger().reserve(undefined,undefined,{allowanceBytes:limits.budgetBytes,budgetBytes:limits.budgetBytes});
  try {await expect(prepareNativeWorkerOutput(f.brain,{startupView:view}),"NATIVE_UNREQUESTED_STAGE_NEVER_RELEASED").rejects.toMatchObject({errorClass:"worker_state_busy"});
    expect(stages).toBe(0);expect(releases).toBe(0);
  } finally {held.release();await view.cleanup();f.cleanup();}
});
