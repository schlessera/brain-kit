/**
 * The one `/proc/<pid>/stat` parser and child scan (#4765), against real
 * processes this test spawns, and the three sites that list a process's
 * children: the launcher's sandbox lookup, the status gate's refusal kill and
 * maintenance cancellation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { killWorker, registerWorker, workerStopCompletion } from "../src/server/maintenance-worker-kill.js";
import { parseProcStat, procChildren, readProcStat } from "../src/server/proc-identity.js";
import { sandboxPid } from "../src/server/worker-launcher.js";
import { killGatedSandbox } from "../src/server/worker-status.js";

const spawned: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of spawned.splice(0)) { child.kill("SIGKILL"); await child.exited; }
});

/** A shell that runs `/bin/true` to completion (an exited, reaped child), then keeps one live `sleep` and prints its PID. */
async function parentWithOneLiveChild(): Promise<{ parent: Bun.Subprocess<"ignore", "pipe", "inherit">; live: number }> {
  const parent = Bun.spawn(["/bin/sh", "-c", "/bin/true; sleep 60 & echo $!; wait"], { stdout: "pipe" });
  spawned.push(parent);
  const reader = parent.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  reader.releaseLock();
  return { parent, live: Number(text.trim()) };
}

/** A real `stat` line: 52 fields, the command name holding `) `, spaces and a newline. */
function statLine(fields: Partial<Record<number, string>>): string {
  const rest = Array.from({ length: 50 }, (_, index) => fields[index] ?? String(index + 100));
  return `4242 (Odysseus) at\nIthaca) ${rest.join(" ")}\n`;
}

describe("parseProcStat", () => {
  test("reads state, parent and start time past a command name holding ') ', spaces and a newline", () => {
    expect(parseProcStat(statLine({ 0: "S", 1: "7", 19: "987654" })), "PROC_STAT_FIELDS").toEqual({ state: "S", parent: 7, start: "987654" });
  });
  test("throws for a line whose start time is not a number", () => {
    expect(() => parseProcStat(statLine({ 0: "S", 1: "7", 19: "Penelope" })), "PROC_STAT_START_REFUSED").toThrow("Invalid process stat line");
  });
  test("throws for a line whose parent is not a number", () => {
    expect(() => parseProcStat(statLine({ 0: "S", 1: "Telemachus", 19: "987654" }))).toThrow("Invalid process stat line");
  });
  test("throws for a line cut short before the start time", () => {
    expect(() => parseProcStat("4242 (Odysseus) S 7 4242\n")).toThrow("Invalid process stat line");
  });
});

describe("readProcStat and procChildren on real processes", () => {
  test("a live child is found with its parent and the kernel's start time", async () => {
    const { parent, live } = await parentWithOneLiveChild();
    const stat = readProcStat(live)!;
    expect(stat.parent, "LIVE_CHILD_PARENT").toBe(parent.pid);
    expect(stat.start).toBe(readFileSync(`/proc/${live}/stat`, "utf8").split(" ")[21]);
    // The state of a starting child may change between reads; its identity may not.
    expect(procChildren(parent.pid).map(({ pid, parent, start }) => ({ pid, parent, start })), "LIVE_CHILD_LISTED")
      .toEqual([{ pid: live, parent: parent.pid, start: stat.start }]);
    expect(readProcStat(parent.pid, String(parent.pid))?.parent, "TASK_STAT").toBe(process.pid);
  });

  test("an exited and reaped child yields nothing", async () => {
    const child = Bun.spawn(["/bin/true"]);
    await child.exited;
    expect(readProcStat(child.pid), "REAPED_CHILD_GONE").toBeUndefined();
    expect(procChildren(process.pid).map(entry => entry.pid), "REAPED_CHILD_NOT_LISTED").not.toContain(child.pid);
    expect(procChildren(child.pid), "GONE_PARENT_HAS_NO_CHILDREN").toEqual([]);
  });

  test("a child forked from a non-main thread is found", async () => {
    // A Bun Worker runs on its own thread; the kernel records its spawn in that task's children file only.
    const worker = new Worker(URL.createObjectURL(new Blob([
      "const child = Bun.spawn(['sleep', '60']); postMessage(child.pid);"], { type: "application/javascript" })));
    const pid = await new Promise<number>(resolve => { worker.onmessage = event => resolve(event.data as number); });
    try {
      expect(readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/),
        "SPAWNED_OFF_THE_MAIN_THREAD").not.toContain(String(pid));
      expect(procChildren(process.pid).find(entry => entry.pid === pid)?.parent, "NON_MAIN_THREAD_CHILD_LISTED").toBe(process.pid);
    } finally { process.kill(pid, "SIGKILL"); worker.terminate(); }
  });
});

describe("child scan sites", () => {
  test("sandboxPid returns the one live child and never the exited one", async () => {
    const { parent, live } = await parentWithOneLiveChild();
    expect(sandboxPid(parent.pid, Date.now() + 5_000), "SANDBOX_PID_LIVE_CHILD").toBe(live);
  });

  test("sandboxPid does not count an exited child: a live parent with none times out, an exited one is reported", async () => {
    const parent = Bun.spawn(["/bin/sh", "-c", "/bin/true; echo ready; exec sleep 60"], { stdout: "pipe" });
    spawned.push(parent);
    const reader = parent.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    expect(() => sandboxPid(parent.pid, Date.now() + 100), "SANDBOX_PID_EXITED_CHILD").toThrow("bubblewrap did not start its sandbox in time");
    const gone = Bun.spawn(["/bin/true"]);
    await gone.exited;
    expect(() => sandboxPid(gone.pid, Date.now() + 5_000), "SANDBOX_PID_EXITED_PARENT").toThrow("bubblewrap exited before it started its sandbox");
  });

  test("killGatedSandbox kills and returns the live child of its supervisor, not the exited one", async () => {
    const { parent, live } = await parentWithOneLiveChild();
    const start = readProcStat(live)!.start;
    expect(killGatedSandbox(parent, undefined), "GATED_KILL_LIVE_CHILD_ONLY").toEqual([{ pid: live, start }]);
    await parent.exited;
    const after = readProcStat(live);
    expect(after === undefined || after.start !== start || after.state === "Z", "GATED_KILL_CHILD_DEAD").toBe(true);
  });

  test("maintenance cancellation kills the live child of its worker and passes over the exited one", async () => {
    const { parent, live } = await parentWithOneLiveChild();
    const start = readProcStat(live)!.start;
    registerWorker(parent);
    killWorker(parent);
    await workerStopCompletion(parent);
    await parent.exited;
    const after = readProcStat(live);
    expect(after === undefined || after.start !== start || after.state === "Z", "CANCELLATION_KILLS_LIVE_CHILD").toBe(true);
  });
});
