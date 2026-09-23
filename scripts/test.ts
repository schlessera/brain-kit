/**
 * The root `bun run test` entry point.
 *
 * `bun test` ORs every positional path it is given, so a script of
 * `bun test packages tests --timeout 30000` could never be narrowed:
 * `bun run test packages/scrape` appended a third path and still ran the whole
 * suite. This wrapper adds the default roots only when the caller named no path
 * of their own, and passes every flag through untouched — CI's
 * `bun run test --shard=N/2` included.
 *
 *   bun run test                       # packages + tests
 *   bun run test packages/scrape       # just that package
 *   bun run test --shard=1/2           # the whole suite, one shard
 *
 * The `--timeout 30000` lives in package.json, not here, so the manifest guard
 * in tests/release-manifest.test.ts still sees it on the root script.
 */

import { constants } from "node:os";

/** What runs when the caller names no path. */
export const DEFAULT_ROOTS: readonly string[] = ["packages", "tests"];

/**
 * Flags whose value may follow as the NEXT argument (`-t pattern`,
 * `--timeout 30000`), so that argument is the flag's, not a path. Taken from
 * the `<STR>`/`<PATH>`-valued params in Bun 1.3.14's `src/cli/Arguments.zig`
 * that `bun test` accepts (runtime, transpiler and test params). A value
 * flag Bun adds later and this list lacks would have its value read as a
 * path, which drops the default roots; tests/test-script.test.ts pins the
 * shapes that matter.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--timeout", "--rerun-each", "--retry", "--seed", "--shard",
  "--coverage-reporter", "--coverage-dir", "--reporter", "--reporter-outfile",
  "--max-concurrency", "--parallel-delay", "--path-ignore-patterns",
  "-t", "--test-name-pattern", "--grep",
  "-r", "--preload", "--require", "--import",
  "--env-file", "--cwd", "--conditions", "--console-depth",
  "-d", "--define", "--drop", "--feature", "-l", "--loader",
  "--main-fields", "--extension-order", "--tsconfig-override",
  "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime",
  "-e", "--eval", "-p", "--print",
  "--cpu-prof-dir", "--cpu-prof-interval", "--cpu-prof-name",
  "--heap-prof-dir", "--heap-prof-name",
  "--dns-result-order", "--fetch-preconnect", "--max-http-header-size",
  "--unhandled-rejections", "--user-agent", "--title", "--port",
]);

/** Short flags in {@link VALUE_FLAGS}: the last letter of a cluster (`-it x`) can take the next argument. */
const SHORT_VALUE_LETTERS = new Set(
  [...VALUE_FLAGS].filter((flag) => /^-[a-z]$/i.test(flag)).map((flag) => flag[1]!)
);

/**
 * Optional-valued flags (`--bail`, `--parallel`, `--changed`, `--config`, ...)
 * are deliberately absent: Bun's parser gives them a value only through `=`,
 * so a separate argument after one is a positional path to Bun too.
 */

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
      if (arg.includes("=")) continue;
      if (arg.startsWith("--")) {
        if (VALUE_FLAGS.has(arg)) i++;
      } else if (SHORT_VALUE_LETTERS.has(arg[arg.length - 1]!)) {
        // `-t`, or a cluster such as `-ut` whose last letter takes the value.
        i++;
      }
      continue;
    }
    hasPath = true;
  }
  return hasPath ? [...args] : [...DEFAULT_ROOTS, ...args];
}

if (import.meta.main) {
  const proc = Bun.spawn([process.execPath, "test", ...testArgv(process.argv.slice(2))], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  // A cancellation aimed at this process's PID (a CI runner stopping the
  // step, `kill <pid>`) must stop the tests too, not orphan them. Ctrl-C in a
  // terminal already reaches both through the foreground process group.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => proc.kill(signal));
  }
  const code = await proc.exited;
  process.exit(proc.signalCode ? 128 + (constants.signals[proc.signalCode] ?? 0) : code);
}
