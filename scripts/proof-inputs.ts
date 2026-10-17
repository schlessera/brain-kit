/** Immutable inclusion-based browser inputs. Native/Git-derived proof stays fresh. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { inclusionInputs } from "./inclusion-inputs";

export const REUSABLE = ["browser", "layout"] as const;
export type Reusable = typeof REUSABLE[number];
export interface Spec { project: string; file: string; }
export interface Checkout { sha: string; tree: string; parents: string[]; }
export interface Inputs {
  version: 2; category: Reusable; fingerprint: string; runner: string;
  inventory: Spec[]; partitions: string[][]; excluded: string[];
}
export function git(root: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(`Cannot inspect proof Git inputs: ${new TextDecoder().decode(p.stderr).trim()}`);
  return new TextDecoder().decode(p.stdout);
}
export function checkout(root: string, ref = "HEAD"): Checkout {
  const [sha, tree, ...parents] = git(root, "show", "-s", "--format=%H %T %P", ref).trim().split(" ");
  if (!sha || !tree) throw new Error("Missing immutable checkout identity");
  return { sha, tree, parents };
}
export function treeEntries(root: string, ref: string): { mode: string; oid: string; path: string }[] {
  return git(root, "ls-tree", "-r", "-z", ref).split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t"), [mode, kind, oid] = line.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !oid || kind !== "blob") throw new Error("Unknown Git input (including submodules) requires fresh proof");
    return { mode, oid, path: line.slice(tab + 1) };
  });
}
export function normalizeInventory(value: unknown, root?: string): Spec[] {
  if (!Array.isArray(value) || !value.length || value.length > 5000) throw new Error("Missing or unbounded browser discovery");
  const specs = value.map((item: { project?: unknown; projectName?: unknown; file?: unknown }) => {
    const project = String(item.project ?? item.projectName ?? "").replace(/ \((?:chromium|webkit)\)$/, "");
    const file = root ? relative(root, String(item.file)).replaceAll("\\", "/") : String(item.file);
    if (!project || !file.startsWith("packages/") || file.includes("..") || /[\r\n\0]/.test(file + project)) throw new Error("Invalid browser discovery identity");
    return { project, file };
  }).sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  if (new Set(specs.map(s => `${s.project}::${s.file}`)).size !== specs.length) throw new Error("Duplicate browser discovery");
  if (JSON.stringify(specs).length > 60000) throw new Error("Unbounded browser input receipt");
  return specs;
}
export function selectedSpecs(category: Reusable, inventory: readonly Spec[]): Spec[] {
  const selected = inventory.filter(s => category === "layout" ? s.project === "ui-react-layout" : ! ["ui-react-layout", "ui-react-endurance"].includes(s.project));
  if (selected.length < 2) throw new Error("Incomplete browser category inventory");
  return selected;
}

export function proofInputs(root: string, category: Reusable, inventory: Spec[], runner: string,
  ref = "HEAD", excluded: string[] = []): Inputs {
  if (excluded.length) throw new Error("Invalid legacy input ownership");
  return inclusionInputs(root, category, inventory, runner, ref);
}

/** Drain both native pipes without retaining arbitrarily large warning output. */
async function discoveryOutput(stream: ReadableStream<Uint8Array>) {
  let bytes = 0, tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    tail = Buffer.concat([tail, chunk.subarray(Math.max(0, chunk.byteLength - 1000))]).subarray(-1000);
  }
  return { bytes, tail: tail.toString("utf8") };
}
function inventoryPublication(output: string) {
  try {
    const stat = statSync(output);
    return { present: true, bytes: stat.size,
      // Identify a published inventory without logging its paths or retaining an unbounded file.
      ...(stat.isFile() && stat.size <= 1024 * 1024 ? { sha256: createHash("sha256").update(readFileSync(output)).digest("hex") } : {}) };
  } catch { return { present: false }; }
}

/** --filesOnly reaches Vitest's glob API without importing/collecting test suites. */
export async function browserInventory(root: string): Promise<Spec[]> {
  const output = join(root, "tmp", `proof-browser-inventory-${process.pid}.json`);
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const started = performance.now(), deadlineMs = 15000;
  let timedOut = false;
  const p = Bun.spawn(["node", "../../node_modules/vitest/vitest.mjs", "list", "--filesOnly", `--json=${output}`], {
    cwd: join(root, "packages/ui-kit"), stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32",
    // The supported opt-out avoids unawaited Storybook telemetry retry timers
    // retaining this file-only child after JSON publication. It changes no projects.
    env: { ...process.env, CI: "true", STORYBOOK_DISABLE_TELEMETRY: "1" },
  });
  // Own just this discovery session: retry/worker descendants may retain its pipes
  // after the leader exits. Killing only the leader would leave the drain unbounded.
  let completed = false, stopped = false, cleanupError: string | undefined;
  const stopDiscovery = () => {
    if (completed || stopped) return;
    stopped = true;
    if (process.platform !== "win32") {
      try { process.kill(-p.pid, "SIGKILL"); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = String(error).slice(-1000);
      }
    }
    if (p.exitCode === null && !p.signalCode) {
      try { p.kill("SIGKILL"); } catch (error) { cleanupError = String(error).slice(-1000); }
    }
  };
  const timer = setTimeout(() => { timedOut = true; stopDiscovery(); }, deadlineMs);
  let stdout = { bytes: 0, tail: "" }, stderr = { bytes: 0, tail: "" };
  try {
    const results = await Promise.all([discoveryOutput(p.stdout), discoveryOutput(p.stderr), p.exited]);
    completed = true; // Reaped leader and EOF on both pipes: the owned lifetime has ended.
    [stdout, stderr] = results;
    const code = results[2];
    clearTimeout(timer);
    if (timedOut || code || p.signalCode) throw new Error("Native discovery process did not complete successfully");
    // Vitest's file channel is JSON.stringify + writeFileSync. Console output
    // may contain colored diagnostics; it is not the machine envelope.
    const inventory = normalizeInventory(await Bun.file(output).json(), root);
    const declaration = /const projects = projectArgs\.length \?[^\n]+ : (\[[^\n]+\]);/.exec(readFileSync(join(root, "scripts/visual.mjs"), "utf8"));
    if (!declaration) throw new Error("Unknown browser project selection requires fresh proof");
    const defaults = JSON.parse(declaration[1]!) as string[];
    const expected = [...defaults, "ui-react-layout", "ui-react-endurance"].sort();
    const actual = [...new Set(inventory.map(spec => spec.project))].sort();
    if (!defaults.length || new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Unknown or missing browser project discovery requires fresh proof");
    return inventory;
  } catch (error) {
    stopDiscovery();
    await p.exited;
    const receipt = { elapsedMs: Math.round(performance.now() - started), deadlineMs, timedOut,
      exitCode: p.exitCode, signal: p.signalCode ?? null, ...(cleanupError ? { cleanupError } : {}), stdout, stderr, inventory: inventoryPublication(output) };
    throw new Error(`Vitest file discovery failed: ${JSON.stringify(receipt)}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    stopDiscovery();
    await p.exited;
    rmSync(output, { force: true });
  }
}
export function runnerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  // No externally hosted Storybook or alternate runtime context can be retained.
  if (["BRAIN_ROOT", "BRAIN_WORKER_DATA_ROOT", "BRAIN_WORKER_CONFIG_ROOT"].some(name => env[name] !== undefined) ||
      env.SB_URL || env.NODE_OPTIONS || !env.ImageVersion || env.RUNNER_OS !== "Linux" || env.RUNNER_ARCH !== "X64") return "";
  return `ubuntu-24.04/${env.ImageVersion}/Linux/X64/bun-${Bun.version}/brain-roots-absent-v1`;
}
