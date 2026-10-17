import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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


test("existing relay receives original chunks and preserves split UTF-8 text", async () => {
  const hook = capture();
  const chunks = [Uint8Array.from([0x49, 0xe1]), Uint8Array.from([0xbc, 0xb0, 0x0a])];
  const received: Uint8Array[] = [];
  async function relay(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let output = "";
    for await (const chunk of stream) {
      received.push(chunk);
      output += decoder.decode(chunk, { stream: true });
    }
    return output + decoder.decode();
  }
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const [text] = await hook.child("package-build", { pid: 42, stdout, stderr, exited: Promise.resolve(0) }, relay);
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(chunks[0]);
  expect(received[1]).toBe(chunks[1]);
  expect(text).toBe(new TextDecoder().decode(Buffer.concat(chunks)));
  expect(JSON.stringify(records)).not.toContain(text);
});

test("a real inherited pipe stays pending after parent exit until its owned descendant releases EOF", async () => {
  const hook = capture();
  const root = await mkdtemp(join(tmpdir(), "odysseus-hook-eof-"));
  const release = join(root, "release");
  // The descendant owns the inherited pipe. A file barrier, not a guessed
  // delay, keeps it open across the observed parent-exit boundary.
  const descendant = 'import {existsSync} from "node:fs"; const end=Date.now()+10000; while(!existsSync(process.argv[1])) { if(Date.now()>end)process.exit(70); await Bun.sleep(5); } process.stdout.write("Odysseus released EOF");';
  const parent = 'Bun.spawn([process.execPath,"-e",process.argv[1],process.argv[2]],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exit(7);';
  const child = Bun.spawn([process.execPath, "-e", parent, descendant, release], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let complete = false;
  const observation = hook.child("package-build", child).then((result) => { complete = true; return result; });
  try {
    await child.exited;
    expect(records.some((r) => r.event === "exit" && r.code === 7)).toBe(true);
    expect(records.some((r) => r.event === "stdout-complete")).toBe(false);
    expect(complete).toBe(false);
    await writeFile(release, "release");
    const [out, err, code] = await observation;
    expect(out).toBe("Odysseus released EOF");
    expect(err).toBe("");
    expect(code).toBe(7);
    expect(records.some((r) => r.event === "stdout-complete")).toBe(true);
    expect(records.at(-1)?.event).toBe("complete");
  } finally {
    await writeFile(release, "release");
    await observation;
    await rm(root, { recursive: true, force: true });
  }
});


test("an existing relay rejection remains the original error", async () => {
  const hook = capture();
  const marker = new Error("private-relay-rejection-sentinel");
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from([1])); controller.close(); } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  async function relay(stream: ReadableStream<Uint8Array>) {
    for await (const _chunk of stream) throw marker;
    return "";
  }
  await expect(hook.child("package-build", { pid: 42, stdout, stderr, exited: Promise.resolve(0) }, relay)).rejects.toBe(marker);
  expect(records.some((r) => r.event === "stdout-rejected")).toBe(true);
  expect(JSON.stringify(records)).not.toContain("sentinel");
});
