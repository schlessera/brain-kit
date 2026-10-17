// Skip an identical workspace rebuild without trusting a stale dist (#2319).
//
// Runtime test hooks rebuild the workspace so a source mutation can never hide
// behind an old dist. A package is skipped only when two things both hold:
// every input that can affect any package's build is byte-identical to the
// last successful build, and that package's dist is exactly what the build
// produced. Cross-package imports resolve to each sibling's src through the
// root customConditions (see scripts/build.ts), so the input hash is shared by
// every package: any source change anywhere rebuilds everything, as before.
//
// The stamp lives under the root node_modules/.cache, never in dist: every
// package ships dist, and a stamp there would reach the npm tarball.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const STAMP_VERSION = 1;
/** Root files the build reads or runs, beside every package's own files. */
export const ROOT_BUILD_INPUTS = ["package.json", "bun.lock", "scripts/build.ts", "scripts/build-stamp.ts",
  "scripts/bin-modes.ts", "scripts/publishable-packages.ts", "scripts/workspace-lease.mjs"];

function fileEntry(root: string, path: string): string {
  const full = join(root, path);
  let stat;
  try { stat = lstatSync(full); } catch { return `${path}\0missing`; }
  if (stat.isSymbolicLink()) return `${path}\0link\0${readlinkSync(full)}`;
  if (!stat.isFile()) return `${path}\0other\0${stat.mode}`;
  return `${path}\0${stat.mode & 0o777}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
}

/** Every package file Git does not ignore (tracked or new), outside dist and node_modules. */
function packageFiles(root: string): string[] | undefined {
  const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "packages"],
    { stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) return undefined;
  return [...new Set(new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean))]
    .filter(path => !/^packages\/[^/]+\/(?:dist|node_modules)\//.test(path)).sort();
}

/**
 * The shared input hash, or undefined when it cannot be established (no Git
 * checkout, for example). Undefined never skips: the caller always rebuilds.
 */
export function buildInputs(root: string, runtime = Bun.version): string | undefined {
  const files = packageFiles(root);
  if (!files) return undefined;
  const rootConfigs = readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name)).sort();
  const typescript = join(root, "node_modules/typescript/package.json");
  const hash = createHash("sha256").update(`brain-build-inputs\0${STAMP_VERSION}\0bun\0${runtime}\0`);
  hash.update(`typescript\0${existsSync(typescript) ? JSON.parse(readFileSync(typescript, "utf8")).version : "missing"}\0`);
  for (const path of [...ROOT_BUILD_INPUTS, ...rootConfigs, ...files]) hash.update(fileEntry(root, path) + "\n");
  return hash.digest("hex");
}

/** Every path, mode and content under dist, or undefined when dist is absent. */
export function distHash(packageDir: string): string | undefined {
  const dist = join(packageDir, "dist");
  if (!existsSync(dist)) return undefined;
  const entries: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { entries.push(`${relative(dist, path)}/\0dir`); visit(path); }
      else entries.push(fileEntry(dist, relative(dist, path)));
    }
  };
  visit(dist);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function stampPath(root: string, packageName: string): string {
  return resolve(root, "node_modules/.cache/brain-build", `${packageName}.json`);
}

/** "up-to-date" only for an unforced build whose inputs and dist both match the stamp. */
export function buildDecision(root: string, packageName: string, input: string | undefined, force: boolean): "up-to-date" | "build" {
  if (force || !input) return "build";
  let stamp: { version?: unknown; input?: unknown; output?: unknown };
  try { stamp = JSON.parse(readFileSync(stampPath(root, packageName), "utf8")); } catch { return "build"; }
  if (stamp.version !== STAMP_VERSION || stamp.input !== input || typeof stamp.output !== "string") return "build";
  return distHash(resolve(root, "packages", packageName)) === stamp.output ? "up-to-date" : "build";
}

/** Remove a stamp before rebuilding, so an interrupted build can never look current. */
export function clearStamp(root: string, packageName: string): void {
  rmSync(stampPath(root, packageName), { force: true });
}

/** Record a completed build. Without an input hash there is nothing to record. */
export function recordBuild(root: string, packageName: string, input: string | undefined): void {
  const output = distHash(resolve(root, "packages", packageName));
  if (!input || !output) return;
  const path = stampPath(root, packageName);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: STAMP_VERSION, input, output }) + "\n");
}
