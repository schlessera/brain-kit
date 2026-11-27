/**
 * `runCliInProcess`: one `brain` invocation inside the test process (#4844).
 *
 * Its own module, not part of cli-harness.ts: the test preload imports the
 * harness, and so does every isolated copy of the test runner. This file
 * reaches the whole CLI, so only the tests that run commands in process
 * import it.
 */

import { format } from "util";

import { keylessEnv, type CliResult } from "./cli-harness";

/** The console methods a command prints through, and which stream each one writes, as the bin's Console does. */
const CONSOLE_STREAMS = { log: "stdout", info: "stdout", debug: "stdout", warn: "stderr", error: "stderr" } as const;

let inProcessCall: string[] | null = null;

/**
 * Run one `brain` invocation inside this process, through the same
 * `runBrainCli` the bin calls, and return what `runCli` would. For the call,
 * the environment is the keyless one `runCli` gives a child (plus `env`), the
 * process-wide brain context is cleared, and everything printed through
 * `console` or written to `process.stdout`/`process.stderr` is captured. All of
 * it is put back afterwards, complete property descriptors included, also when
 * the command throws.
 *
 * Not a substitute for the process boundary: stdio completion, the exit code a
 * parent sees and a signal path that calls `process.exit` stay with `runCli`.
 * A command whose module keeps state across calls, or that reloads a
 * brain.config.ts changed since this process first imported it, stays spawned.
 * Calls must not overlap: one that starts while another runs is refused.
 */
export async function runCliInProcess(root: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  // Loaded on first use, so a file that only spawns the bin does not load the CLI.
  const { runBrainCli } = await import("../src/cli/main");
  const { setContext } = await import("../src/lib/context");
  if (inProcessCall !== null) {
    throw new Error(
      `runCliInProcess(${JSON.stringify(args)}) started while runCliInProcess(${JSON.stringify(inProcessCall)}) is still running; await each call before the next`
    );
  }
  inProcessCall = args;

  const out = { stdout: [] as string[], stderr: [] as string[] };
  const which = Bun.which;
  const write = (name: "stdout" | "stderr") => (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
    out[name].push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(() => (done as () => void)());
    return true;
  };
  // Every property the call replaces: the console methods, the direct stdio
  // writes, stdio that is not a terminal, as `runCli`'s pipes are not, and the
  // PATH lookup, so it reads the call's PATH as a child's would.
  const replaced: [object, string, unknown][] = [
    ...Object.entries(CONSOLE_STREAMS).map(([key, stream]): [object, string, unknown] => [
      console, key, (...values: unknown[]) => { out[stream].push(`${format(...values)}\n`); },
    ]),
    [process.stdout, "write", write("stdout")],
    [process.stderr, "write", write("stderr")],
    [process.stdout, "isTTY", false],
    [process.stderr, "isTTY", false],
    [process.stdin, "isTTY", false],
    // Bun.which answers from the PATH the process started with unless told one.
    [Bun, "which", (command: string, options?: { PATH?: string; cwd?: string }) => which(command, { PATH: process.env.PATH, ...options })],
  ];
  const saved = replaced.map(([owner, key]) => [owner, key, Object.getOwnPropertyDescriptor(owner, key)] as const);
  const savedEnv = { ...process.env };
  const previousContext = setContext(null);
  try {
    const target = { ...keylessEnv(root), ...env };
    for (const key of Object.keys(process.env)) if (!(key in target)) delete process.env[key];
    Object.assign(process.env, target);
    for (const [owner, key, value] of replaced) {
      // A property the runtime fixed in place (Bun.which) can only be reassigned.
      if (Object.getOwnPropertyDescriptor(owner, key)?.configurable === false) (owner as Record<string, unknown>)[key] = value;
      else Object.defineProperty(owner, key, { configurable: true, enumerable: true, writable: true, value });
    }
    const code = await runBrainCli(args);
    return { stdout: out.stdout.join(""), stderr: out.stderr.join(""), code };
  } finally {
    for (const [owner, key, descriptor] of saved) {
      if (descriptor?.configurable === false) (owner as Record<string, unknown>)[key] = descriptor.value;
      else if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete (owner as Record<string, unknown>)[key];
    }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    setContext(previousContext);
    inProcessCall = null;
  }
}
