/** Focused local preflight; repeatable full proof is authoritative in hosted CI. */
import { dirname, resolve } from "node:path";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { changedFiles, planChecks, workspaces, type CheckPlan } from "./ci-plan";
import { runCommands, type Command, type Settled } from "./ci-runner";
import { checkPackages } from "./check-packages";
import { checkCategories, PREEMPTED_EXIT, RECEIPT_KIND, receiptBlock, UNPROVEN, type CheckReceipt, type Outcome, type ReceiptCheck } from "./check-receipt";
import { ensureHostAdmission } from "./host-admission.mjs";
import { discoverTests } from "./test-shards";
import { DEFAULT_ROOTS } from "./test";
import { localUnitWorkerCount } from "./unit-workers";

const ROOT = resolve(import.meta.dir, "..");

/** The complete unit tier's files, exactly as `bun run test` received them:
 * the selected root consumers, and with none named, what it discovers under its
 * default roots (`testArgv`, scripts/test.ts). */
export function localUnitInventory(plan: CheckPlan, root = ROOT): string[] {
  return plan.unitTests?.length ? [...plan.unitTests] : discoverTests(root, DEFAULT_ROOTS);
}

export function localChecks(plan: CheckPlan, full = false, mergeBase?: string, importGraph = false, importGraphWorkers?: number): Command[] {
  const bun = process.execPath;
  const checks: Command[] = [
    { name: "all lint and leakage gates", argv: [bun, "run", "lint"] },
    { name: "environment documentation", argv: [bun, "scripts/env-docs.ts", "--check"] },
    { name: "pending changeset package names", argv: [bun, "scripts/check-changeset-packages.ts"] },
  ];
  if (!full) {
    if (plan.tests.length) checks.push({ name: "affected fast invariants", argv: [bun, "run", "test", ...plan.tests.map(path => `./${path}`)] });
    if (importGraph && mergeBase) checks.push({
      name: "import-graph affected tests (feedback only; misses spawned and file-read inputs; no matches skips)",
      argv: [bun, "scripts/unit-workers.ts", `--changed=${mergeBase}`, ...(importGraphWorkers === undefined ? [] : [`--workers=${importGraphWorkers}`])],
    });
    return checks;
  }
  if (plan.typecheck) checks.push({ name: "strict typecheck", argv: [bun, "run", "typecheck"],
    env: { NODE_OPTIONS: "--max-old-space-size=6144" } });
  // Concurrent serial Bun processes over the same inventory, each in its own
  // private worktree, build and maintenance ledger; the merged report must
  // account for every file exactly once (`runUnitWorkers`, scripts/unit-workers.ts).
  if (plan.local.fullTests) checks.push({ name: "complete unit and integration suite",
    argv: [bun, "scripts/unit-workers.ts", `--workers=${localUnitWorkerCount()}`, ...localUnitInventory(plan)],
    env: { BRAIN_REQUIRE_CHROME: "1" } });
  else if (plan.tests.length) checks.push({ name: "affected fast invariants", argv: [bun, "run", "test", ...plan.tests.map(path => `./${path}`)] });
  if (plan.local.browser || plan.local.layout || plan.local.endurance) checks.push({ name: "workspace build for real browser checks", argv: [bun, "run", "build"] });
  if (plan.local.browser) checks.push({ name: "complete pinned visual/accessibility/pointer suite", argv: [bun, "run", "test:browser"] });
  if (plan.local.layout) checks.push({ name: "complete pinned layout/offline suite", argv: [bun, "run", "test:layout"] });
  if (plan.local.endurance) checks.push({ name: "complete pinned endurance suite", argv: [bun, "run", "test:endurance"] });
  if (plan.local.captures) checks.push({ name: "editorial provenance and reproducibility", argv: [bun, "run", "capture:verify"] });
  if (plan.local.runtime) {
    // Retain the production probes which used to run automatically, in the
    // same loopback-only namespace. The real renderer is also required by the
    // complete test suite above; a fake allowlist check cannot replace it.
    for (const script of ["measure-claude-runtime", "measure-claude-enforcement"]) checks.push({ name: script,
      argv: ["unshare", "--user", "--map-root-user", "--net", "sh", "-c",
        `ip link set lo up && bun scripts/${script}.ts --out tmp/${script}.json`] });
    checks.push({ name: "native delegation, capabilities and measurement isolation",
      argv: ["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "sh", "-c",
        "ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all sh -c 'bun scripts/measure-claude-delegation.ts --out tmp/delegation-probe.json && bun scripts/measure-claude-capability.ts > tmp/capability-probe.json && bun scripts/measure-claude-haiku.ts > tmp/haiku-probe.json && bun run test ./tests/measurement-isolation.test.ts ./experiments/turn-surface-runtime-placement.test.ts'"] });
    checks.push({ name: "native managed hosted admission", argv: [bun, "scripts/prove-native-host.ts"] });
    checks.push({ name: "native separate-UID worker identity", argv: [bun, "scripts/prove-worker-identity.ts"] });
    checks.push({ name: "native reference pool allocation", argv: [bun, "scripts/prove-reference-pool.ts"] });
    checks.push({ name: "shared-process Chrome then child cleanup", argv: [bun, "run", "test", "--shard=1/1",
      "packages/ui-react/tests/chat-focus-runtime.test.ts", "packages/ui-react/tests/external-speech-runtime.test.ts"],
      env: { BRAIN_REQUIRE_CHROME: "1" } });
  }
  return checks;
}

class SandboxSetupTimeout extends Error {}

/** The fastest of three sandbox setup probes must take less than this. */
const SANDBOX_SETUP_LIMIT_MS = 1000;

function probeSandboxSetup(): number {
  const start = performance.now();
  const namespace = Bun.spawnSync(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { timeout: 5000 });
  const elapsed = performance.now() - start;
  if (namespace.exitedDueToTimeout) throw new SandboxSetupTimeout();
  if (namespace.exitCode !== 0) throw new Error("Local checks require bwrap and permitted user/network namespaces; sandbox setup probe failed");
  return elapsed;
}

export function requireLocalSandbox(readMountinfo = () => readFileSync("/proc/self/mountinfo", "utf8"), probeTimer = probeSandboxSetup): void {
  if (process.platform === "linux") {
    const refuse = (measurement: string): never => {
      const entries = readMountinfo().split("\n").filter(line => line.trim().length > 0);
      // Group mount points by their immediate parent, so individually named
      // leaked bind mounts report their containing directory rather than `/`.
      const prefixes = new Map<string, number>();
      for (const entry of entries) {
        const mountpoint = entry.split(" ")[4];
        if (!mountpoint) throw new Error("Cannot read mount point from /proc/self/mountinfo");
        const decoded = mountpoint.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
        const prefix = dirname(decoded);
        prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      }
      const [prefix, count] = [...prefixes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ["(none)", 0];
      const version = Bun.spawnSync(["bwrap", "--version"], { timeout: 5000 });
      const versionText = version.exitCode === 0 ? new TextDecoder().decode(version.stdout).trim() : "bubblewrap version unavailable";
      throw new Error(`Local checks refuse slow sandbox setup: ${measurement}; ${versionText}; ${entries.length} mount entries; dominant mount-point prefix: ${prefix} (${count} entries). Use bubblewrap 0.13 or newer. Restart Docker Desktop, or on WSL2 run wsl --shutdown; then retry local preflight.`);
    };
    let fastest: number;
    try {
      fastest = Math.min(...Array.from({ length: 3 }, () => probeTimer()));
    } catch (error) {
      if (!(error instanceof SandboxSetupTimeout)) throw error;
      // The killed probe has no completed sample. Report only the budget's
      // elapsed lower bound, never a precise fastest-of-three measurement.
      return refuse(`probe timed out; setup elapsed at least 5000 ms (5000 ms probe budget; requires less than ${SANDBOX_SETUP_LIMIT_MS} ms)`);
    }
    if (fastest >= SANDBOX_SETUP_LIMIT_MS) refuse(`fastest of three ${fastest.toFixed(1)} ms (requires less than ${SANDBOX_SETUP_LIMIT_MS} ms)`);
  }
}

export function requireRuntimeTools(plan: CheckPlan): string | undefined {
  if (!Bun.semver.satisfies(Bun.version, ">=1.4.0")) throw new Error("Local checks require Bun >=1.4.0 (CI pins 1.4.2)");
  if (!Bun.which("flock")) throw new Error("Local checks require flock for workspace output coordination");
  if (plan.local.browser || plan.local.layout || plan.local.captures || plan.local.endurance) {
    if (!Bun.which("docker")) throw new Error("Pinned local browser checks require Docker");
  }
  if (!plan.local.fullTests) return undefined;
  const chrome = process.env.PUPPETEER_EXECUTABLE_PATH ??
    ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"].map(name => Bun.which(name)).find(Boolean);
  try {
    if (!chrome || !statSync(chrome).isFile()) throw new Error("Not a regular file");
    accessSync(chrome, constants.X_OK);
  } catch {
    throw new Error(`Local runtime proof requires real Chrome; set PUPPETEER_EXECUTABLE_PATH (rejected path: ${chrome ?? "not found"})`);
  }
  if (process.platform !== "linux") throw new Error("Full local runtime proof requires the Linux namespace harness; use a Linux checkout/runner");
  for (const name of ["bwrap", "unshare", "ip", "setpriv"]) if (!Bun.which(name)) throw new Error(`Local runtime proof requires ${name}`);
  const namespace = Bun.spawnSync(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"]);
  if (namespace.exitCode !== 0) throw new Error("Local runtime proof requires permitted user/network namespaces; do not accept skipped tests");
  return chrome;
}

/** One preflight step: commands run together, or an in-process task. */
/** Setup/metadata are ordered before these. Strict types run beside the unit
 * tier (both memory-bounded, neither using Docker, Chrome pins or native
 * storage); every other stage runs alone. The workspace build writes the dist
 * the type check resolves; browser, capture and native stages share Docker,
 * Chrome or the native loop and storage fixtures, and browser jobs keep their
 * measured scheduling/isolation behavior and diagnostic artifacts. */
export const CONCURRENT_LOCAL_CHECKS: ReadonlySet<string> = new Set(["strict typecheck", "complete unit and integration suite"]);

export function localStages(commands: readonly Command[]): Command[][] {
  const concurrent = commands.filter(command => CONCURRENT_LOCAL_CHECKS.has(command.name));
  return [...(concurrent.length ? [concurrent] : []), ...commands.filter(command => !CONCURRENT_LOCAL_CHECKS.has(command.name)).map(command => [command])];
}

export type PreflightStep = Command[] | { name: string; task: () => Promise<void> };
const stepNames = (step: PreflightStep) => Array.isArray(step) ? step.map(command => command.name) : [step.name];

export function newReceipt(steps: PreflightStep[], head: string, base: string, mode: CheckReceipt["mode"], now = new Date()): CheckReceipt {
  return { version: 1, kind: RECEIPT_KIND, head, base, mode, startedAt: now.toISOString(), finishedAt: null,
    checks: steps.flatMap(stepNames).map(name => ({ name, categories: checkCategories(name), outcome: "skipped" as const, reason: "not started" })) };
}

/** A check that was started but never settled reads as timed out if check:pr itself is killed. */
const RUNNING = "started; check:pr ended before it finished";

export function settledOutcome(result: Settled, timeoutMs: number | undefined): Pick<ReceiptCheck, "outcome" | "reason"> {
  if (result.timedOut) return { outcome: "timed-out", reason: `exceeded the ${timeoutMs} ms check budget` };
  if (result.stopped) return { outcome: "skipped", reason: "stopped by the runner before it finished" };
  if (result.exitCode === PREEMPTED_EXIT && !result.signal) return { outcome: "preempted", reason: "cancelled by host admission; rerun it" };
  if (result.exitCode === 0 && !result.signal) return { outcome: "passed" };
  return { outcome: "failed", reason: `exit ${result.signal ?? result.exitCode}` };
}

/**
 * Runs the steps in order and records every check's outcome in the receipt,
 * saving it after each change. A failure skips the remaining steps; a timed-out,
 * preempted or explicitly skipped check is recorded and the run continues.
 */
export async function runPreflight(steps: PreflightStep[], receipt: CheckReceipt, options: { root: string; skip?: ReadonlySet<string>;
  timeoutMs?: number; save: (receipt: CheckReceipt) => void; run?: typeof runCommands }): Promise<CheckReceipt> {
  const run = options.run ?? runCommands, skip = options.skip ?? new Set<string>();
  const set = (name: string, change: Partial<ReceiptCheck> & { outcome: Outcome }) => {
    const check = receipt.checks.find(entry => entry.name === name);
    if (!check) throw new Error(`Receipt has no check named ${name}`);
    delete check.reason; delete check.elapsedMs; Object.assign(check, change); options.save(receipt);
  };
  let stop: string | undefined;
  try {
    for (const step of steps) {
      if (stop) { for (const name of stepNames(step)) set(name, { outcome: "skipped", reason: stop }); continue; }
      if (!Array.isArray(step)) {
        if (skip.has(step.name)) { set(step.name, { outcome: "skipped", reason: "skipped with --skip" }); continue; }
        set(step.name, { outcome: "timed-out", reason: RUNNING });
        const started = performance.now();
        try { await step.task(); set(step.name, { outcome: "passed", elapsedMs: performance.now() - started }); }
        catch (error) { set(step.name, { outcome: "failed", reason: String(error).slice(0, 300), elapsedMs: performance.now() - started }); stop = `not run after ${step.name} failed`; throw error; }
        continue;
      }
      for (const command of step.filter(command => skip.has(command.name))) set(command.name, { outcome: "skipped", reason: "skipped with --skip" });
      const commands = step.filter(command => !skip.has(command.name)).map(command => ({ ...command,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        started: () => set(command.name, { outcome: "timed-out", reason: RUNNING }),
        settled: (result: Settled) => set(command.name, { ...settledOutcome(result, options.timeoutMs), elapsedMs: result.elapsedMs }) }));
      if (!commands.length) continue;
      try { await run(commands, options.root); }
      catch (error) {
        if (String(error).includes("Checks interrupted")) {
          for (const command of commands) {
            const check = receipt.checks.find(entry => entry.name === command.name)!;
            if (check.outcome === "skipped" && check.reason === "stopped by the runner before it finished" || check.reason === RUNNING) set(command.name, { outcome: "timed-out", reason: "check:pr was interrupted by a signal while it ran" });
          }
          stop = "not run: check:pr was interrupted";
          throw error;
        }
        const failed = commands.filter(command => receipt.checks.find(entry => entry.name === command.name)!.outcome === "failed");
        if (failed.length || commands.some(command => receipt.checks.find(entry => entry.name === command.name)!.reason === "not started")) {
          stop = `not run after ${failed.map(command => command.name).join(", ") || "an earlier check"} failed`;
          throw error;
        }
      }
    }
  } finally {
    if (stop) for (const check of receipt.checks) if (check.reason === "not started") Object.assign(check, { reason: stop });
    receipt.finishedAt = new Date().toISOString(); options.save(receipt);
  }
  return receipt;
}

export function writeReceipt(path: string, receipt: CheckReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  // Replace atomically so a killed run never leaves a truncated receipt.
  writeFileSync(`${path}.tmp`, JSON.stringify(receipt, null, 2) + "\n"); renameSync(`${path}.tmp`, path);
}

export const RECEIPT_PATH = "tmp/check-pr-receipt.json";

if (import.meta.main) {
  try {
    const args = process.argv.slice(2); let base = "origin/main"; let all = false; let full = false; let print = false; let importGraph = false; let importGraphWorkers: number | undefined;
    let receiptPath = RECEIPT_PATH, timeoutMs: number | undefined; const skip = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--base" && args[i + 1]) base = args[++i]!;
      else if (args[i] === "--receipt" && args[i + 1]) receiptPath = args[++i]!;
      else if (args[i] === "--skip" && args[i + 1]) skip.add(args[++i]!);
      else if (/^--check-timeout=[1-9]\d*$/.test(args[i]!)) timeoutMs = Number(args[i]!.slice("--check-timeout=".length)) * 1000;
      else if (args[i] === "--all") { all = true; full = true; }
      else if (args[i] === "--full") full = true;
      else if (args[i] === "--import-graph") importGraph = true;
      else if (args[i] === "--plan") print = true;
      else if (/^--import-graph-workers=[1-9]\d*$/.test(args[i]!)) {
        importGraphWorkers = Number(args[i]!.slice("--import-graph-workers=".length));
        if (!Number.isSafeInteger(importGraphWorkers)) throw new Error("Import-graph workers must be a positive integer");
      }
      else throw new Error("usage: bun run check:pr [--base <ref>] [--full|--all] [--import-graph] [--plan] [--import-graph-workers=N] [--check-timeout=<seconds>] [--skip <check name>]... [--receipt <path>]");
    }
    const root = ROOT;
    const changed = all ? ["package.json"] : changedFiles(root, base, "HEAD", true, true);
    const plan = planChecks(changed, workspaces(root), root);
    let mergeBase: string | undefined;
    if (!full && importGraph) {
      const merge = Bun.spawnSync(["git", "merge-base", base, "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (merge.exitCode !== 0) throw new Error(`Cannot determine import-graph feedback merge base: ${new TextDecoder().decode(merge.stderr)}`);
      mergeBase = new TextDecoder().decode(merge.stdout).trim();
    }
    const commands = localChecks(plan, full, mergeBase, importGraph, importGraphWorkers);
    const contributionChangeset: Command = { name: "contribution changeset", argv: [process.execPath, "scripts/check-changeset.ts", base] };
    const plannedCommands = [...commands.slice(0, 3), contributionChangeset, ...commands.slice(3)];
    const importGraphFeedback = full ? "skipped: --full/--all retain their existing suites" :
      importGraph ? "enabled with --import-graph" : "skipped by default; enable with --import-graph";
    console.log(JSON.stringify({ ...plan, commands: plannedCommands.map(command => command.name), commandDetails: plannedCommands,
      importGraphFeedback, packedConsumerChecks: full && plan.pack, hostedProofRequired: plan.local }, null, 2));
    if (print) process.exit(0);
    const chromeStep: Command = { name: "first real Chrome launch and render", argv: [] };
    const steps: PreflightStep[] = [...commands.slice(0, 3).map(command => [command]), [contributionChangeset],
      ...(full && plan.local.captures ? [[{ name: "pinned capture fonts and original notices", argv: [process.execPath, "run", "capture:fonts"] }]] : []),
      ...(full && plan.local.fullTests ? [[chromeStep]] : []),
      ...localStages(commands.slice(3)),
      ...(full && plan.pack ? [{ name: "packed consumer checks", task: () => checkPackages(root) }] : [])];
    for (const name of skip) if (!steps.flatMap(stepNames).includes(name)) throw new Error(`--skip names no selected check: ${name}`);
    const head = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout).trim();
    const receipt = newReceipt(steps, head, base, all ? "all" : full ? "full" : "focused");
    const save = (value: CheckReceipt) => writeReceipt(resolve(root, receiptPath), value);
    save(receipt);
    try {
      requireLocalSandbox();
      const chrome = full ? requireRuntimeTools(plan) : undefined;
      if (chrome) {
        chromeStep.argv.push(process.execPath, "packages/ui-render-puppeteer/tests/cold-start.ts", chrome);
        for (const step of steps) if (Array.isArray(step)) for (const command of step) command.env = { PUPPETEER_EXECUTABLE_PATH: chrome, ...command.env };
      }
    } catch (error) {
      for (const check of receipt.checks) check.reason = `not run: preflight setup refused (${String(error).slice(0, 200)})`;
      receipt.finishedAt = new Date().toISOString(); save(receipt);
      throw error;
    }
    if (full) {
      // Full local suites are for debugging only and run through host admission
      // (#2939, #2943), after the cheap prerequisite refusals above.
      const admitted = await ensureHostAdmission(all ? "check:pr --all" : "check:pr --full");
      if (admitted !== undefined) {
        for (const check of receipt.checks) check.reason = "not run: host admission did not admit this run";
        receipt.finishedAt = new Date().toISOString(); save(receipt);
        process.exit(admitted);
      }
    }
    const report = () => {
      console.log(`check:pr receipt written to ${receiptPath}. Paste this block into the PR body, replacing any earlier one:\n${receiptBlock(receipt)}`);
    };
    try { await runPreflight(steps, receipt, { root, skip, timeoutMs, save }); }
    finally { report(); }
    const unproven = receipt.checks.filter(check => UNPROVEN.includes(check.outcome));
    if (unproven.some(check => check.outcome === "preempted")) {
      console.error(`Local preflight preempted: ${unproven.filter(check => check.outcome === "preempted").map(check => check.name).join(", ")}. Rerun check:pr; a preempted check is neither checked nor failed.`);
      process.exit(PREEMPTED_EXIT);
    }
    if (unproven.length) {
      console.warn(`Local preflight incomplete: ${unproven.map(check => `${check.name} (${check.outcome}; hosted ${check.categories.join(" or ") || "none"})`).join("; ")}. ` +
        "The receipt records them; integrate.ts refuses the merge unless exact-head hosted proof runs those categories successfully.");
    } else console.log("Local preflight passed. Record focused receipts; selected hosted proof must pass before merge.");
  } catch (error) { console.error(error); process.exit(1); }
}
