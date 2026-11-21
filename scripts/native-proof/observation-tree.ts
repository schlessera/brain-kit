/** Deterministic, empty-file load for the existing offline timing fixture. */
import { watchdogMs } from "../test-deadlines.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ObservationTree {
  workspaceEntries: number;
  dependencyEntries: number;
  journalObjects: number;
  checkouts: number;
}
export function observationTreeOptions(args: string[]): ObservationTree | undefined {
  const tree = args.find(arg => arg.startsWith("--tree="));
  const fields = { workspaceEntries: "workspace-entries", dependencyEntries: "dependency-entries", journalObjects: "journal-objects", checkouts: "checkouts" };
  const sized = args.some(arg => Object.values(fields).some(name => arg.startsWith(`--${name}=`)));
  if (!tree && !sized) return;
  if (tree !== "--tree=large" || !args.includes("--observation-timing")) throw Error("--tree=large and its sizes require --observation-timing");
  const result: ObservationTree = { workspaceEntries: 80000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 };
  for (const key of Object.keys(fields) as (keyof ObservationTree)[]) {
    const raw = args.find(arg => arg.startsWith(`--${fields[key]}=`))?.split("=")[1];
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
    fileLayout: "empty workspace/dependency leaves; content-addressed tiny fictional journal objects", coldCache: { available: false, reason: "No isolated cache-drop proof; shared runner cache is never mutated" } };
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
  return watchdogMs(120_000 + 2 * (sizes.workspaceEntries + sizes.dependencyEntries + sizes.journalObjects + 4 * sizes.checkouts));
}
