/**
 * Repo-level release guards.
 *
 * These encode release pitfalls that have actually bitten, each of which was
 * documented in prose first and then walked into anyway. Prose does not fail a
 * build; these do.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Every package directory that is meant to reach npm. */
function publishablePackages(): { dir: string; manifest: Manifest }[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dir: e.name,
      manifest: JSON.parse(
        readFileSync(join(PACKAGES_DIR, e.name, "package.json"), "utf8")
      ) as Manifest,
    }))
    .filter((p) => !p.manifest.private);
}

/** The `const packages = [...]` list a script drives its loop from. */
function scriptPackageList(file: string): string[] {
  const src = readFileSync(join(ROOT, "scripts", file), "utf8");
  const block = /const packages = \[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error(`could not find a packages list in scripts/${file}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const packages = publishablePackages();
const names = new Set(packages.map((p) => p.manifest.name));

describe("release manifests", () => {
  test("there are packages to check", () => {
    expect(packages.length).toBeGreaterThan(5);
  });

  // A new package added to packages/ but not to these hardcoded lists is
  // silently skipped: the release ships dependents that pin a version nobody
  // published, which is the 0.2.0 uninstallable-package failure in a new guise.
  for (const script of ["publish.ts", "build.ts"]) {
    test(`scripts/${script} lists every publishable package`, () => {
      const listed = scriptPackageList(script);
      const missing = packages.map((p) => p.dir).filter((d) => !listed.includes(d));
      expect(missing).toEqual([]);
    });

    test(`scripts/${script} lists nothing that no longer exists`, () => {
      const listed = scriptPackageList(script);
      const dirs = new Set(packages.map((p) => p.dir));
      expect(listed.filter((d) => !dirs.has(d))).toEqual([]);
    });
  }

  // Changesets majors any package that peer-depends on something being
  // released once the new version falls outside the declared range. With a
  // fixed group that promotion spreads to every package, so one caret range
  // turns a minor release into 1.0.0. `*` is never out of range.
  test("internal peer dependencies are ranged `*`", () => {
    const offenders: string[] = [];
    for (const { manifest } of packages) {
      for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!names.has(dep)) continue; // external peers are not our problem
        if (range !== "*") offenders.push(`${manifest.name} → ${dep}@${range}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the changesets fixed group covers every publishable package", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8")) as {
      fixed?: string[][];
      ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?: Record<string, unknown>;
    };
    const group = new Set(config.fixed?.[0] ?? []);
    const missing = [...names].filter((n) => !group.has(n));
    expect(missing).toEqual([]);
  });

  test("the peer-dependent guard stays enabled", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8")) as {
      ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?: {
        onlyUpdatePeerDependentsWhenOutOfRange?: boolean;
      };
    };
    expect(
      config.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH
        ?.onlyUpdatePeerDependentsWhenOutOfRange
    ).toBe(true);
  });

  test("all packages sit on one version", () => {
    // The fixed group guarantees this after a release; a drift here means a
    // hand-edited manifest and a release that will not do what it appears to.
    expect(new Set(packages.map((p) => p.manifest.version)).size).toBe(1);
  });
});
