/** Captured files for the single isolated workspace-build operation. */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { buildStat, buildRead, buildNames, buildLink } from "./ci-build-files";
import { listPublishablePackages } from "./publishable-packages";

export type BuildFile = { path: string; mode: number; kind: "directory" | "file" | "link"; sha256?: string; target?: string };
export const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const identity = (value: unknown) => digest(JSON.stringify(value));
export function safePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || posix.isAbsolute(path) || posix.normalize(path) !== path || path === ".." || path.startsWith("../")) throw new Error("Unsupported build path");
  return path;
}
const ignored = (path: string) => path === ".git" || path.startsWith(".git/") || path === "tmp" || path.startsWith("tmp/") ||
  /^packages\/[^/]+\/dist(?:\/|$)/.test(path) || path === "node_modules/.cache/brain-ci-build" || path.startsWith("node_modules/.cache/brain-ci-build/");

/** The bytes identified here, rather than a subsequent path read, are consumed. */
export function captureBuildInputs(root: string, destination: string) {
  const files = new Map<string, BuildFile>();
  const source = Bun.spawnSync(["git", "--no-lazy-fetch", "--no-replace-objects", "-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" }, stdout: "pipe", stderr: "pipe",
  });
  if (source.exitCode !== 0) throw new Error("Build source inventory unavailable");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  function directory(path: string) {
    if (path === "." || files.has(path)) return;
    safePath(path); directory(posix.dirname(path));
    const stat = buildStat(join(root, path));
    if (!stat.isDirectory()) throw new Error("Build input ancestor is not a directory");
    files.set(path, { path, kind: "directory", mode: Number(stat.mode & 0o7777n) });
    mkdirSync(join(destination, path), { mode: 0o700 });
  }
  function capture(path: string, recurse: boolean) {
    safePath(path);
    if (ignored(path) || files.has(path)) return;
    directory(posix.dirname(path));
    const from = join(root, path), to = join(destination, path), stat = buildStat(from);
    const mode = Number(stat.mode & 0o7777n);
    if (stat.isDirectory()) {
      directory(path);
      if (recurse) for (const name of buildNames(from, stat)) capture(`${path}/${name}`, true);
    } else if (stat.isFile()) {
      const bytes = buildRead(from, stat).bytes;
      files.set(path, { path, mode, kind: "file", sha256: digest(bytes) });
      writeFileSync(to, bytes, { mode, flag: "wx" }); chmodSync(to, mode);
    } else if (stat.isSymbolicLink()) {
      const target = buildLink(from, stat);
      if (posix.isAbsolute(target) || target.includes("\\")) throw new Error("External build input link");
      files.set(path, { path, mode, kind: "link", target }); symlinkSync(target, to);
    } else throw new Error("Unsupported build input type");
  }
  for (const path of new TextDecoder().decode(source.stdout).split("\0").filter(Boolean).sort()) {
    if (!/(^|\/)node_modules(?:\/|$)/.test(path)) capture(path, false);
  }
  const packages = listPublishablePackages(destination);
  const dependencies = ["node_modules", ...packages.map(pkg => `packages/${pkg.dir}/node_modules`)];
  for (const path of dependencies) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isDirectory()) throw new Error("Installed dependency root must be a private directory");
      capture(path, true);
    }
  }
  if (!files.has("node_modules")) throw new Error("Missing captured dependency installation");
  const outputAliases = new Set(packages.flatMap(pkg => Object.values(pkg.manifest.bin ?? {}).map(target => safePath(posix.normalize(`packages/${pkg.dir}/${target}`)))));
  function effective(path: string): string {
    const seen = new Set<string>();
    for (let count = 0; count < 128; count++) {
      safePath(path);
      if (seen.has(path)) throw new Error("Cyclic build input link");
      seen.add(path);
      const parts = path.split("/"); let changed = false;
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join("/"), entry = files.get(prefix);
        if (entry?.kind !== "link") continue;
        path = posix.normalize(posix.join(posix.dirname(prefix), entry.target!, ...parts.slice(index)));
        changed = true; break;
      }
      if (!changed) return path;
    }
    throw new Error("Unbounded build input link");
  }
  for (const entry of files.values()) if (entry.kind === "link") {
    const target = effective(entry.path);
    if (!files.has(target) && !outputAliases.has(target)) throw new Error("Uncaptured build input link target");
  }
  // Parents are initially writable only to materialize their children. They
  // become read-only producer mounts, with their original modes recorded.
  for (const entry of [...files.values()].reverse()) if (entry.kind === "directory") chmodSync(join(destination, entry.path), entry.mode);
  const records = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const installation = records.filter(entry => /(^|\/)node_modules(?:\/|$)/.test(entry.path));
  return { records, installation: identity(installation), sha256: identity(records), packages: packages.map(pkg => pkg.dir) };
}

export function outputFiles(root: string): BuildFile[] {
  const records: BuildFile[] = [];
  function walk(path: string) {
    const stat = buildStat(join(root, path));
    if (stat.isDirectory()) {
      records.push({ path, kind: "directory", mode: Number(stat.mode & 0o7777n) });
      for (const name of buildNames(join(root, path), stat)) walk(path ? `${path}/${name}` : name);
    } else if (stat.isFile()) records.push({ path, kind: "file", mode: Number(stat.mode & 0o7777n), sha256: digest(buildRead(join(root, path), stat).bytes) });
    else throw new Error("Unsupported build output type");
  }
  walk(""); return records;
}
/** One necessary reuse predicate, never sufficient authority on its own. */
export function sameOutputIdentity(root: string, expected: string): boolean {
  try { return identity(outputFiles(root)) === expected; } catch { return false; }
}

/** Publish checked bytes; no validation-then-copy reread of a mutable pathname. */
export function captureOutputs(root: string, destination: string): BuildFile[] {
  const records: BuildFile[] = [];
  function walk(path: string) {
    const from = join(root, path), to = join(destination, path), stat = buildStat(from);
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      records.push({ path, kind: "directory", mode: Number(stat.mode & 0o7777n) });
      for (const name of buildNames(from, stat)) walk(path ? `${path}/${name}` : name);
      chmodSync(to, Number(stat.mode & 0o7777n));
    } else if (stat.isFile()) {
      const bytes = buildRead(from, stat).bytes, mode = Number(stat.mode & 0o7777n);
      writeFileSync(to, bytes, { mode, flag: "wx" }); chmodSync(to, mode);
      records.push({ path, kind: "file", mode, sha256: digest(bytes) });
    } else throw new Error("Unsupported build output type");
  }
  walk(""); return records;
}
/** Recheck the captured intermediate, not the earlier mutable host pathname. */
export function captureDerivedOutput(root: string, destination: string, expected: string): BuildFile[] {
  const records = captureOutputs(root, destination);
  if (identity(records) !== expected) throw new Error("Derived build output changed during capture");
  return records;
}

export type BuildMount = { source: string; target: string; readonly: boolean };
export function buildMounts(input: string, state: string, packages: readonly string[], derived: Readonly<Record<string, string>> = {}) {
  const mounts: BuildMount[] = [];
  if (Object.keys(derived).some(pkg => !packages.includes(pkg))) throw new Error("Unknown derived build package");
  function mount(source: string, target: string, readonly: boolean) {
    if (source.includes(",") || target.includes(",")) throw new Error("Unsupported Docker mount path");
    mounts.push({ source: resolve(source), target, readonly });
  }
  for (const name of readdirSync(input).sort()) {
    if (name === "packages") continue;
    const source = join(input, name);
    if (lstatSync(source).isSymbolicLink()) throw new Error("Top-level input alias needs separate qualification");
    mount(source, `/repo/${name}`, true);
  }
  const topology: Record<string, string[]> = {};
  for (const pkg of packages) {
    const parent = join(state, "parents", pkg); mkdirSync(parent, { recursive: true, mode: 0o700 });
    mount(parent, `/repo/packages/${pkg}`, false);
    const names = readdirSync(join(input, "packages", pkg)).sort(); topology[pkg] = names;
    for (const name of names) {
      const source = join(input, "packages", pkg, name), stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error("Package-root alias needs separate qualification");
      if (stat.isDirectory()) mkdirSync(join(parent, name)); else writeFileSync(join(parent, name), "", { flag: "wx" });
      mount(source, `/repo/packages/${pkg}/${name}`, true);
    }
    if (derived[pkg]) {
      mkdirSync(join(parent, "dist"));
      mount(derived[pkg]!, `/repo/packages/${pkg}/dist`, true);
      topology[pkg] = [...names, "dist"].sort();
    }
  }
  const diagnostics = join(state, "diagnostics"); mkdirSync(diagnostics, { mode: 0o700 }); mount(diagnostics, "/repo/tmp", false);
  return { mounts, topology, rootNames: [...readdirSync(input).filter(name => name !== "packages"), "packages", "tmp"].sort() };
}
