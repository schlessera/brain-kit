/** Immutable inclusion fingerprints. Unknown runtime ownership always executes fresh. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInputClosure, type InputDeclaration } from "./browser-input-closure";
import { balanceBrowserSpecs, readBrowserCosts } from "./browser-shards";
import { git, selectedSpecs, treeEntries, type Inputs, type Reusable, type Spec } from "./proof-inputs";

const required = ["package.json", "bun.lock", "tsconfig.json", "bunfig.toml", ".github/workflows/ci.yml",
  "packages/ui-kit/tests/proof-inputs.json", "packages/ui-kit/vitest.config.ts", "packages/ui-kit/vite.config.ts",
  "packages/ui-kit/.storybook/main.ts", "packages/ui-kit/.storybook/preview.ts", "scripts/browser-shard-costs.json",
  "scripts/visual.mjs", "scripts/build.ts", "scripts/workspace-lease.mjs"];
const harness = (path: string) => path.startsWith("scripts/") || path.startsWith(".github/workflows/") ||
  required.includes(path) || /(?:^|\/)(?:package\.json|bun\.lock|bunfig\.toml|tsconfig(?:\.[^/]+)?\.json)$/.test(path);

/** Each immutable tree is materialized independently; current untracked/dist outputs never join discovery. */
export function inclusionInputs(root: string, category: Reusable, inventory: Spec[], runner: string, ref = "HEAD"): Inputs {
  if (!runner) throw new Error("Unknown runner image requires fresh proof");
  const entries = treeEntries(root, ref), paths = new Map(entries.map(entry => [entry.path, entry]));
  if (required.some(path => !paths.has(path))) throw new Error("Missing immutable proof configuration");
  // Resolution uses the one frozen install. Different lockfiles/manifests/algorithm
  // cannot be interpreted through that install or current helper implementation.
  const current = new Map(treeEntries(root, "HEAD").map(entry => [entry.path, entry]));
  const policyPaths = new Set([...paths.keys(), ...current.keys()].filter(harness));
  for (const path of policyPaths) if (paths.get(path)?.oid !== current.get(path)?.oid || paths.get(path)?.mode !== current.get(path)?.mode)
    throw new Error("Changed immutable algorithm or dependency inputs require fresh proof");
  const snapshot = mkdtempSync(join(tmpdir(), "brain-proof-inputs-"));
  try {
    const archive = Bun.spawnSync(["git", "archive", "--format=tar", ref], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (archive.exitCode) throw new Error("Cannot materialize immutable proof tree");
    const extracted = Bun.spawnSync(["tar", "-xf", "-", "-C", snapshot], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
    if (extracted.exitCode) throw new Error("Cannot extract immutable proof tree");
    if (!existsSync(join(root, "node_modules"))) throw new Error("Locked dependency resolution unavailable");
    // Workspace package symlinks must resolve INSIDE this immutable snapshot.
    // External packages remain read-only links to the matching frozen install.
    const workspaces = new Map<string, string>();
    for (const entry of entries.filter(entry => /^packages\/[^/]+\/package\.json$/.test(entry.path))) {
      const manifest = JSON.parse(readFileSync(join(snapshot, entry.path), "utf8"));
      if (typeof manifest.name !== "string") throw new Error("Unknown workspace package identity");
      workspaces.set(manifest.name, entry.path.slice(0, -"/package.json".length));
    }
    mkdirSync(join(snapshot, "node_modules"));
    for (const entry of readdirSync(join(root, "node_modules"), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        mkdirSync(join(snapshot, "node_modules", entry.name));
        for (const child of readdirSync(join(root, "node_modules", entry.name))) {
          const name = `${entry.name}/${child}`;
          symlinkSync(workspaces.has(name) ? join(snapshot, workspaces.get(name)!) : join(root, "node_modules", name), join(snapshot, "node_modules", name), "dir");
        }
      } else symlinkSync(workspaces.has(entry.name) ? join(snapshot, workspaces.get(entry.name)!) : join(root, "node_modules", entry.name), join(snapshot, "node_modules", entry.name), "dir");
    }
    const declarations = JSON.parse(readFileSync(join(snapshot, "packages/ui-kit/tests/proof-inputs.json"), "utf8")) as InputDeclaration[];
    if (!Array.isArray(declarations)) throw new Error("Invalid immutable input declarations");
    const selected = selectedSpecs(category, inventory);
    const inputs = [...required.filter(path => path !== "scripts/browser-shard-costs.json"), ...selected.map(spec => spec.file)];
    const closure = discoverInputClosure(snapshot, inputs, declarations);
    if (closure.unresolved.length) throw new Error(`Unresolved immutable ${category} inputs require fresh proof: ${closure.unresolved.slice(0, 3).join("; ")}`);
    const included = new Set([...closure.files, ...entries.filter(entry => harness(entry.path)).map(entry => entry.path)]);
    // Directory ownership expands from the immutable tree, not from current disk.
    for (const directory of closure.directories ?? []) for (const entry of entries)
      if (entry.path.startsWith(directory + "/")) included.add(entry.path);
    for (const path of included) {
      if (closure.directories?.includes(path)) continue;
      if (!paths.has(path) || !existsSync(join(snapshot, path))) throw new Error("Missing immutable input ownership");
      if (!["100644", "100755"].includes(paths.get(path)!.mode)) throw new Error("Unsupported symbolic input requires fresh proof");
    }
    const partitions = balanceBrowserSpecs(selected.map(spec => ({ key: `${spec.project}::${spec.file}`, project: spec.project })),
      2, readBrowserCosts(join(snapshot, "scripts/browser-shard-costs.json"))).map(part => part.map(spec => spec.key));
    const files = entries.filter(entry => included.has(entry.path));
    const material = { version: 2, category, runner, inventory, partitions, directories: closure.directories ?? [], files };
    return { version: 2, category, runner, inventory, partitions, excluded: [],
      fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}
