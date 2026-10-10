/** Concurrent independent checks, with child cleanup on failure/cancellation. */
import { dirname, join, resolve } from "node:path";
import type { CheckPlan } from "./ci-plan";
import { balanceTests } from "./test-shards";

export interface Command { name: string; argv: string[]; env?: Record<string, string>; }

export function verificationCommands(plan: CheckPlan, root: string): Command[] {
  const commands: Command[] = [];
  for (const file of plan.tests) if (!Bun.file(join(root, file)).size) {
    throw new Error(`Selected CI test is missing: ${file}`);
  }
  if (plan.typecheck) commands.push({ name: "strict typecheck", argv: [process.execPath, "run", "typecheck"],
    env: { NODE_OPTIONS: "--max-old-space-size=4096" } });
  if (plan.tests.length && !plan.local.fullTests) {
    const batches = balanceTests(plan.tests, Math.min(2, plan.tests.length));
    for (const [index, files] of batches.entries()) commands.push({ name: `fast contract and integrity tests ${index + 1}/${batches.length}`,
      argv: [process.execPath, "run", "test", ...files.map(file => join(root, file))], env: { BRAIN_WORKSPACE_ACCESS: "read" } });
  }
  return commands;
}

export async function runCommands(commands: readonly Command[], cwd: string, concurrency = 2): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Check concurrency must be a positive integer");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let interrupted = false;
  let failed = false;
  let next = 0;
  const stop = (signal: "SIGINT" | "SIGTERM" | "SIGHUP" = "SIGTERM") => {
    for (const child of children) {
      try {
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
        try {
          console.log(`Checking ${command.name}`);
          const child = Bun.spawn(command.argv, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"],
            env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
              GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", ...command.env } });
          children.push(child);
          const code = await child.exited;
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
    }, 1000);
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
    const plan = await Bun.file(process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json")).json() as CheckPlan;
    await runCommands(verificationCommands(plan, root), root);
  } catch (error) { console.error(error); process.exit(1); }
}
