import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
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
  expect(records.find((r) => r.event === "exit")?.signal).toBeNull();
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

test("a silent signalled child retains its PID, exit code and signal", async () => {
  const hook = capture();
  const child = Bun.spawn([process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await hook.child("client-bundle", child);
  expect(out).toBe("");
  expect(err).toBe("");
  expect(code).toBe(143);
  expect(records.find((record) => record.event === "exit"), "BUNDLE_CHILD_TERMINATION_IS_ATTRIBUTED").toMatchObject({
    stage: "client-bundle", childPid: child.pid, code: 143, signal: "SIGTERM",
  });
  expect(records.some((record) => record.event === "stdout-complete" && record.bytes === 0)).toBe(true);
  expect(records.some((record) => record.event === "stderr-complete" && record.bytes === 0)).toBe(true);
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
  try {
    const release = join(root, "release");
    const identity = join(root, "identity.json");
    // The descendant owns the inherited pipe. A file barrier, not a guessed
    // delay, keeps it open across the observed parent-exit boundary.
    const descendant = 'import {existsSync,readFileSync,writeFileSync} from "node:fs"; const stat=process.platform==="linux"?readFileSync("/proc/self/stat","utf8"):null; writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,start:stat?.slice(stat.lastIndexOf(")")+2).split(" ")[19]})); const end=Date.now()+10000; while(!existsSync(process.argv[1])) { if(Date.now()>end)process.exit(70); await Bun.sleep(5); } process.stdout.write("Odysseus released EOF");process.exit(0);';
    const parent = 'const child=Bun.spawn([process.execPath,"-e",process.argv[1],process.argv[2],process.argv[3]],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.stderr.write(JSON.stringify({descendantPid:child.pid}));process.exit(7);';
    const child = Bun.spawn([process.execPath, "-e", parent, descendant, release, identity], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
      const { descendantPid } = JSON.parse(err) as { descendantPid: number };
      const owned = JSON.parse(await readFile(identity, "utf8")) as { pid: number; start?: string };
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(owned.pid).toBe(descendantPid);
      // Linux can independently distinguish this exact owned process from a
      // reused PID. A zombie has exited; reaping belongs to its actual parent.
      if (process.platform === "linux") {
        const stopped = () => ownedDescendantStopped(
          () => readFile(`/proc/${descendantPid}/stat`, "utf8"), owned.start,
        );
        const deadline = performance.now() + 1_000;
        while (!(await stopped()) && performance.now() < deadline) await Bun.sleep(5);
        expect(await stopped(), "the recorded owned descendant has terminated").toBe(true);
      }
      expect(code).toBe(7);
      expect(records.some((r) => r.event === "stdout-complete")).toBe(true);
      expect(records.at(-1)?.event).toBe("complete");
    } finally {
      try {
        await writeFile(release, "release");
      } finally {
        await observation;
      }
    }
  } finally {
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

// Local test observation only: a live PID must still match its recorded start.
async function ownedDescendantStopped(readStat: () => Promise<string>, start: string | undefined): Promise<boolean> {
  try {
    const stat = await readStat();
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[19] !== start;
  } catch (error) {
    // A path can vanish before open (ENOENT) or after open, at read (ESRCH).
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return true;
    throw error;
  }
}

test("owned descendant observation distinguishes live identity, reused identity and zombie state", async () => {
  const stat = await readFile("/proc/self/stat", "utf8");
  const stateOffset = stat.lastIndexOf(")") + 2;
  const start = stat.slice(stateOffset).split(" ")[19]!;
  expect(await ownedDescendantStopped(() => readFile("/proc/self/stat", "utf8"), start), "LIVE_MATCHING_IDENTITY_IS_NOT_STOPPED").toBe(false);
  expect(await ownedDescendantStopped(() => readFile("/proc/self/stat", "utf8"), "different-start"), "REUSED_PID_IS_NOT_THE_OWNED_PROCESS").toBe(true);
  // A controlled zombie-state record preserves the real start identity.
  const zombie = stat.slice(0, stateOffset) + "Z" + stat.slice(stateOffset + 1);
  expect(await ownedDescendantStopped(async () => zombie, start), "ZOMBIE_HAS_EXITED_EVEN_WITH_MATCHING_START").toBe(true);
});

test("an owned process disappearing after procfs open is stopped without hiding unexpected read errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "odysseus-procfs-exit-"));
  const ready = join(root, "ready");
  const child = Bun.spawn([process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1],"Odysseus ready");setInterval(()=>{},1000)', ready], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let held: Awaited<ReturnType<typeof open>> | undefined;
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    const deadline = performance.now() + 1_000;
    while (true) {
      try { expect(await readFile(ready, "utf8"), "OWNED_CHILD_ACKNOWLEDGED_READINESS").toBe("Odysseus ready"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || performance.now() >= deadline) throw error;
        await Bun.sleep(5);
      }
    }
    const path = `/proc/${child.pid}/stat`;
    const stat = await readFile(path, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    expect(await ownedDescendantStopped(() => readFile(path, "utf8"), start), "OWNED_PROCESS_IS_LIVE_BEFORE_RELEASE").toBe(false);
    held = await open(path, "r");
    child.kill("SIGKILL");
    expect(await child.exited, "EXACT_OWNED_PROCESS_EXIT_IS_JOINED").toBe(137);
    // This error comes from the kernel, not a fabricated errno or mock.
    await expect(held.readFile("utf8"), "NATIVE_PROCFS_READ_LOSES_ITS_PROCESS").rejects.toMatchObject({ code: "ESRCH", syscall: "read", errno: -3 });
    await expect(ownedDescendantStopped(() => held!.readFile("utf8"), start), "VANISHED_OWNED_PROCESS_IS_STOPPED").resolves.toBe(true);
    await expect(readFile(path, "utf8"), "FRESH_PROCFS_OPEN_SEES_ABSENT_PATH").rejects.toMatchObject({ code: "ENOENT" });
    expect(await ownedDescendantStopped(() => readFile(path, "utf8"), start), "ABSENT_OWNED_PROCESS_IS_STOPPED").toBe(true);
    await held.close();
    await expect(ownedDescendantStopped(() => held!.readFile("utf8"), start), "UNEXPECTED_NATIVE_READ_ERRORS_PROPAGATE").rejects.toMatchObject({ code: "EBADF" });
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await held?.close();
    await stdout;
    await stderr;
    await rm(root, { recursive: true, force: true });
  }
});
