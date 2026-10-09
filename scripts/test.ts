/**
 * The root `bun run test` entry point.
 *
 * `bun test` ORs every positional path it is given, so a script of
 * `bun test packages tests --timeout 30000` could never be narrowed:
 * `bun run test packages/scrape` appended a third path and still ran the whole
 * suite. This wrapper adds the default roots only when the caller named no path
 * of their own, and passes Bun's flags through untouched. CI's
 * `--balanced-shard=N/3` selects files by measured costs before that run.
 *
 *   bun run test                       # packages + tests
 *   bun run test packages/scrape       # just that package
 *   bun run test --shard=1/3           # the whole suite, one shard
 *
 * The `--timeout 30000` lives in package.json, not here, so the manifest guard
 * in tests/release-manifest.test.ts still sees it on the root script.
 */

import { constants } from "node:os";
import { join, resolve } from "node:path";
import { ensureWorkspaceLease, inheritWorkspaceLease, workspaceTestAccess } from "./workspace-lease.mjs";

/** What runs when the caller names no path. */
export const DEFAULT_ROOTS: readonly string[] = ["packages", "tests"];

/**
 * Long flags whose value may follow as the NEXT argument (`--timeout 30000`),
 * so that argument is the flag's, not a path. Exactly the required-value
 * params of `TEST_PARAMS` in Bun 1.4.2's `src/runtime/cli/Arguments.rs` (test-only,
 * runtime, transpiler and base params), aliases included. Only `bun test`'s
 * own: Bun skips a long flag it does not know, so the argument after one is a
 * path to it, and must be one here too.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--conditions", "--console-depth", "--coverage-dir", "--coverage-reporter",
  "--cpu-prof-dir", "--cpu-prof-interval", "--cpu-prof-name", "--cron-period",
  "--cron-title", "--cwd", "--define", "--disable-warning",
  "--dns-result-order", "--drop", "--env-file", "--eval",
  "--extension-order", "--feature", "--fetch-preconnect", "--grep",
  "--heap-prof-dir", "--heap-prof-interval", "--heap-prof-name", "--import",
  "--install", "--jsx-factory", "--jsx-fragment", "--jsx-import-source",
  "--jsx-runtime", "--loader", "--main-fields", "--max-concurrency",
  "--max-http-header-size", "--origin", "--parallel-delay", "--path-ignore-patterns",
  "--port", "--preload", "--print", "--redirect-warnings",
  "--reporter", "--reporter-outfile", "--require", "--rerun-each",
  "--retry", "--seed", "--shard", "--stack-trace-limit",
  "--test-name-pattern", "--timeout", "--timings", "--title",
  "--trace-event-categories", "--trace-event-file-pattern", "--tsconfig-override", "--unhandled-rejections",
  "--user-agent", "--watch-kill-signal",
]);

/**
 * Short flags that take a required value under `bun test`: `-t` (name
 * pattern), `-r` (preload), `-d` (define), `-l` (loader), `-e`/`-p`
 * (eval/print). Not `-u`: `bun test` resolves it to `--update-snapshots`,
 * which takes nothing, before the runtime's `-u, --origin`.
 */
const SHORT_VALUE_LETTERS: ReadonlySet<string> = new Set(["t", "r", "d", "l", "e", "p"]);

/** Short flags with an optional value (`-c`, `--config`): they end a cluster and take nothing after it. */
const SHORT_OPTIONAL_LETTERS: ReadonlySet<string> = new Set(["c"]);

/**
 * Optional-valued long flags (`--bail`, `--parallel`, `--changed`,
 * `--config`, `--inspect*`) are deliberately absent: Bun's parser gives them a
 * value only through `=`, so a separate argument after one is a positional
 * path to Bun too.
 */

/**
 * Whether a short-flag token (`-t`, `-ut`, `-tname`, `-t=name`) leaves its
 * value to the next argument. Bun walks the cluster left to right: the first
 * required-value letter takes the REST of the token as its value, and only
 * when it ends the token does the value come from the next argument; an
 * optional-value letter ends the cluster and never reaches the next argument.
 */
function shortTakesNext(token: string): boolean {
  for (let i = 1; i < token.length; i++) {
    const letter = token[i]!;
    if (SHORT_OPTIONAL_LETTERS.has(letter)) return false;
    if (SHORT_VALUE_LETTERS.has(letter)) return i === token.length - 1;
  }
  return false;
}

/** The `bun test` argv for the arguments `bun run test` received. */
export function testArgv(args: readonly string[]): string[] {
  let hasPath = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      hasPath ||= i + 1 < args.length;
      break;
    }
    // A bare `-` is a positional to Bun, like any other path.
    if (arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--")) {
        if (!arg.includes("=") && VALUE_FLAGS.has(arg)) i++;
      } else if (shortTakesNext(arg)) {
        i++;
      }
      continue;
    }
    hasPath = true;
  }
  return hasPath ? [...args] : [...DEFAULT_ROOTS, ...args];
}

if (import.meta.main) {
  const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), workspaceTestAccess());
  if (coordinated !== undefined) process.exit(coordinated);
  let args = process.argv.slice(2);
  let argv: string[];
  try {
    const balanced: string[] = [];
    const forwarded: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") {
        forwarded.push(...args.slice(i));
        break;
      }
      if (arg === "--balanced-shard") throw new Error("Expected --balanced-shard=M/N");
      if (arg.startsWith("--balanced-shard=")) {
        balanced.push(arg);
        continue;
      }
      forwarded.push(arg);
      // A Bun flag's value can itself look like our option (e.g. -t PATTERN).
      if (arg.startsWith("--") ? !arg.includes("=") && VALUE_FLAGS.has(arg) :
          arg.startsWith("-") && shortTakesNext(arg)) {
        if (i + 1 < args.length) forwarded.push(args[++i]!);
      }
    }
    args = forwarded;
    argv = testArgv(args);
    if (balanced.length) {
      if (balanced.length !== 1 || argv.length === args.length ||
          args.some((arg) => arg.startsWith("--shard") || arg.startsWith("--cwd"))) {
        throw new Error("--balanced-shard requires the default roots and cannot combine with --shard or --cwd");
      }
      const { selectShard } = await import("./test-shards");
      argv = [...selectShard(process.cwd(), DEFAULT_ROOTS, balanced[0]!.slice("--balanced-shard=".length)), ...args];
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const proc = Bun.spawn([process.execPath, "test", "--preload", join(import.meta.dir, "test-network-preload.ts"), ...argv], inheritWorkspaceLease({
    stdio: ["inherit", "inherit", "inherit"],
  }));
  // A cancellation aimed at this process's PID (a CI runner stopping the
  // step, `kill <pid>`) must stop the tests too, not orphan them. Ctrl-C in a
  // terminal already reaches both through the foreground process group.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => proc.kill(signal));
  }
  const code = await proc.exited;
  process.exit(proc.signalCode ? 128 + (constants.signals[proc.signalCode] ?? 0) : code);
}
