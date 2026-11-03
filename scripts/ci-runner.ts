/** Concurrent independent checks, with child cleanup on failure/cancellation. */
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CheckPlan } from "./ci-plan";
import { balanceTests } from "./test-shards";

export interface Settled { exitCode: number | null; signal: string | null; elapsedMs: number; timedOut: boolean; stopped: boolean; }
export interface Command {
  name: string; argv: string[]; env?: Record<string, string>; compilerRuntime?: boolean; completed?: (elapsedMs: number) => void;
  /** Kill the check's process group after this many milliseconds and report it as timed out. */
  timeoutMs?: number;
  started?: () => void;
  /** Every spawned check settles exactly once: finished, failed, timed out or stopped by the runner. */
  settled?: (result: Settled) => void;
}

export function verificationCommands(plan: CheckPlan, root: string): Command[] {
  const commands: Command[] = [];
  for (const file of plan.tests) if (!Bun.file(join(root, file)).size) {
    throw new Error(`Selected CI test is missing: ${file}`);
  }
  if (plan.typecheck) commands.push({ name: "strict typecheck", argv: [process.execPath, "run", "typecheck", "--extendedDiagnostics"],
    env: { NODE_OPTIONS: "--max-old-space-size=4096" }, compilerRuntime: true });
  if (plan.tests.length && (!plan.local.fullTests || plan.cadence === "feedback")) {
    const batches = balanceTests(plan.tests, Math.min(2, plan.tests.length));
    for (const [index, files] of batches.entries()) commands.push({ name: `fast contract and integrity tests ${index + 1}/${batches.length}`,
      argv: [process.execPath, "run", "test", ...files.map(file => join(root, file))], env: { BRAIN_WORKSPACE_ACCESS: "read" } });
  }
  return commands;
}

let receiptWriteFailed = false;

/** Receipts contain names/status only, never command environments or credentials. */
function receipt(value: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value });
  console.log(`BRAIN_CHECK_COMMAND ${line}`);
  if (process.env.CI_COMMAND_RECEIPTS) {
    try { appendFileSync(process.env.CI_COMMAND_RECEIPTS, `${line}\n`); }
    catch { receiptWriteFailed = true; console.error("Command receipt file unavailable; completion evidence is incomplete"); }
  }
}

export async function runCommands(commands: readonly Command[], cwd: string, concurrency = 2, cleanupGraceMs = 1000): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Check concurrency must be a positive integer");
  if (!Number.isSafeInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > 60_000) throw new Error("Invalid coordinator cleanup grace");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const stopped = new Set<ReturnType<typeof Bun.spawn>>();
  let interrupted = false;
  let failed = false;
  let next = 0;
  const stop = (signal: "SIGINT" | "SIGTERM" | "SIGHUP" = "SIGTERM") => {
    for (const child of children) {
      try {
        if (child.exitCode === null) stopped.add(child);
        // Include compilers/CLI grandchildren, not just their Bun wrapper.
        if (process.platform === "win32") { if (child.exitCode === null) child.kill(signal); }
        else process.kill(-child.pid, signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  };
  const interrupt = () => { interrupted = true; stop(); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupt);
  try {
    const pending = Array.from({ length: Math.min(concurrency, commands.length) }, async () => {
      while (next < commands.length && !failed && !interrupted) {
        const command = commands[next++]!;
        const id = crypto.randomUUID();
        try {
          console.log(`Checking ${command.name}`);
          const started = performance.now();
          receipt({ event: "start", id, name: command.name });
          const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", CI_COMMAND_RECEIPTS: "", ...command.env };
          if (command.compilerRuntime) {
            // Same Bun-run binary lookup and env as tsc's Node shebang. A failed
            // observation never replaces the compiler command or its error.
            try {
              const probe = Bun.spawnSync([process.execPath, "run", "node", join(import.meta.dir, "ci-compiler-runtime.cjs")],
                { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
              const output = new TextDecoder().decode(probe.stdout).trim();
              console.log(probe.exitCode === 0 && output.startsWith("BRAIN_COMPILER_RUNTIME {") ? output : "BRAIN_COMPILER_RUNTIME unavailable");
            } catch { console.log("BRAIN_COMPILER_RUNTIME unavailable"); }
          }
          const child = Bun.spawn(command.argv, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"], env });
          children.push(child);
          command.started?.();
          let timedOut = false, force: ReturnType<typeof setTimeout> | undefined;
          const budget = command.timeoutMs === undefined ? undefined : setTimeout(() => {
            timedOut = true;
            const kill = (signal: "SIGTERM" | "SIGKILL") => {
              try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            };
            kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), cleanupGraceMs);
          }, command.timeoutMs);
          const code = await child.exited;
          clearTimeout(budget); clearTimeout(force);
          const elapsedMs = performance.now() - started;
          const wasStopped = interrupted || stopped.has(child);
          receipt({ event: timedOut || wasStopped ? "interrupted" : "finish", id, name: command.name,
            elapsedMs, exitCode: code, signal: child.signalCode ?? null, ...(timedOut ? { timedOut } : {}) });
          command.completed?.(elapsedMs);
          command.settled?.({ exitCode: code, signal: child.signalCode ?? null, elapsedMs, timedOut, stopped: wasStopped && !timedOut });
          if (timedOut) throw new Error(`${command.name} timed out after ${command.timeoutMs} ms`);
          if (code !== 0 || child.signalCode) throw new Error(`${command.name} failed (${child.signalCode ?? code})`);
        } catch (error) { failed = true; throw error; }
      }
    });
    await Promise.all(pending);
    if (interrupted) throw new Error("Checks interrupted");
  } catch (error) {
    stop();
    const force = setTimeout(() => {
      for (const child of children) {
        try {
          if (process.platform === "win32") { if (child.exitCode === null) child.kill("SIGKILL"); }
          else process.kill(-child.pid, "SIGKILL");
        } catch { /* A group that already exited needs no cleanup. */ }
      }
    }, cleanupGraceMs);
    try { await Promise.allSettled(children.map(child => child.exited)); }
    finally { clearTimeout(force); }
    throw error;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupt);
  }
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    if (process.env.CI_COMMAND_RECEIPTS) writeFileSync(process.env.CI_COMMAND_RECEIPTS, "");
    const plan = await Bun.file(process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json")).json() as CheckPlan;
    await runCommands(verificationCommands(plan, root), root);
    if (receiptWriteFailed) throw new Error("Command completion evidence is incomplete");
    receipt({ event: "complete" });
    if (receiptWriteFailed) throw new Error("Command completion evidence is incomplete");
  } catch (error) { console.error(error); process.exit(1); }
}
