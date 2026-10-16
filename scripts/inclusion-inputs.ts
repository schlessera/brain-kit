/** Immutable inclusion fingerprints. Unknown runtime ownership always executes fresh. */
import ts from "typescript";
import { auditedInactiveCommands } from "./browser-command-activation";
import {hasAuditedWorkerBoundary,pdfWorkerInput} from "./browser-worker-audit";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverInputClosure, type InputDeclaration } from "./browser-input-closure";
import { balanceBrowserSpecs, readBrowserCosts } from "./browser-shards";
import { selectedSpecs, treeEntries, type Inputs, type Reusable, type Spec } from "./proof-inputs";

const required = ["package.json", "bun.lock", "tsconfig.json", "bunfig.toml", ".github/workflows/ci.yml",
  "packages/ui-kit/tests/proof-inputs.json", "packages/ui-kit/vitest.config.ts", "packages/ui-kit/vite.config.ts",
  "packages/ui-kit/.storybook/main.ts", "packages/ui-kit/.storybook/preview.ts", "scripts/browser-shard-costs.json",
  "scripts/visual.mjs", "scripts/build.ts", "scripts/workspace-lease.mjs", "scripts/css-proof-inputs.json",
  "packages/ui-kit/src/styles.css", "packages/ui-react/src/styles.css"];
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
    // Read raw Git blobs, not archive filters/export-ignore/substitution or
    // current worktree bytes. No generated output enters the snapshot.
    const blobs = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: root,
      stdin: new TextEncoder().encode(entries.map(entry => entry.oid).join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
    if (blobs.exitCode) throw new Error("Cannot materialize immutable proof blobs");
    const bytes = Buffer.from(blobs.stdout); let offset = 0;
    for (const entry of entries) {
      const end = bytes.indexOf(10, offset);
      if (end < offset) throw new Error("Missing immutable blob header");
      const header = bytes.subarray(offset, end).toString("ascii").split(" ");
      const size = Number(header[2]);
      if (header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= bytes.length)
        throw new Error("Invalid immutable blob inventory");
      const contents = bytes.subarray(end + 1, end + 1 + size), target = join(snapshot, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      if (entry.mode === "120000") symlinkSync(contents.toString("utf8"), target);
      else if (entry.mode === "100644" || entry.mode === "100755") { writeFileSync(target, contents); chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644); }
      else throw new Error("Unsupported immutable input mode");
      offset = end + 1 + size + 1;
    }
    if (offset !== bytes.length) throw new Error("Unexpected immutable blob output");
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
    const declarations = ["packages/ui-kit/tests/proof-inputs.json", "scripts/css-proof-inputs.json"].flatMap(file => {
      const value = JSON.parse(readFileSync(join(snapshot, file), "utf8"));
      if (!Array.isArray(value)) throw new Error("Invalid immutable input declarations");
      return value as InputDeclaration[];
    });
    if (!Array.isArray(declarations)) throw new Error("Invalid immutable input declarations");
    const selected = selectedSpecs(category, inventory);
    const inputs = [...required.filter(path => path.startsWith("packages/ui-kit/") || path === "packages/ui-react/src/styles.css"), ...selected.map(spec => spec.file)];
    const activation = category === "browser" ? auditedInactiveCommands(snapshot, selected) : undefined;
    const closure = discoverInputClosure(snapshot, inputs, declarations, activation);
    // Mandatory for this browser capability, even when a changed source hides
    // the recognizable constructor behind a new alias/realm. Such edits cannot
    // turn an absent audit into a generally closed domain.
    if(category==="browser"){
      if(!hasAuditedWorkerBoundary(snapshot,closure,selected))throw new Error("Unresolved immutable browser inputs require fresh proof: unvalidated selected Worker capability audit");
      closure.unresolved=closure.unresolved.filter(input=>input!==pdfWorkerInput);
    }
    if (closure.unresolved.length) throw new Error(`Unresolved immutable ${category} inputs require fresh proof: ${closure.unresolved.slice(0, 3).join("; ")}`);
    const included = new Set([...closure.files, ...entries.filter(entry => harness(entry.path)).map(entry => entry.path)]);
    // Builds compile their expanded source inventories; compilation hashes
    // source bytes without interpreting dormant runtime filesystem calls.
    for (const entry of entries.filter(entry => /^packages\/[^/]+\/tsconfig\.build\.json$/.test(entry.path))) {
      const config = ts.readConfigFile(join(snapshot, entry.path), ts.sys.readFile);
      if (config.error) throw new Error("Unknown immutable compiler configuration");
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(snapshot, entry.path.slice(0, entry.path.lastIndexOf("/"))));
      if (parsed.errors.length) throw new Error("Unknown immutable compiler inventory");
      for (const path of parsed.fileNames) {
        if (!path.startsWith(snapshot + "/")) throw new Error("Compiler input escapes immutable repository");
        included.add(path.slice(snapshot.length + 1));
      }
    }
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
    const material = { version: 2, category, runner, inventory, partitions, directories: closure.directories ?? [], external: closure.external ?? [], files };
    return { version: 2, category, runner, inventory, partitions, excluded: [],
      fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}
