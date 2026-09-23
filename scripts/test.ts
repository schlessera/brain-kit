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

/** What runs when the caller names no path. */
export const DEFAULT_ROOTS: readonly string[] = ["packages", "tests"];

/**
 * `bun test` flags that take a value, which may follow as the next argument
 * (`-t pattern`, `--timeout 30000`). That next argument is the flag's, not a
 * path. The `bun test --help` flags spelled `=<val>`, plus the runtime flags
 * `bun test` also accepts.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "-t",
  "--test-name-pattern",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "-r",
  "--preload",
  "--env-file",
  "--cwd",
  "-c",
  "--config",
  "--conditions",
  "-d",
  "--define",
  "-l",
  "--loader",
  "--tsconfig-override",
]);

/**
 * Flags whose value is optional. A following argument is theirs only when it
 * is a number; `--changed` takes a git ref, which cannot be told apart from a
 * path, so it must be spelled `--changed=<ref>`.
 */
const OPTIONAL_NUMBER_FLAGS: ReadonlySet<string> = new Set(["--bail", "--parallel"]);

/** The `bun test` argv for the arguments `bun run test` received. */
export function testArgv(args: readonly string[]): string[] {
  let hasPath = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      hasPath ||= i + 1 < args.length;
      break;
    }
    if (arg.startsWith("-")) {
      if (arg.includes("=")) continue;
      if (VALUE_FLAGS.has(arg)) i++;
      else if (OPTIONAL_NUMBER_FLAGS.has(arg) && /^\d+$/.test(args[i + 1] ?? "")) i++;
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
  process.exit(await proc.exited);
}
