import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invocationChild } from "../scripts/test-invocation-child";
import { processIdentity } from "../scripts/workspace-lease.mjs";

test("a process disappearing during a procfs read cannot fail a completed invocation", async () => {
  // Linux returns ESRCH when an opened /proc/<pid>/stat loses its process
  // before read(2), rather than ENOENT from opening an already absent path.
  const transient = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  const stat = openSync(`/proc/${transient.pid}/stat`, "r");
  transient.kill("SIGKILL");
  await transient.exited;
  const nativeRead = fs.readFileSync;
  const child = invocationChild([process.execPath, "-e", 'console.log("Odysseus completed");process.exitCode=21;']);
  let reader: ReturnType<typeof spyOn> | undefined;
  try {
    expect(() => nativeRead(stat, "utf8"), "THE_KERNEL_SUPPLIES_THE_REAL_PROCFS_RACE").toThrow(expect.objectContaining({ code: "ESRCH" }));
    await child.ready;
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(21);
    expect(stdout).toBe("Odysseus completed\n");
    expect(stderr).toBe("");
    let raced = 0;
    // Interpose only the cleanup scan's first procfs read. Every other read
    // stays native, and the error itself comes from the dead process's FD.
    reader = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof path === "string" && /^\/proc\/\d+\/stat$/.test(path) && raced++ === 0) return Reflect.apply(nativeRead, fs, [stat, options]);
      return Reflect.apply(nativeRead, fs, [path, options]);
    }) as typeof fs.readFileSync);
    await expect(child.finish(), "VANISHED_PROCESS_CANNOT_FAIL_COMPLETED_INVOCATION").resolves.toBeUndefined();
    expect(raced, "THE_CLEANUP_SCAN_EXERCISED_THE_RACE").toBeGreaterThan(0);
    expect(await child.exited, "COMMAND_STATUS_SURVIVES_CLEANUP").toBe(21);
    expect(child.signalCode).toBeNull();
  } finally {
    reader?.mockRestore();
    await child.finish().catch(() => {});
    closeSync(stat);
  }
});

test("an unexpected procfs read failure still refuses invocation cleanup", async () => {
  const child = invocationChild([process.execPath, "-e", 'console.log("Penelope completed");']);
  const nativeRead = fs.readFileSync;
  let reader: ReturnType<typeof spyOn> | undefined;
  try {
    await child.ready;
    expect(await child.exited).toBe(0);
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const failure = Object.assign(new Error("procfs access refused"), { code: "EACCES" });
    reader = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof path === "string" && /^\/proc\/\d+\/stat$/.test(path)) throw failure;
      return Reflect.apply(nativeRead, fs, [path, options]);
    }) as typeof fs.readFileSync);
    await expect(child.finish(), "UNEXPECTED_PROCFS_ERRORS_STILL_FAIL_CLOSED").rejects.toBe(failure);
  } finally {
    reader?.mockRestore();
    await child.finish().catch(() => {});
  }
});

test("cancellation before the anchor handshake never launches the command", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-anchor-start-"));
  const marker = join(root, "launched");
  const child = invocationChild([process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"launched");`]);
  try {
    const stopped = child.stop("SIGTERM");
    await expect(child.ready).rejects.toThrow("before command startup");
    await Promise.all([stopped, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).not.toBe(0);
    expect(existsSync(marker), "CANCEL_BEFORE_LAUNCH_HAS_NO_COMMAND").toBe(false);
    expect(child.cancelled).toBe(true);
  } finally { await child.finish(); rmSync(root, { recursive: true, force: true }); }
});

test("normal completion preserves command status and stops descendants after both output EOFs", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-anchor-finish-"));
  const marker = join(root, "descendant");
  const child = invocationChild(["node", "-e", `
const fs=require("node:fs"), {spawn}=require("node:child_process");
const c=spawn("node",["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});c.unref();
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:c.pid,start:fs.readFileSync("/proc/"+c.pid+"/stat","utf8").split(") ")[1].split(" ")[19]}));
console.log("Odysseus stdout");console.error("Penelope stderr");process.exitCode=21;`]);
  let descendant: { pid: number; start: string } | undefined;
  try {
    await child.ready;
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    descendant = JSON.parse(readFileSync(marker, "utf8"));
    expect(code, "ACTUAL_COMMAND_EXIT_CODE").toBe(21);
    expect(stdout).toBe("Odysseus stdout\n"); expect(stderr).toBe("Penelope stderr\n");
    expect(child.resourceUsage()?.cpuTime.user).toBeGreaterThan(0);
    expect(processIdentity(descendant!.pid)?.start, "DESCENDANT_OUTLIVES_COMMAND_AND_OUTPUT").toBe(descendant!.start);
    await child.finish();
    const end = Date.now() + 1_000;
    while (processIdentity(descendant!.pid)?.start === descendant!.start && Date.now() < end) await Bun.sleep(10);
    expect(processIdentity(descendant!.pid)?.start, "FINISH_STOPS_OWNED_GROUP").not.toBe(descendant!.start);
    expect(child.cancelled).toBe(false); expect(child.signalCode).toBeNull(); expect(await child.exited).toBe(21);
  } finally {
    await child.stop("SIGTERM"); await child.finish();
    if (descendant && processIdentity(descendant.pid)?.start === descendant.start) process.kill(descendant.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
