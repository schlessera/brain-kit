/** Deterministic, empty-file load for the existing offline timing fixture. */
import { watchdogMs } from "../test-deadlines.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ObservationTree {
  workspaceEntries: number;
  dependencyEntries: number;
  journalObjects: number;
  checkouts: number;
}
export function observationTreeOptions(args: string[]): ObservationTree | undefined {
  const trees = args.filter(arg => arg.startsWith("--tree="));
  if (trees.length > 1) throw Error("Only one --tree selection is allowed");
  const tree = trees[0];
  const fields = { workspaceEntries: "workspace-entries", dependencyEntries: "dependency-entries", journalObjects: "journal-objects", checkouts: "checkouts" };
  const sized = args.some(arg => Object.values(fields).some(name => arg.startsWith(`--${name}=`)));
  if (!tree && !sized) return;
  if (tree !== "--tree=large" || !args.includes("--observation-timing")) throw Error("--tree=large and its sizes require --observation-timing");
  const result: ObservationTree = { workspaceEntries: 80000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 };
  for (const key of Object.keys(fields) as (keyof ObservationTree)[]) {
    const values = args.filter(arg => arg.startsWith(`--${fields[key]}=`));
    if (values.length > 1) throw Error(`Only one --${fields[key]} size is allowed`);
    const raw = values[0]?.slice(`--${fields[key]}=`.length);
    if (raw === undefined) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) > 1000000 || key === "checkouts" && (Number(raw) < 1 || Number(raw) > 1000))
      throw Error(`Invalid --${fields[key]} size`);
    result[key] = Number(raw);
  }
  return result;
}

export function seedObservationTree(brain: string, objects: string, sizes: ObservationTree) {
  let directories = 0, files = 0;
  const made = new Set<string>();
  const directory = (path: string) => {
    if (made.has(path)) return;
    const missing: string[] = [];
    for (let cursor = path; !existsSync(cursor); cursor = dirname(cursor)) missing.push(cursor);
    mkdirSync(path, { recursive: true, mode: path === objects ? 0o700 : 0o755 });
    for (const created of missing) { made.add(created); directories++; }
    made.add(path);
  };
  const file = (path: string, bytes = "") => { writeFileSync(path, bytes); files++; };
  directory(join(brain, "workspaces"));
  for (let i = 0; i < sizes.checkouts; i++) {
    const root = join(brain, "workspaces", `ithaca-${String(i).padStart(3, "0")}`);
    directory(root); directory(join(root, ".git")); directory(join(root, "node_modules"));
    file(join(root, ".gitignore"), "node_modules/\n");
  }
  for (let i = 0; i < sizes.workspaceEntries; i++) {
    const root = join(brain, "workspaces", `ithaca-${String(i % sizes.checkouts).padStart(3, "0")}`);
    const nested = join(root, "node_modules", `ship-${Math.floor(i / sizes.checkouts / 100)}`);
    directory(nested); file(join(nested, `entry-${i}`));
  }
  // The real CLI shim and its dependency tree remain in this directory.
  const dependencies = join(brain, "node_modules", "ithaca-timing"); directory(dependencies);
  for (let i = 0; i < sizes.dependencyEntries; i++) file(join(dependencies, `entry-${i}`));
  directory(objects);
  for (let i = 0; i < sizes.journalObjects; i++) {
    const bytes = `Odysseus journal object ${i}.\n`;
    file(join(objects, createHash("sha256").update(bytes).digest("hex")), bytes);
  }
  return { ...sizes, generatedFiles: files, generatedDirectories: directories, generatedEntries: files + directories,
    fileLayout: "empty workspace/dependency leaves; content-addressed tiny fictional journal objects" };
}

/** The host variable by which a runner declares that nothing else shares its page cache (#4284). */
export const ISOLATED_RUNNER_ENV = "BRAIN_NATIVE_PROOF_ISOLATED_RUNNER";
/** `isolated`: the runner opted in and declared isolation; `undeclared`: opted in without it. */
export type ColdCacheRequest = "isolated" | "undeclared";
/** Opt-in runner conditions; a default run selects none and its Docker arguments are unchanged. */
export interface NativeRunnerOptions {
  /** Docker `--cpus` for the whole proof container: app, workers and fixture (#4286). */
  cpus?: string;
  coldCache?: ColdCacheRequest;
}
export function nativeRunnerOptions(args: string[], env: Record<string, string | undefined>): NativeRunnerOptions {
  const options: NativeRunnerOptions = {};
  const cpus = args.filter(arg => arg.startsWith("--cpus="));
  if (cpus.length > 1) throw Error("Only one --cpus quota is allowed");
  if (cpus[0] !== undefined) {
    const raw = cpus[0].slice("--cpus=".length);
    // Docker's own decimal form, bounded to a quota it schedules at.
    if (!/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,2})?$/.test(raw) || Number(raw) < 0.01 || Number(raw) > 1024) throw Error("Invalid --cpus quota");
    options.cpus = raw;
  }
  const cold = args.filter(arg => arg === "--cold-cache");
  if (cold.length > 1) throw Error("Only one --cold-cache selection is allowed");
  if (cold.length) {
    if (!args.includes("--tree=large") || !args.includes("--observation-timing")) throw Error("--cold-cache requires --observation-timing --tree=large");
    options.coldCache = env[ISOLATED_RUNNER_ENV] === "1" ? "isolated" : "undeclared";
  }
  return options;
}

export type ColdCacheRow<T> = { available: true; dropMs: number; sample: T } | { available: false; reason: string };
/**
 * One admission after dropping the page cache, only on a runner that opted in
 * and declared itself isolated: a drop empties the cache of everything else on
 * the host. Otherwise, or when the drop fails, the row says why it is absent
 * and no cold admission runs. `dropMs` spans the request to its confirmation.
 */
export async function coldCacheRow<T>(request: ColdCacheRequest | undefined, drop: () => void | Promise<void>, admit: () => Promise<T>,
  now: () => number = () => performance.now()): Promise<ColdCacheRow<T>> {
  if (request === undefined) return { available: false, reason: `Not requested: --cold-cache on a runner declaring ${ISOLATED_RUNNER_ENV}=1 drops the page cache once; the default never mutates the runner cache` };
  if (request !== "isolated") return { available: false, reason: `--cold-cache was requested, but the runner did not declare itself isolated (${ISOLATED_RUNNER_ENV}=1); its shared cache is never mutated` };
  const started = now();
  try { await drop(); }
  catch (error) { return { available: false, reason: `Page cache drop failed (${error instanceof Error ? error.message : String(error)}); no cold admission ran` }; }
  const dropMs = now() - started;
  return { available: true, dropMs, sample: await admit() };
}

/*
 * The proof container's AppArmor profile denies writes under /proc/sys/vm, and
 * stays as it is: the drop runs on the host, by prove-native-host.ts, which
 * answers at most one request through the run's artifact directory, and only
 * when its runner declared itself isolated.
 */
export const COLD_CACHE_REQUEST = "cold-cache-request.json";
export const COLD_CACHE_RESPONSE = "cold-cache-response.json";
type DropResponse = { ok: true } | { ok: false; reason: string };

/** In the container: asks the host for its one drop and waits for the answer. */
export async function requestHostCacheDrop(dir: string, timeoutMs = 120_000, pollMs = 25): Promise<void> {
  const response = join(dir, COLD_CACHE_RESPONSE);
  writeFileSync(join(dir, COLD_CACHE_REQUEST), JSON.stringify({ requestedAt: Date.now() }));
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(response)) {
      const answer = JSON.parse(readFileSync(response, "utf8")) as DropResponse;
      if (answer.ok) return;
      throw Error(answer.reason);
    }
    await Bun.sleep(pollMs);
  }
  throw Error(`the runner did not answer the cache-drop request within ${timeoutMs} ms`);
}

/** On the host: answers the first request in `dir` with one drop; later requests stay unanswered. */
export function serveHostCacheDrop(dir: string, drop: () => void = dropHostPageCache, pollMs = 25): { stop(): void } {
  const request = join(dir, COLD_CACHE_REQUEST);
  let answered = false;
  const timer = setInterval(() => {
    if (answered || !existsSync(request)) return;
    answered = true;
    let answer: DropResponse;
    try { drop(); answer = { ok: true }; }
    catch (error) { answer = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    // Written whole, then renamed: the container never reads a partial answer.
    writeFileSync(join(dir, `${COLD_CACHE_RESPONSE}.tmp`), JSON.stringify(answer));
    renameSync(join(dir, `${COLD_CACHE_RESPONSE}.tmp`), join(dir, COLD_CACHE_RESPONSE));
  }, pollMs);
  return { stop: () => { clearInterval(timer); rmSync(join(dir, `${COLD_CACHE_RESPONSE}.tmp`), { force: true }); } };
}

/**
 * Writes back dirty pages, then drops the clean page, dentry and inode caches
 * of the whole host. Root writes directly; anyone else needs passwordless sudo.
 */
export function dropHostPageCache(): void {
  const command = process.getuid?.() === 0 ? ["sh", "-c", "sync && echo 3 > /proc/sys/vm/drop_caches"]
    : ["sudo", "-n", "sh", "-c", "sync && echo 3 > /proc/sys/vm/drop_caches"];
  const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw Error(`${command.slice(0, command[0] === "sudo" ? 2 : 1).join(" ")} drop exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
}

/** Time the first real initialization, including initialization during idle maintenance. */
export function traceObserverBootstrap<A extends unknown[], T>(initialize: (...args: A) => Promise<T>,
  report: (span: { elapsedMs: number; outcome: "completed" | "failed" }) => void, now: () => number = () => performance.now()) {
  let first = true;
  return async (...args: A): Promise<T> => {
    if (!first) return initialize(...args);
    first = false;
    const started = now(); let outcome: "completed" | "failed" = "failed";
    try { const value = await initialize(...args); outcome = "completed"; return value; }
    finally { report({ elapsedMs: Math.max(0, now() - started), outcome }); }
  };
}

/** The large scenario measures slow walks; its limits are size-scaled watchdogs. */
export function observationTreeWatchdog(sizes?: ObservationTree): number | undefined {
  if (!sizes) return;
  return watchdogMs(treeWatchdogBase(sizes));
}
function treeWatchdogBase(sizes: ObservationTree): number {
  return 120_000 + 2 * (sizes.workspaceEntries + sizes.dependencyEntries + sizes.journalObjects + 4 * sizes.checkouts);
}
/** Bun's registrar applies the load factor once to this per-test timeout. */
export function observationRunTimeout(sizes?: ObservationTree): number {
  return Math.max(5_100_000, sizes ? treeWatchdogBase(sizes) * 15 : 0);
}
