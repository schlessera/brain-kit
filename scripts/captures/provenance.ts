import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, realpath, mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Sorted paths and actual bytes; timestamps are not build identity. */
export async function hashTree(root: string, directory: string, excluded: string[] = []): Promise<string> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const next = resolve(path, entry.name);
      const name = relative(root, next).split(sep).join("/");
      if (excluded.includes(name)) continue;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) files.push({ path: name, sha256: sha256(await readFile(next)) });
      else throw new Error(`Unexpected non-file build input: ${name}`);
    }
  }
  await visit(resolve(root, directory));
  if (!files.length) throw new Error(`Empty capture input directory: ${directory}`);
  return sha256(JSON.stringify(files));
}

export async function sourceProvenance(root: string): Promise<{
  commit: string; dirty: boolean; dirty_files: string[]; inputs_sha256: string;
}> {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\u0000").filter(Boolean);
  const relevant = files.filter((path) => path === "bun.lock" || path === "package.json" ||
    path === "docs/process/feature-captures.md" || path === "scripts/capture.ts" || path === "scripts/build.ts" || path === "scripts/visual.mjs" || path === "scripts/workspace-lease.mjs" || path.startsWith("scripts/captures/") ||
    /^packages\/(?:core|ui-kit|ui-react|ui-sdk|ui-server|render-template)\//.test(path)).sort();
  const records = await Promise.all(relevant.map(async (path) => {
    try { return { path, sha256: sha256(await readFile(resolve(root, path))) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path, sha256: "deleted" };
    }
  }));
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(status),
    dirty_files: status ? status.split("\n").map((line) => line.trim()) : [],
    inputs_sha256: sha256(JSON.stringify(records)),
  };
}

/** An explicit output cannot overwrite the repo or the visual baselines, including through a symlink. */
export async function outputDirectory(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(root);
  const desired = resolve(root, requested);
  let existing = desired;
  const pending: string[] = [];
  while (true) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (dirname(existing) === existing) throw error;
      pending.unshift(relative(dirname(existing), existing));
      existing = dirname(existing);
    }
  }
  const actual = resolve(existing, ...pending);
  const baseline = resolve(rootReal, "packages/ui-kit/tests/visual");
  if (actual === rootReal || actual === baseline || actual.startsWith(baseline + sep)) {
    throw new Error("Capture output must be a dedicated directory outside the regression baselines and repository root");
  }
  const markerPath = resolve(actual, ".brain-kit-feature-captures.json");
  let marker: unknown;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
  catch {
    try {
      if ((await stat(actual)).isDirectory() && (await readdir(actual)).length) {
        throw new Error("Capture output already contains unrelated files; choose an empty or previously managed capture directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (marker !== undefined && (typeof marker !== "object" || marker === null ||
      (marker as { purpose?: string }).purpose !== "brain-kit editorial captures")) {
    throw new Error("Unrecognized capture output ownership marker");
  }
  await mkdir(actual, { recursive: true });
  if (marker === undefined) await writeFile(markerPath, JSON.stringify({ purpose: "brain-kit editorial captures" }) + "\n", { flag: "wx" });
  return actual;
}

export async function resolveBrowserPin(root: string): Promise<{ image: string; playwright: string }> {
  const runner = await readFile(resolve(root, "scripts/visual.mjs"), "utf8");
  const pins = [...runner.matchAll(/^const IMAGE = "([^"]+)";/gm)];
  if (pins.length !== 1) throw new Error("The shared visual runner must declare exactly one IMAGE pin");
  const image = pins[0][1];
  const version = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble$/.exec(image)?.[1];
  if (!version) throw new Error("Unrecognized shared Playwright image pin");
  const pkg = JSON.parse(await readFile(resolve(root, "packages/ui-kit/package.json"), "utf8"));
  const installed = JSON.parse(await readFile(resolve(root, "node_modules/playwright/package.json"), "utf8"));
  if (pkg.devDependencies?.playwright !== version || installed.version !== version) {
    throw new Error("Shared image, declared Playwright and installed Playwright versions differ; run the frozen install and verify the pin");
  }
  return { image, playwright: version };
}

/** Qualify overrides without changing an approved default filename. */
export function variantFile(file:string,declaredTheme:string,theme:string,viewport?:{width:number;height:number}):string {
  let result=file.replace(`-${declaredTheme}.`,`-${theme}.`);
  if(theme!==declaredTheme && result===file)result=result.replace(/(\.\w+)$/,`-${theme}$1`);
  return viewport?result.replace(/(\.\w+)$/,`-${viewport.width}x${viewport.height}$1`):result;
}
