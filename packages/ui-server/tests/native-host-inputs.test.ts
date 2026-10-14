import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createNativeHostInputFixture as fixture } from "./helpers/native-host-input-fixture.js";
import { prepareNativeWorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../src/brain/host-boundary.js";


test("boot qualification and each async host operation acquire fresh inputs and await native release", async () => {
  const f = fixture();
  try {
    const boundary = createHostBoundary({ brainPath: f.brain, nativeManager: f.manager });
    expect((await boundary.prepare()).available).toBe(true);
    expect(f.released).toEqual(f.checkpoints);
    const first = await boundary.run(f.execution);
    expect(first.exitCode, first.stderr).toBe(0); expect(first.stdout.trim()).toBe("Odysseus initial input");
    fs.writeFileSync(join(f.brain, "helper.txt"), "Penelope next operation");
    const streaming = await boundary.launch(f.execution), output = new Response(streaming.stdout).text(), error = new Response(streaming.stderr).text();
    expect(await streaming.exited, await error).toBe(0); expect((await output).trim()).toBe("Penelope next operation");
    expect(new Set(f.checkpoints).size, "FRESH_MAINTENANCE_INPUT_PER_OPERATION").toBe(3);
    expect(f.released, "HOST_EXIT_AWAITS_NATIVE_RELEASE").toEqual(f.checkpoints);
  } finally { f.cleanup(); }
});

test("sync readers require an explicitly prepared owner and never borrow a boot checkpoint", async () => {
  const f = fixture();
  try {
    const boundary = createHostBoundary({ brainPath: f.brain, nativeManager: f.manager });
    expect(() => boundary.runSync({ ...f.execution, timeoutMs: 1000 }), "NO_SYNC_PREPARATION_OR_BOOT_REUSE").toThrow("caller's prepared immutable startupView");
    const view = await prepareNativeWorkerStartupView(f.brain, f.manager);
    fs.writeFileSync(join(f.brain, "helper.txt"), "Penelope later live input");
    const result = boundary.runSync({ ...f.execution, startupView: view, timeoutMs: 1000 });
    expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("Odysseus initial input");
    expect(f.released.length).toBe(0); await view.cleanup(); expect(f.released).toEqual(f.checkpoints);
  } finally { f.cleanup(); }
});

test("an abort after checkpoint creation releases ownership and output admission for retry", async () => {
  const f = fixture(), aborted = new AbortController(), checkpoint = f.manager.checkpoint;
  try {
    const boundary = createHostBoundary({ brainPath: f.brain, nativeManager: f.manager });
    f.manager.checkpoint = async id => { const result = await checkpoint(id); aborted.abort(); return result; };
    await expect(boundary.launch({ ...f.execution, signal: aborted.signal })).rejects.toThrow();
    expect(f.released).toEqual(f.checkpoints);
    f.manager.checkpoint = checkpoint;
    const retry = await boundary.run(f.execution); expect(retry.exitCode, retry.stderr).toBe(0);
    expect(f.released).toEqual(f.checkpoints);
  } finally { f.cleanup(); }
});

test("host completion cannot settle while final native deletion is still pending", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), complete = Promise.withResolvers<void>(), release = f.manager.release;
  try {
    f.manager.release = async id => { entered.resolve(); await complete.promise; return release(id); };
    const boundary = createHostBoundary({ brainPath: f.brain, nativeManager: f.manager });
    let settled = false;
    const operation = boundary.run(f.execution).finally(() => { settled = true; });
    await entered.promise; await Bun.sleep(1);
    expect(settled, "HOST_COMPLETION_WAITS_FOR_NATIVE_DELETION").toBe(false);
    complete.resolve(); expect((await operation).exitCode).toBe(0);
    expect(f.released).toEqual(f.checkpoints);
  } finally { complete.resolve(); f.cleanup(); }
});
