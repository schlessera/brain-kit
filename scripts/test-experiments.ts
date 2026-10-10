/**
 * The experiment tier: tests that exercise only measurement and eval harnesses
 * (#1386). They live under `experiments/`, outside the default product roots
 * (scripts/test.ts `DEFAULT_ROOTS`), so `bun run test`, `check:pr` and hosted
 * CI never select them. Release preparation runs the whole tier instead:
 *
 *   bun run test:experiments            # the complete tier, offline, then a receipt
 *   bun run test experiments/<file>     # one file while debugging; no receipt
 *
 * `bun run test:experiments` goes through the same wrapper and offline preload
 * as `bun run test`, and records `tmp/experiment-tier-receipt.json` only when
 * every inventoried file ran with no failure, skip or todo. The receipt names
 * the candidate it tested: the content tree of the working tree (tracked and
 * untracked, not ignored), the HEAD it sat on, the `bun.lock` hash, the
 * experiment file inventory and the Bun version. `scripts/publish.ts` refuses a
 * release unless the receipt matches the checkout it is about to publish, so a
 * change to any of those after the run (including the lock refresh in
 * `bun run version`) needs a fresh run.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { discoverTests } from "./test-shards";

/** The experiment tier's only root. Outside `DEFAULT_ROOTS` by construction. */
export const EXPERIMENT_ROOT = "experiments";
export const RECEIPT_PATH = "tmp/experiment-tier-receipt.json";
export const RECEIPT_SCHEMA = "brain-kit/experiment-tier-receipt@1";

/**
 * External programs the tier's offline launchers need: the bwrap and
 * `unshare --net` namespaces, the Python launchers, and the capability drop.
 * A missing one fails the tier rather than letting a test skip or fail later
 * for a reason that is not about the harness.
 */
export const REQUIRED_TOOLS = ["python3", "bwrap", "unshare", "setpriv", "ip", "sh"] as const;

export interface Candidate {
  /** `git write-tree` over the working tree as `git add -A` would stage it. */
  tree: string;
  /** The commit the tree was checked on. Informational: a later commit of the same tree stays valid. */
  head: string;
  lock: { path: "bun.lock"; sha256: string };
  inventory: { root: string; files: string[]; sha256: string };
  bun: string;
}

export interface TierResult {
  exitCode: number;
  files: string[];
  tests: number;
  failures: number;
  skipped: number;
}

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  candidate: Candidate;
  result: { files: number; tests: number; failures: 0; skipped: 0 };
  recordedAt: string;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function git(root: string, args: string[], env?: Record<string, string>): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

/**
 * The tree `git add -A && git write-tree` would produce, without touching the
 * real index: tracked edits, staged or not, and untracked files that are not
 * ignored all count. Ignored output (`tmp/`, `dist/`, `node_modules/`) does
 * not; the lock hash stands in for the installed dependencies.
 */
export function workingTree(root: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "experiment-tier-index-"));
  try {
    const index = join(scratch, "index");
    const real = git(root, ["rev-parse", "--git-path", "index"]);
    const realPath = isAbsolute(real) ? real : join(root, real);
    if (existsSync(realPath)) copyFileSync(realPath, index);
    const env = { GIT_INDEX_FILE: index };
    git(root, ["add", "-A", "--", "."], env);
    return git(root, ["write-tree"], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function inventory(root: string): Candidate["inventory"] {
  const files = discoverTests(root, [EXPERIMENT_ROOT]);
  return { root: EXPERIMENT_ROOT, files, sha256: sha256(files.join("\n")) };
}

/** What the tier would test if it ran now, or what a release would publish. */
export function candidate(root: string): Candidate {
  return {
    tree: workingTree(root),
    head: git(root, ["rev-parse", "HEAD"]),
    lock: { path: "bun.lock", sha256: sha256(readFileSync(join(root, "bun.lock"))) },
    inventory: inventory(root),
    bun: Bun.version,
  };
}

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * Bun 1.4.2's JUnit report: one root `<testsuites>` with totals (todo counts
 * as skipped), and one top-level `<testsuite>` per executed file whose `name`
 * is its path. Nested describe suites carry a `line` and are not files.
 */
export function readJunit(xml: string): Omit<TierResult, "exitCode"> {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  if (!root) throw new Error("The experiment tier wrote no JUnit report");
  const number = (name: string) => {
    const value = Number(attribute(root, name));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`The JUnit report has no valid ${name} total`);
    return value;
  };
  const files = new Set<string>();
  for (const [tag] of xml.matchAll(/<testsuite\b[^>]*>/g)) {
    const name = attribute(tag, "name"), file = attribute(tag, "file");
    if (name !== undefined && name === file && attribute(tag, "line") === undefined) files.add(name);
  }
  return { files: [...files].sort(), tests: number("tests"), failures: number("failures"), skipped: number("skipped") };
}

/** Why a finished run does not prove the tier for `expected`. Empty means it does. */
export function runProblems(expected: Candidate, result: TierResult, after: Candidate): string[] {
  const problems: string[] = [];
  if (result.exitCode !== 0) problems.push(`bun test exited ${result.exitCode}`);
  if (result.failures !== 0) problems.push(`${result.failures} test(s) failed`);
  if (result.skipped !== 0) problems.push(`${result.skipped} test(s) were skipped or todo; the tier admits neither`);
  if (expected.inventory.files.length === 0) problems.push(`${EXPERIMENT_ROOT}/ has no test files`);
  if (result.tests === 0) problems.push("no test executed");
  const ran = new Set(result.files);
  const missing = expected.inventory.files.filter((file) => !ran.has(file));
  const unexpected = result.files.filter((file) => !expected.inventory.files.includes(file));
  if (missing.length) problems.push(`${missing.length} inventoried file(s) did not execute: ${missing.join(", ")}`);
  if (unexpected.length) problems.push(`file(s) outside the inventory executed: ${unexpected.join(", ")}`);
  problems.push(...candidateProblems(expected, after).map((problem) => `the run changed its own candidate: ${problem}`));
  return problems;
}

/** Field-by-field differences between a recorded candidate and the current one. */
export function candidateProblems(recorded: Candidate, current: Candidate): string[] {
  const problems: string[] = [];
  if (recorded.tree !== current.tree) problems.push(`source tree ${recorded.tree} is not the current ${current.tree}`);
  if (recorded.lock.sha256 !== current.lock.sha256) problems.push("bun.lock changed since the run");
  if (recorded.inventory.sha256 !== current.inventory.sha256 ||
      recorded.inventory.files.join("\n") !== current.inventory.files.join("\n")) problems.push("the experiment test inventory changed since the run");
  if (recorded.bun !== current.bun) problems.push(`the run used Bun ${recorded.bun}, this is Bun ${current.bun}`);
  return problems;
}

/** Why `receipt` is not release evidence for `current`. Empty means it is. */
export function receiptProblems(receipt: unknown, current: Candidate): string[] {
  const value = receipt as Partial<Receipt> | null;
  if (!value || typeof value !== "object" || value.schema !== RECEIPT_SCHEMA || !value.candidate || !value.result) {
    return ["the receipt is not an experiment-tier receipt"];
  }
  const problems = candidateProblems(value.candidate, current);
  const { result } = value;
  if (result.failures !== 0 || result.skipped !== 0) problems.push("the recorded run had failures or skips");
  if (result.files !== current.inventory.files.length || !(result.tests > 0)) problems.push("the recorded run did not execute the complete inventory");
  return problems;
}

/**
 * The release-preparation gate. Throws unless a receipt from a complete,
 * clean `bun run test:experiments` names exactly this candidate.
 */
export function assertExperimentReceipt(root: string, current: Candidate = candidate(root)): void {
  const path = join(root, RECEIPT_PATH);
  const rerun = "Run `bun run test:experiments` on this candidate (after `bun run version`), then release again.";
  if (!existsSync(path)) throw new Error(`Release refused: no experiment-tier receipt at ${RECEIPT_PATH}. ${rerun}`);
  let receipt: unknown;
  try { receipt = JSON.parse(readFileSync(path, "utf8")); } catch { receipt = null; }
  const problems = receiptProblems(receipt, current);
  if (problems.length) {
    throw new Error(`Release refused: the experiment-tier receipt does not cover this candidate:\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") + `\n${rerun}`);
  }
}

/** The `bun test` run: through the root wrapper, so the offline preload applies. */
export function experimentRunArgv(junit: string, bun: string = process.execPath): string[] {
  return [bun, join(import.meta.dir, "test.ts"), `./${EXPERIMENT_ROOT}`, "--timeout", "30000",
    "--reporter=junit", `--reporter-outfile=${junit}`];
}

/**
 * Workspace bins whose target does not exist. The workspace packages' bins
 * point into their `dist/`, so before `bun run build` they dangle, and the
 * harnesses that hash or copy the installed runtime closure (freezes, owned
 * offline sources, native receipts) fail on them: 87 failures from a cleaned
 * tree, none once built. Release preparation builds first anyway.
 */
export function danglingBins(root: string): string[] {
  const dir = join(root, "node_modules/.bin");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => lstatSync(join(dir, name)).isSymbolicLink() && !existsSync(join(dir, name)))
    .map((name) => `node_modules/.bin/${name}`).sort();
}

/** The reinstall that gives the harnesses runtime bytes they own. */
export const COPY_INSTALL = "rm -rf node_modules && bun install --frozen-lockfile --backend=copyfile";

/**
 * The first installed file that shares its inode with something outside
 * `node_modules`. Bun's default install hard-links the global cache, and the
 * freeze and offline-source harnesses refuse such runtime bytes ("Installed
 * dependency inode has external hardlinks"): 34 failures with the default
 * install, none after a copy install of the same lock. Same rule as theirs:
 * links beyond the occurrences inside the tree.
 */
export function externallyHardlinked(root: string): string | undefined {
  const top = join(root, "node_modules");
  if (!existsSync(top)) return undefined;
  const inodes = new Map<string, { path: string; seen: number; links: number }>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name), stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        const key = `${stat.dev}:${stat.ino}`, entry = inodes.get(key);
        if (entry) entry.seen++;
        else inodes.set(key, { path: full, seen: 1, links: stat.nlink });
      }
    }
  };
  walk(top);
  for (const entry of inodes.values()) if (entry.links > entry.seen) return entry.path.slice(root.length + 1);
  return undefined;
}

export function missingTools(which: (name: string) => string | null = (name) => Bun.which(name)): string[] {
  return REQUIRED_TOOLS.filter((name) => !which(name));
}

async function main(): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  if (process.argv.length > 2) {
    console.error("test:experiments takes no arguments: it runs the complete tier. " +
      "To run part of it, use `bun run test experiments/<file>` (no receipt is recorded).");
    return 2;
  }
  const receiptPath = join(root, RECEIPT_PATH);
  mkdirSync(join(root, "tmp"), { recursive: true });
  // A failed or partial run must never leave an earlier receipt in place.
  rmSync(receiptPath, { force: true });
  const missing = missingTools();
  if (missing.length) {
    console.error(`Experiment tier refused: missing ${missing.join(", ")}. These tests need them; none may be skipped.`);
    return 1;
  }
  const dangling = danglingBins(root);
  if (dangling.length) {
    console.error(`Experiment tier refused: the workspace is not built (${dangling.join(", ")} dangle). Run \`bun run build\` first.`);
    return 1;
  }
  const linked = externallyHardlinked(root);
  if (linked) {
    console.error(`Experiment tier refused: node_modules is hard-linked to Bun's cache (${linked}), which the ` +
      `offline harnesses reject. Reinstall the same lock as copies: ${COPY_INSTALL}`);
    return 1;
  }
  const namespace = Bun.spawnSync(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"]);
  if (namespace.exitCode !== 0) {
    console.error("Experiment tier refused: user/network namespaces are not permitted here; the offline launchers need them.");
    return 1;
  }
  // The JUnit report stays outside the checkout: failure messages carry
  // absolute local paths, which the whole-tree leakage gate would then flag.
  const reports = mkdtempSync(join(tmpdir(), "experiment-tier-junit-"));
  try {
    return await runTier(root, receiptPath, join(reports, "junit.xml"));
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
}

async function runTier(root: string, receiptPath: string, junitPath: string): Promise<number> {
  const before = candidate(root);
  console.log(`Experiment tier: ${before.inventory.files.length} files under ${EXPERIMENT_ROOT}/, tree ${before.tree}, HEAD ${before.head}.`);
  // CI=true makes Bun fail a file containing test.only, which would otherwise
  // hide that file's other tests from both the run and the report.
  const proc = Bun.spawn(experimentRunArgv(junitPath), { cwd: root, stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, CI: "true" } });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => proc.kill(signal));
  const exitCode = await proc.exited;
  let result: TierResult;
  try {
    result = { exitCode, ...readJunit(readFileSync(junitPath, "utf8")) };
  } catch (error) {
    console.error(`Experiment tier failed: ${error instanceof Error ? error.message : String(error)} (bun test exited ${exitCode}).`);
    return exitCode || 1;
  }
  const problems = runProblems(before, result, candidate(root));
  if (problems.length) {
    console.error(`Experiment tier failed; no receipt recorded:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    return exitCode || 1;
  }
  const receipt: Receipt = { schema: RECEIPT_SCHEMA, candidate: before,
    result: { files: result.files.length, tests: result.tests, failures: 0, skipped: 0 }, recordedAt: new Date().toISOString() };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`Experiment tier passed: ${result.tests} tests in ${result.files.length} files. Receipt: ${RECEIPT_PATH}.`);
  return 0;
}

if (import.meta.main) process.exit(await main());
