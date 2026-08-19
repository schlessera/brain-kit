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
const dirs = packages.map((p) => p.dir).sort();
const sortedNames = [...names].sort();

/** Strips a subpath import down to its package name (`@scope/name/sub` → `@scope/name`). */
function packageNameOf(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

const CI_YML = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** The `for package in \ ... do` loop the pack job drives. */
function ciPackLoop(): string[] {
  const block = /for package in([\s\S]*?)\n\s*do\n/.exec(CI_YML);
  if (!block) throw new Error("could not find the pack job's package loop in ci.yml");
  return block[1]
    .split(/\s+/)
    .map((t) => t.replace(/\\$/, "").trim())
    .filter(Boolean);
}

/** A `const <name> = [ ... ]` string list inside one of the smoke-test heredocs. */
function ciImportList(variable: string): string[] {
  const block = new RegExp(`const ${variable} = \\[([\\s\\S]*?)\\];`).exec(CI_YML);
  if (!block) throw new Error(`could not find \`const ${variable} = [...]\` in ci.yml`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

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

// G1: every hand-maintained enumeration of the workspace is asserted against
// the packages/* glob. The CI pack job shipped for months with a 10-package
// list while 12 packages published — module-images and render-template got no
// pack check and no consumer-import smoke test, and nothing could notice,
// because the guard above only reads scripts/*.ts and the docs are prose.
describe("workspace enumerations", () => {
  test("the CI pack loop covers exactly the publishable package directories", () => {
    // A package missing here publishes with no tarball-shape check and no
    // smoke test; a stale entry fails the job on a directory that is gone.
    expect(ciPackLoop().sort()).toEqual(dirs);
  });

  test("the CI smoke-test overrides pin a tarball for every publishable package", () => {
    // The overrides map is how the consumer install resolves workspace deps to
    // the packed tarballs. A package absent here resolves from the public
    // registry instead, and the smoke test silently tests the PREVIOUS release.
    const overridden = [...CI_YML.matchAll(/"(@schlessera\/[^"]+)":\s*`file:/g)]
      .map((m) => m[1])
      .sort();
    expect(overridden).toEqual(sortedNames);
  });

  test("the CI bun smoke-test import list covers every publishable package", () => {
    expect(ciImportList("names").map(packageNameOf).sort()).toEqual(sortedNames);
  });

  test("the CI node smoke-test lists cover every publishable package, once", () => {
    // Every package must be probed under Node — either it imports cleanly
    // (nodePackages) or it fails only on its documented bun: dependency
    // (bunApiPackages). A package in neither list gets no check at all; a
    // package in both would hide a regression in one of the two expectations.
    const node = ciImportList("nodePackages").map(packageNameOf);
    const bunOnly = ciImportList("bunApiPackages").map(packageNameOf);
    const both = node.filter((n) => bunOnly.includes(n));
    expect(both).toEqual([]);
    expect([...new Set([...node, ...bunOnly])].sort()).toEqual(sortedNames);
  });

  test("the README repository layout block enumerates exactly the publishable packages", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const block = /## Repository layout\s*\n+```\n([\s\S]*?)```/.exec(readme);
    if (!block) throw new Error("could not find the Repository layout code block in README.md");
    const rows = [...block[1].matchAll(/^packages\/([a-z-]+)\s+(@schlessera\/[a-z-]+)/gm)];
    expect(rows.map((m) => m[1]).sort()).toEqual(dirs);
    expect(rows.map((m) => m[2]).sort()).toEqual(sortedNames);
  });

  test("the ROADMAP package table enumerates exactly the publishable packages", () => {
    const roadmap = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
    const section = /## Where this stands\n([\s\S]*?)\n## /.exec(roadmap);
    if (!section) throw new Error("could not find the 'Where this stands' section in ROADMAP.md");
    // First-column code spans of the table. Grouped rows abbreviate siblings
    // (`brain-module-jobs` / `-speaking` / `-finance`); a span starting with a
    // hyphen continues the previous span's prefix.
    const listed: string[] = [];
    for (const line of section[1].split("\n")) {
      if (!/^\|\s*`/.test(line)) continue;
      const firstCell = line.split("|")[1] ?? "";
      for (const span of firstCell.matchAll(/`([^`]+)`/g)) {
        const token = span[1];
        const previous = listed[listed.length - 1];
        const expanded =
          token.startsWith("-") && previous
            ? previous.slice(0, previous.lastIndexOf("-")) + token
            : token;
        listed.push(expanded);
      }
    }
    expect(listed.map((n) => `@schlessera/${n.replace(/^@schlessera\//, "")}`).sort()).toEqual(
      sortedNames
    );
  });

  test("the ROADMAP prose package count agrees with the packages/* glob", () => {
    // "Ten packages ship in lockstep" survived two package additions because
    // no machine ever read the word "Ten".
    const roadmap = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
    const words: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
      fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
      nineteen: 19, twenty: 20,
    };
    const counts = [...roadmap.matchAll(/\b([A-Za-z]+|\d+)\s+packages\s+ship\b/g)].map((m) =>
      /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()]
    );
    expect(counts.length).toBeGreaterThan(0);
    for (const count of counts) expect(count).toBe(packages.length);
  });
});
