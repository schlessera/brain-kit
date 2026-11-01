/** Concurrent independent checks, with child cleanup on failure/cancellation. */
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CheckPlan } from "./ci-plan";
import { balanceTests } from "./test-shards";

export interface Command { name: string; argv: string[]; env?: Record<string, string>; completed?: (elapsedMs: number) => void; }

export function verificationCommands(plan: CheckPlan, root: string): Command[] {
  const commands: Command[] = [];
  for (const file of plan.tests) if (!Bun.file(join(root, file)).size) {
    throw new Error(`Selected CI test is missing: ${file}`);
  }
  if (plan.typecheck) commands.push({ name: "strict typecheck", argv: [process.execPath, "run", "typecheck", "--extendedDiagnostics"],
    env: { NODE_OPTIONS: "--max-old-space-size=4096" } });
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
          const child = Bun.spawn(command.argv, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"],
            env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
              GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", CI_COMMAND_RECEIPTS: "", ...command.env } });
          children.push(child);
          const code = await child.exited;
          const elapsedMs = performance.now() - started;
          receipt({ event: interrupted || stopped.has(child) ? "interrupted" : "finish", id, name: command.name,
            elapsedMs, exitCode: code, signal: child.signalCode ?? null });
          command.completed?.(elapsedMs);
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
