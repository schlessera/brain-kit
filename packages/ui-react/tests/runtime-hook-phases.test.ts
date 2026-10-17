import { afterEach, expect, spyOn, test } from "bun:test";
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";

const records: Array<Record<string, unknown>> = [];
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; records.length = 0; });
function capture() {
  const spy = spyOn(console, "error").mockImplementation((value) => records.push(JSON.parse(value)));
  restore = () => spy.mockRestore();
  return runtimeHookPhases("odysseus-hook-control");
}

test("real child reports exit and each drained channel without exposing output", async () => {
  const hook = capture();
  const child = Bun.spawn([process.execPath, "-e", 'console.log("Building packages/core...");console.log("private-output-sentinel");console.error("private-error-sentinel");process.exitCode=7'], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await hook.child("package-build", child);
  expect(code).toBe(7);
  expect(out).toContain("private-output-sentinel");
  expect(err).toContain("private-error-sentinel");
  const events = records.map((r) => r.event);
  expect(events).toContain("exit");
  expect(events).toContain("stdout-complete");
  expect(events).toContain("stderr-complete");
  expect(events.at(-1)).toBe("complete");
  expect(records.find((r) => r.event === "exit")?.code).toBe(7);
  expect(records.find((r) => r.event === "build-progress")?.package).toBe("core");
  expect(JSON.stringify(records)).not.toContain("sentinel");
  expect(records.every((r) => r.childPid === child.pid)).toBe(true);
});

test("pending output remains distinguishable from a completed channel", async () => {
  const hook = capture();
  let closeOutput!: () => void;
  const heldOutput = new ReadableStream<Uint8Array>({ start(controller) { closeOutput = () => controller.close(); } });
  let complete = false;
  const observation = hook.child("package-build", { pid: 42, stdout: heldOutput,
    stderr: new ReadableStream({ start(controller) { controller.close(); } }), exited: Promise.resolve(0) }).then(() => { complete = true; });
  await Bun.sleep(20);
  expect(records.some((r) => r.event === "exit")).toBe(true);
  expect(records.some((r) => r.event === "stderr-complete")).toBe(true);
  expect(records.some((r) => r.event === "stdout-complete")).toBe(false);
  expect(complete).toBe(false);
  closeOutput();
  await observation;
  expect(records.at(-1)?.event).toBe("complete");
});

test("named phase preserves values and the original rejection", async () => {
  const hook = capture();
  const marker = new Error("private-rejection-sentinel");
  expect(await hook.phase("fixture-brain", async () => 17)).toBe(17);
  await expect(hook.phase("chrome-launch", async () => { throw marker; })).rejects.toBe(marker);
  expect(records.map((r) => [r.stage, r.event])).toEqual([
    ["fixture-brain", "start"], ["fixture-brain", "complete"],
    ["chrome-launch", "start"], ["chrome-launch", "rejected"],
  ]);
  expect(JSON.stringify(records)).not.toContain("sentinel");
});
