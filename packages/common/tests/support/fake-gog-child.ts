/**
 * The fake gog's process side. The shim `createFakeGog` writes imports this
 * and calls {@link runFakeGog} with its own paths baked in: the transport
 * gives gog an allow-listed environment, so nothing can arrive through one.
 *
 * It records its argv, the names (never the values) of its environment, its
 * stdin and its timing, then answers as the scenario says for the command its
 * `--enable-commands-exact` names (`version` and `schema` for the pin's own
 * calls). It never reaches a network and never reads a gog home.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeGogAnswer {
  /** Written to stdout: a string as is, anything else as gog's indented JSON. */
  stdout?: unknown;
  /** Written to stdout instead: this many bytes of `x`, for the output cap. */
  stdout_bytes?: number;
  stderr?: string;
  exit?: number;
  /** Milliseconds to wait before answering. */
  delay_ms?: number;
  /** A file to wait for before answering, for tests that hold calls open. */
  wait_for?: string;
  /** Start a long-lived child in the same process group first, recording its pid. */
  grandchild?: boolean;
  /** End by this signal instead of exiting. */
  signal?: "SIGKILL" | "SIGTERM";
}

/**
 * Per command key (`gmail.search`), or per command and target
 * (`gmail.thread.get 19a0c3d2e4f50601`), one answer for every call or a
 * list consumed in order (the last repeats).
 */
export type FakeGogScenario = Record<string, FakeGogAnswer | FakeGogAnswer[]>;

export interface FakeGogCall {
  command: string;
  ordinal: number;
  argv: string[];
  env_names: string[];
  /** BUN_OPTIONS as the child saw it, so a test can tell the offline guard's own `--no-env-file` from a leaked value. */
  bun_options: string | null;
  stdin_base64: string;
  started_at: number;
  ended_at: number | null;
  pid: number;
  grandchild_pid: number | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function commandOf(argv: readonly string[]): string {
  const exact = argv.find(arg => arg.startsWith("--enable-commands-exact="));
  if (exact) return exact.slice("--enable-commands-exact=".length);
  const words = argv.filter(arg => !arg.startsWith("-"));
  return words[0] ?? "";
}

/** Claims the next ordinal for a command atomically, so concurrent fakes never share one. */
function claim(calls: string, command: string): { ordinal: number; path: string } {
  for (let ordinal = 0; ; ordinal++) {
    const path = join(calls, `${command}.${String(ordinal).padStart(4, "0")}.json`);
    try {
      closeSync(openSync(path, "wx"));
      return { ordinal, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function runFakeGog(paths: { scenario: string; calls: string }): Promise<never> {
  const argv = process.argv.slice(2);
  const command = commandOf(argv);
  const { ordinal, path } = claim(paths.calls, command);
  const stdin = new Uint8Array(await Bun.stdin.arrayBuffer());
  const call: FakeGogCall = {
    command, ordinal, argv, env_names: Object.keys(process.env).sort(), bun_options: process.env.BUN_OPTIONS ?? null, stdin_base64: Buffer.from(stdin).toString("base64"),
    started_at: Date.now(), ended_at: null, pid: process.pid, grandchild_pid: null,
  };
  // Written aside and renamed, so a reader never sees half a record.
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(call));
    renameSync(`${path}.tmp`, path);
  };
  save();
  const scenario = JSON.parse(readFileSync(paths.scenario, "utf8")) as FakeGogScenario;
  // An answer for one target (`<command> <last positional>`) wins over the command's own.
  const target = argv.includes("--") ? `${command} ${argv.at(-1)}` : null;
  const entry = (target !== null ? scenario[target] : undefined) ?? scenario[command];
  const answer: FakeGogAnswer = Array.isArray(entry) ? entry[Math.min(ordinal, entry.length - 1)] ?? {} : entry ?? { exit: 2, stderr: `fake gog: no answer for ${command}` };
  if (answer.grandchild) {
    const child = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    call.grandchild_pid = child.pid;
    save();
  }
  if (answer.wait_for) {
    const deadline = Date.now() + 20_000;
    while (!existsSync(answer.wait_for) && Date.now() < deadline) await sleep(10);
  }
  if (answer.delay_ms) await sleep(answer.delay_ms);
  if (answer.stdout_bytes) {
    const chunk = "x".repeat(64 * 1024);
    for (let written = 0; written < answer.stdout_bytes; written += chunk.length) {
      await Bun.write(Bun.stdout, chunk.slice(0, Math.min(chunk.length, answer.stdout_bytes - written)));
    }
  } else if (answer.stdout !== undefined) {
    await Bun.write(Bun.stdout, typeof answer.stdout === "string" ? answer.stdout : `${JSON.stringify(answer.stdout, null, 2)}\n`);
  }
  if (answer.stderr) await Bun.write(Bun.stderr, answer.stderr);
  call.ended_at = Date.now();
  save();
  if (answer.signal) process.kill(process.pid, answer.signal);
  process.exit(answer.exit ?? 0);
}
