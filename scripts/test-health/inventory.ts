/**
 * One row per test file: where it runs, what it costs and which blob it is.
 * The audit unit is the file. A file that several browser projects execute
 * (a story in light and dark) is still one thing to read, so its execution
 * instances are folded into the row.
 *
 * Product files come from the existing discovery (`proofInventory`,
 * scripts/proof-inventory.ts), so this never keeps a second list of tests.
 * The experiment tier is added because it is release-gated proof too.
 */
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export type Tier = "fast" | "unit" | "runtime" | "browser" | "layout" | "endurance" | "experiment";
export type Runner = "bun" | "visual";

/** Position in the pyramid: a higher level costs more per assertion. */
export const TIER_LEVEL: Readonly<Record<Tier, number>> = { fast: 1, unit: 1, experiment: 1, runtime: 2, browser: 3, layout: 3, endurance: 4 };

export interface Instance { key: string; file: string; domain: string; scenarios: number; assertions: number; measuredSeconds: number | null }
export interface Row {
  file: string;
  /** The workspace directory, `root` for `tests/`, or `experiments`. One batch stays inside one package. */
  package: string;
  tier: Tier;
  runner: Runner;
  /** Vitest projects that execute the file; empty for Bun tests. */
  projects: string[];
  scenarios: number;
  assertions: number;
  blob: string;
  costSeconds: number | null;
}
export interface Inventory { sha: string; rows: Row[]; undiscovered: string[] }

/** Source of execution instances; injectable so a fixture repository needs no Vitest configuration. */
export type Discover = (root: string) => Promise<Instance[]> | Instance[];

const RUNTIME_NAME = /(?:-runtime|\.native)\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_LIKE = /(?:(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]s|[jt]sx)|\.(?:layout|offline|endurance|visual|pointer)\.tsx|\.stories\.tsx)$/;

export function packageOf(file: string): string {
  const parts = file.split("/");
  if (parts[0] === "packages" && parts.length > 2) return parts[1]!;
  return parts[0] === "experiments" ? "experiments" : "root";
}

export function tierOf(file: string, domains: readonly string[]): Tier {
  if (file.startsWith("experiments/")) return "experiment";
  if (domains.includes("endurance")) return "endurance";
  if (domains.includes("layout")) return "layout";
  if (domains.includes("browser")) return "browser";
  if (RUNTIME_NAME.test(file)) return "runtime";
  return domains.includes("fast") ? "fast" : "unit";
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** Blob ids of the working tree's files as git would store them. */
export function blobsOf(root: string, files: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of git(root, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    if (path) blobs.set(path, meta!.split(" ")[1]!);
  }
  const dirty = new Set(git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).split("\0").filter(Boolean).map(line => line.slice(3)));
  const rehash = files.filter(file => dirty.has(file) || !blobs.has(file)).filter(file => existsSync(join(root, file)));
  if (rehash.length) {
    const ids = git(root, ["hash-object", "--", ...rehash]).split("\n").filter(Boolean);
    rehash.forEach((file, index) => blobs.set(file, ids[index]!));
  }
  return blobs;
}

async function productInstances(root: string): Promise<Instance[]> {
  const { proofInventory, sourceAssertions } = await import("../proof-inventory");
  const { discoverTests } = await import("../test-shards");
  const { FILE_COST_SECONDS } = await import("../test-shards");
  const inventory = await proofInventory(root);
  const product: Instance[] = inventory.rows.map(row => ({ key: row.key, file: row.file, domain: row.domain,
    scenarios: row.scenarios.length, assertions: row.assertions.length,
    measuredSeconds: row.key.startsWith("bun::") ? FILE_COST_SECONDS[row.file] ?? null : row.measuredSeconds }));
  const experiments = existsSync(join(root, "experiments")) ? discoverTests(root, ["experiments"]) : [];
  return [...product, ...experiments.map(file => {
    const counts = sourceAssertions(readFileSync(join(root, file), "utf8"), file);
    return { key: `bun::${file}`, file, domain: "experiment", scenarios: counts.scenarios.length, assertions: counts.assertions.length, measuredSeconds: null };
  })];
}

export async function buildInventory(root: string, discover: Discover = productInstances): Promise<Inventory> {
  const instances = await discover(root);
  const byFile = new Map<string, Instance[]>();
  for (const instance of instances) byFile.set(instance.file, [...(byFile.get(instance.file) ?? []), instance]);
  const files = [...byFile.keys()].sort();
  const blobs = blobsOf(root, files);
  const rows = files.map((file): Row => {
    const group = byFile.get(file)!;
    const projects = group.map(instance => instance.key.split("::")[0]!).filter(project => project !== "bun").sort();
    const costs = group.map(instance => instance.measuredSeconds).filter((value): value is number => value !== null);
    const blob = blobs.get(file);
    if (!blob) throw new Error(`No blob for discovered test ${file}`);
    return { file, package: packageOf(file), tier: tierOf(file, group.map(instance => instance.domain)),
      runner: projects.length ? "visual" : "bun", projects,
      scenarios: Math.max(...group.map(instance => instance.scenarios)), assertions: Math.max(...group.map(instance => instance.assertions)),
      blob, costSeconds: costs.length ? Math.round(costs.reduce((sum, value) => sum + value, 0) * 1000) / 1000 : null };
  });
  const known = new Set(files);
  const tracked = git(root, ["ls-files", "-z", "--", "packages", "tests", "experiments", "scripts"]).split("\0").filter(Boolean);
  // `scripts/skill-tests/` is the skill tooling's own tier (`bun run test:skills`): deliberately outside product discovery.
  const undiscovered = tracked.filter(file => TEST_LIKE.test(file) && !known.has(file) && !file.includes("/fixtures/") && !file.startsWith("scripts/skill-tests/")).sort();
  return { sha: git(root, ["rev-parse", "HEAD"]).trim(), rows, undiscovered };
}

/** Rebuilding takes several seconds, so a clean checkout reuses the inventory of its commit. */
export async function cachedInventory(root: string, cacheDir: string, discover?: Discover): Promise<Inventory> {
  const clean = git(root, ["status", "--porcelain", "--untracked-files=all"]).trim() === "";
  const path = join(cacheDir, `inventory-${git(root, ["rev-parse", "HEAD"]).trim()}.json`);
  if (clean && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Inventory;
  const inventory = await buildInventory(root, discover);
  if (clean) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(path, JSON.stringify(inventory) + "\n"); }
  return inventory;
}
