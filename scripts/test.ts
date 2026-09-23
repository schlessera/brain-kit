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
 * Long flags whose value may follow as the NEXT argument (`--timeout 30000`),
 * so that argument is the flag's, not a path: every `<STR>`/`<PATH>`-valued
 * param in Bun 1.3.14's `src/cli/Arguments.zig` (runtime, transpiler, test,
 * and build params `bun test` would reject anyway). A value flag missing from
 * here has its value read as a path, which drops the default roots.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--allow-unresolved", "--asset-naming", "--banner", "--breakpoint-print",
  "--breakpoint-resolve", "--chunk-naming", "--compile-exec-argv",
  "--compile-executable-path", "--conditions", "--console-depth",
  "--coverage-dir", "--coverage-reporter", "--cpu-prof-dir",
  "--cpu-prof-interval", "--cpu-prof-name", "--cron-period", "--cron-title",
  "--cwd", "--define", "--dns-result-order", "--drop", "--elide-lines",
  "--entry-naming", "--env-file", "--eval", "--extension-order", "--external",
  "--feature", "--fetch-preconnect", "--filter", "--footer", "--format",
  "--grep", "--heap-prof-dir", "--heap-prof-name", "--import", "--install",
  "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime",
  "--loader", "--main-fields", "--max-concurrency", "--max-http-header-size",
  "--origin", "--outdir", "--outfile", "--packages", "--parallel-delay",
  "--path-ignore-patterns", "--port", "--preload", "--print", "--public-path",
  "--reporter", "--reporter-outfile", "--require", "--rerun-each", "--retry",
  "--root", "--seed", "--shard", "--shell", "--target", "--test-name-pattern",
  "--timeout", "--title", "--tsconfig-override", "--unhandled-rejections",
  "--user-agent", "--windows-copyright", "--windows-description",
  "--windows-icon", "--windows-publisher", "--windows-title",
  "--windows-version",
]);

/**
 * Short flags that take a value under `bun test`: `-t` (name pattern), `-r`
 * (preload), `-d` (define), `-l` (loader), `-e`/`-p` (eval/print). Not `-u`,
 * which is `--update-snapshots` here and takes nothing.
 */
const SHORT_VALUE_LETTERS: ReadonlySet<string> = new Set(["t", "r", "d", "l", "e", "p"]);

/**
 * Optional-valued flags (`--bail`, `--parallel`, `--changed`, `--config`, ...)
 * are deliberately absent: Bun's parser gives them a value only through `=`,
 * so a separate argument after one is a positional path to Bun too.
 */

/**
 * Whether a short-flag token (`-t`, `-ut`, `-tname`, `-t=name`) leaves its
 * value to the next argument. Bun walks the cluster left to right, and the
 * first value-taking letter takes the REST of the token as its value; only
 * when that letter ends the token does the value come from the next argument.
 */
function shortTakesNext(token: string): boolean {
  for (let i = 1; i < token.length; i++) {
    if (SHORT_VALUE_LETTERS.has(token[i]!)) return i === token.length - 1;
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
