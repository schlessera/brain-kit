/**
 * The one reader of `/proc/<pid>/stat` for the worker host (#4765). A process
 * is identified by its PID together with its kernel start time, so a recycled
 * PID never matches. A leaf: it imports neither the launcher nor the sandbox.
 */
import { readFileSync, readdirSync } from "node:fs";

/** The `stat` fields the worker host reads. `start` is the kernel start time (field 22 of the line). */
export interface ProcStat { readonly state: string; readonly parent: number; readonly start: string }

const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH";

/**
 * One `stat` line. The command name may hold any byte, `)` and newlines
 * included, so the fields start after its last `)`. Throws for a line whose
 * parent or start time is not a number.
 */
export function parseProcStat(line: string): ProcStat {
  const fields = line.slice(line.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[1] ?? "")) throw new Error("Invalid process stat line");
  return { state: fields[0]!, parent: Number(fields[1]), start: fields[19]! };
}

/** A process's `stat`, or one of its tasks', or undefined once it is gone. Any other read failure or a malformed line throws. */
export function readProcStat(pid: number, task?: string): ProcStat | undefined {
  let line: string;
  try { line = readFileSync(task === undefined ? `/proc/${pid}/stat` : `/proc/${pid}/task/${task}/stat`, "utf8"); }
  catch (error) { if (gone(error)) return undefined; throw error; }
  return parseProcStat(line);
}

/** A process's task IDs, sorted; none once it is gone. */
export function procTasks(pid: number): string[] {
  try { return readdirSync(`/proc/${pid}/task`).filter(name => /^\d+$/.test(name)).sort(); }
  catch (error) { if (gone(error)) return []; throw error; }
}

/**
 * Every live child of a process: from every task's kernel `children` record
 * or, without CONFIG_PROC_CHILDREN, by parent PID. Each child is read again
 * and kept only while its parent is still `pid`, so a child that exited and
 * was reaped, or a PID reused since, is not returned.
 */
export function procChildren(pid: number): Array<ProcStat & { readonly pid: number }> {
  const found = new Set<number>();
  try {
    for (const task of procTasks(pid)) {
      for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) found.add(Number(child));
    }
  } catch (error) {
    if (!gone(error)) throw error;
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      if (readProcStat(Number(name))?.parent === pid) found.add(Number(name));
    }
  }
  return [...found].flatMap(child => { const stat = readProcStat(child); return stat?.parent === pid ? [{ pid: child, ...stat }] : []; });
}
