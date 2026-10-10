// A manifest `bin` target must be executable in the built workspace, not only
// in an installed tarball: `bun install` links node_modules/.bin/<name> to the
// workspace's dist file, and `tsc` writes that file 0644. Package managers set
// the mode when they install a tarball, so a published package is unaffected;
// a local `bun run build` left every spawn of the linked bin failing with
// EACCES (#1536). The targets come from the manifests, so a new bin needs no
// list edit here.
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { listPublishablePackages, type PublishableManifest } from "./publishable-packages.ts";

/** The `bin` targets one manifest declares, as paths relative to its package directory. */
export function binTargets(manifest: PublishableManifest): string[] {
  return Object.values(manifest.bin ?? {});
}

/** Marks every declared `bin` target executable; a missing target throws. */
export function markBinsExecutable(packageDir: string, manifest: PublishableManifest): void {
  for (const target of binTargets(manifest)) {
    const file = join(packageDir, target);
    const { mode } = statSync(file);
    chmodSync(file, mode | 0o111);
  }
}

/** Every publishable `bin` target that is missing or not executable, as `packages/<dir>/<target>: <why>`. */
export function binModeProblems(root: string): string[] {
  const problems: string[] = [];
  for (const pkg of listPublishablePackages(root)) {
    for (const target of binTargets(pkg.manifest)) {
      const shown = `packages/${pkg.dir}/${target.replace(/^\.\//, "")}`;
      let mode: number;
      try {
        mode = statSync(join(root, "packages", pkg.dir, target)).mode;
      } catch {
        problems.push(`${shown}: missing`);
        continue;
      }
      if ((mode & 0o111) !== 0o111) problems.push(`${shown}: mode ${(mode & 0o777).toString(8)} is not executable`);
    }
  }
  return problems;
}
