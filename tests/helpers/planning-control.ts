/** Native, test-owned process census. The observer itself always reads real /proc. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const controlFile = join(import.meta.dir, "planning-control-fixture.ts");
const preload = resolve(import.meta.dir, "../../scripts/test-network-child-preload.ts");
export const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function until(predicate: () => boolean, message: string, budgetMs = 5_000): void {
  const deadline = performance.now() + budgetMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    pause(5);
  }
}

/** CPU work has a fixed target and a separate wall failure cap, not a host CPU-share assumption. */
export function burnCpu(ms: number): number {
  const before = process.cpuUsage();
  const deadline = performance.now() + 5_000;
  let used = 0;
  while (used < ms) {
    for (let i = 0; i < 10_000; i++) Math.sqrt(i);
    const now = process.cpuUsage(before);
    used = (now.user + now.system) / 1_000;
    if (performance.now() >= deadline) throw new Error("CONTROL_CPU_BUDGET_EXHAUSTED");
  }
  return used;
}

export function census(): number[] { return readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number); }
export function identity(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]!; }
  catch { return null; }
}
export function bunControl(mode: string, dir: string, ...args: string[]): string[] {
  return [process.execPath, "--preload", preload, controlFile, mode, dir, ...args];
}
export function isolatedControl(mode: string, dir: string): string[] {
  return ["bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/", "/", "--bind", dir, dir, "--proc", "/proc", "--dev", "/dev", "--cap-drop", "ALL",
    ...bunControl(mode, dir)];
}

/** Both actual pipe EOFs and child exit are required; killing the owned namespace removes descendants. */
export async function runControl(mode: string, dir: string) {
  const child = Bun.spawn(isolatedControl(mode, dir), { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(deadline); child.kill("SIGKILL"); await child.exited; }
}

/** Children wait for a rendezvous, consume bounded CPU, then stay alive for the final census. */
export async function withCompetitors<T>(dir: string, count: number, call: (pids: number[]) => Promise<T>): Promise<T> {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const drains: Promise<[string, string, number]>[] = [];
  const births = new Map<number, string | null>();
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    for (let i = 0; i < count; i++) {
      const child = Bun.spawn(bunControl("competitor-child", dir, String(i), String(count === 1 ? 800 : 80)), { stdout: "pipe", stderr: "pipe" });
      children.push(child); births.set(child.pid, identity(child.pid));
      drains.push(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]));
    }
    const deadline = performance.now() + 5_000;
    while (!children.every((_, i) => existsSync(join(dir, `ready-${i}`)))) {
      if (performance.now() >= deadline) throw new Error("COMPETITOR_START_BUDGET_EXHAUSTED");
      await Bun.sleep(5);
    }
    result = await call(children.map(child => child.pid));
  } catch (error) { failures.push(error); } finally {
    for (const child of children) child.kill("SIGKILL");
    const outcomes = await Promise.allSettled(drains);
    for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
    for (let i = 0; i < children.length; i++) {
      if (children[i]!.signalCode !== "SIGKILL") {
        failures.push(new Error(`COMPETITOR_EXITED_BEFORE_OWNED_CLEANUP: ${JSON.stringify(outcomes[i])}`));
      }
    }
    for (const [pid, birth] of births) {
      if (birth !== null && identity(pid) === birth) failures.push(new Error("OWNED_COMPETITOR_SURVIVED_CLEANUP"));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "CONTROL_AND_CLEANUP_FAILED");
  return result as T;
}
