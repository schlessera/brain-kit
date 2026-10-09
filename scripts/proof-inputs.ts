/** Conservative complete-process browser inputs. Native/Git-derived proof stays fresh. */
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import ts from "typescript";
import { balanceBrowserSpecs, readBrowserCosts } from "./browser-shards";

export const REUSABLE = ["browser", "layout"] as const;
export type Reusable = typeof REUSABLE[number];
export interface Spec { project: string; file: string; }
export interface Checkout { sha: string; tree: string; parents: string[]; }
export interface Inputs {
  version: 1; category: Reusable; fingerprint: string; runner: string;
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
    const project = String(item.project ?? item.projectName ?? "").replace(/ \(chromium\)$/, "");
    const file = root ? relative(root, String(item.file)).replaceAll("\\", "/") : String(item.file);
    if (!project || !file.startsWith("packages/") || file.includes("..") || /[\r\n\0]/.test(file + project)) throw new Error("Invalid browser discovery identity");
    return { project, file };
  }).sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  if (new Set(specs.map(s => `${s.project}::${s.file}`)).size !== specs.length) throw new Error("Duplicate browser discovery");
  if (JSON.stringify(specs).length > 60000) throw new Error("Unbounded browser input receipt");
  return specs;
}
export function selectedSpecs(category: Reusable, inventory: readonly Spec[]): Spec[] {
  const selected = inventory.filter(s => category === "layout" ? s.project === "ui-react-layout" : s.project !== "ui-react-layout");
  if (selected.length < 2) throw new Error("Incomplete browser category inventory");
  return selected;
}

/** Only unreferenced opposite-category test leaves can lose their CONTENT hash.
 * Paths/modes remain inputs. Helpers, fixtures, all source/deps/config/pins and
 * unknown files stay hashed. Shared specs (including recordings-tray) stay hashed.
 * Reference closure deliberately overincludes prose/string references in code.
 */
export function discoverExcluded(root: string, category: Reusable, inventory: readonly Spec[]): string[] {
  const owned = new Set(selectedSpecs(category, inventory).map(s => s.file));
  const foreign = new Set(inventory.filter(s => !owned.has(s.file) && /\.(?:visual|pointer|layout|offline)\.tsx$/.test(s.file)).map(s => s.file));
  for (const file of foreign) {
    const text = readFileSync(join(root, file), "utf8").replace(/export\s*\{\s*\}\s*;?/g, "");
    if (/\bexport\b/.test(text)) foreign.delete(file); // An exported helper is not an independent leaf.
  }
  const entries = treeEntries(root, "HEAD");
  // A build must not consume a supposedly foreign test. Use the installed
  // compiler's actual expanded include/extends inventory, not filename guesses.
  for (const entry of entries.filter(e => /^packages\/[^/]+\/tsconfig\.build\.json$/.test(e.path))) {
    const configPath = join(root, entry.path);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error("Unknown build configuration requires fresh proof");
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    if (parsed.errors.length) throw new Error("Unknown compiled input inventory requires fresh proof");
    for (const path of parsed.fileNames) foreign.delete(relative(root, path).replaceAll("\\", "/"));
  }
  for (const file of ["packages/ui-kit/src/styles.css", "packages/ui-react/src/styles.css"]) {
    if (!entries.some(e => e.path === file)) continue;
    const css = readFileSync(join(root, file), "utf8");
    if (!css.includes('@import "tailwindcss" source(none);') ||
        JSON.stringify([...css.matchAll(/^@source ([^;]+);/gm)].map(m => m[1])) !== JSON.stringify(['"./"'])) throw new Error("Unknown CSS scan inputs require fresh proof");
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (foreign.has(entry.path)) continue;
      const text = entry.mode === "120000" ? readlinkSync(join(root, entry.path)) : readFileSync(join(root, entry.path), "utf8");
      for (const file of foreign) if (text.includes(basename(file, ".tsx"))) { foreign.delete(file); changed = true; }
    }
  }
  return [...foreign].sort();
}
export function proofInputs(root: string, category: Reusable, inventory: Spec[], runner: string,
  ref = "HEAD", excluded = discoverExcluded(root, category, inventory)): Inputs {
  if (!runner) throw new Error("Unknown runner image requires fresh proof");
  const selected = selectedSpecs(category, inventory);
  const executionFiles = new Set(selected.map(spec => spec.file));
  for (const entry of treeEntries(root, ref)) if ((/^packages\/(?:ui-react\/tests\/browser|ui-kit\/tests\/visual|ui-kit\/\.storybook)\//.test(entry.path) && /\.[cm]?[jt]sx?$/.test(entry.path) && !inventory.some(spec => spec.file === entry.path)) ||
    ["scripts/build.ts", "scripts/visual.mjs", "scripts/workspace-lease.mjs", "packages/ui-kit/vitest.config.ts", "packages/ui-kit/vite.config.ts"].includes(entry.path)) executionFiles.add(entry.path);
  for (const file of executionFiles) {
    // These categories normally execute browser assertions against fixtures,
    // not repository Git identity. Unknown dynamic module selection cannot
    // establish a closed domain; it keeps complete fresh execution.
    const text = readFileSync(join(root, file), "utf8");
    if (/\bGITHUB_(?:SHA|REF|EVENT_PATH)\b|\bgit\s+(?:rev-parse|log|show|diff)\b|['"]git['"]\s*,|\b(?:import|require)\s*\(\s*[^\s'"]/.test(text)) throw new Error("Git-dependent or unknown browser inputs require fresh execution");
  }
  const owned = new Set(selected.map(s => s.file));
  const files = treeEntries(root, ref);
  const paths = new Map(files.map(e => [e.path, e]));
  const foreign = new Set(inventory.filter(s => !owned.has(s.file) && /\.(?:visual|pointer|layout|offline)\.tsx$/.test(s.file)).map(s => s.file));
  if (excluded.some(file => !foreign.has(file) || paths.get(file)?.mode !== "100644") || new Set(excluded).size !== excluded.length ||
      inventory.some(s => !paths.has(s.file))) throw new Error("Invalid or missing input ownership");
  const ignored = new Set(excluded);
  const specs = selected.map(s => ({ key: `${s.project}::${s.file}`, project: s.project }));
  const partitions = balanceBrowserSpecs(specs, 2, readBrowserCosts(join(root, "scripts/browser-shard-costs.json"))).map(part => part.map(s => s.key));
  // Source cost/config blobs MUST be identical before source inputs are evaluated.
  // The receipt's partition is checked against this installed sequencer/table too.
  const material = { version: 1, category, runner, inventory, partitions,
    files: files.map(e => ({ ...e, oid: ignored.has(e.path) ? "opposite-category-unreferenced-test-content" : e.oid })) };
  return { version: 1, category, runner, inventory, partitions, excluded,
    fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
}

/** --filesOnly reaches Vitest's glob API without importing/collecting test suites. */
export async function browserInventory(root: string): Promise<Spec[]> {
  const p = Bun.spawn(["node", "../../node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--json"], {
    cwd: join(root, "packages/ui-kit"), stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "true" },
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(`Vitest file discovery failed: ${err.slice(-1000)}`);
    const inventory = normalizeInventory(JSON.parse(out), root);
    const declaration = /const projects = projectArgs\.length \?[^\n]+ : (\[[^\n]+\]);/.exec(readFileSync(join(root, "scripts/visual.mjs"), "utf8"));
    if (!declaration) throw new Error("Unknown browser project selection requires fresh proof");
    const defaults = JSON.parse(declaration[1]!) as string[];
    const expected = [...defaults, "ui-react-layout"].sort();
    const actual = [...new Set(inventory.map(spec => spec.project))].sort();
    if (!defaults.length || new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Unknown or missing browser project discovery requires fresh proof");
    return inventory;
  } finally { clearTimeout(timer); }
}
export function runnerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  // No externally hosted Storybook or alternate runtime context can be retained.
  if (env.SB_URL || env.NODE_OPTIONS || !env.ImageVersion || env.RUNNER_OS !== "Linux" || env.RUNNER_ARCH !== "X64") return "";
  return `ubuntu-24.04/${env.ImageVersion}/Linux/X64/bun-${Bun.version}`;
}
