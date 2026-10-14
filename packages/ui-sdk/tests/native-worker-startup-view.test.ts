import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerStartupView, prepareNativeWorkerStartupView, retainWorkerStartupView } from "../src/server/worker-startup-view.js";

function fixture() {
  const store = fs.mkdtempSync(join(tmpdir(), "odysseus-native-view-")), brain = join(store, "brain");
  fs.mkdirSync(brain);
  const actual = fs.statfsSync(brain), stat = spyOn(fs, "statfsSync").mockReturnValue({ ...actual, type: 0x9123683e });
  const releases: { id: string; signal: AbortSignal | undefined }[] = [];
  const manager = {
    async checkpoint(id: string, _signal?: AbortSignal) {
      const path = join(store, ".brain-native", "checkpoints", id); fs.mkdirSync(path, { recursive: true });
      return { id, path, readOnly: true as const, fsid: "00000000-0000-0000-0000-000000000001",
        uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" };
    },
    async release(id: string, signal?: AbortSignal) { releases.push({ id, signal }); return { id, state: "deleted" as const }; },
  };
  return { brain, manager, releases, cleanup() { stat.mockRestore(); fs.rmSync(store, { recursive: true, force: true }); } };
}

test("the synchronous production path refuses without reading or copying inputs", () => {
  expect(() => createWorkerStartupView("/does-not-exist"), "NO_FULL_COPY_STARTUP_FALLBACK").toThrow("full-copy startup fallback is unavailable");
});

test("each consumer pins the complete prepared checkpoint until its final awaited release", async () => {
  const f = fixture();
  try {
    const owner = await prepareNativeWorkerStartupView(f.brain, f.manager), first = retainWorkerStartupView(owner), last = retainWorkerStartupView(owner);
    let deleted = false;
    const gate = Promise.withResolvers<void>(), release = f.manager.release;
    f.manager.release = async (...args) => { await gate.promise; deleted = true; return release(...args); };
    await owner.cleanup(); await first.cleanup();
    expect(() => retainWorkerStartupView(owner), "APPROVED_INPUT_LIFETIME_ENDED").toThrow("closed");
    expect(f.releases.length, "ACTIVE_EXECUTION_LEASE_PINS_VIEW").toBe(0);
    const completion = last.cleanup(); expect(deleted).toBe(false);
    gate.resolve(); await completion;
    expect(f.releases.length).toBe(1); expect(deleted).toBe(true);
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
