import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invocationChild } from "../scripts/test-invocation-child";
import { processIdentity } from "../scripts/workspace-lease.mjs";

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
