// The one list of packages a release builds, packs and publishes.
//
// It used to be written out by hand in scripts/build.ts, scripts/publish.ts,
// scripts/clean.ts and the CI pack loop, with a test regex-parsing each copy to
// keep them aligned. A package missing from one of them is silently skipped,
// and a release then ships dependents pinned to a version nobody published —
// the 0.2.0 failure in a new guise. Every consumer now reads the manifests.
//
//   bun scripts/publishable-packages.ts [root]
//
// prints the package directories one per line, in publish order, for shell
// consumers such as the CI pack job.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PublishableManifest {
  name: string;
  version: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

export interface PublishablePackage {
  /** Directory name under `packages/` — not the npm name (core → @schlessera/brain). */
  dir: string;
  name: string;
  version: string;
  manifest: PublishableManifest;
}

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Every non-private `packages/<dir>/package.json`, dependencies first.
 *
 * The order is the point: a dependent published before its dependency is
 * uninstallable in the window between the two `bun publish` calls. Only hard
 * internal edges (`dependencies`, `optionalDependencies`) constrain it —
 * internal peers are ranged `*`, so no publish order can break them, and
 * ui-kit's dev dependency on ui-sdk would otherwise form a cycle. Ties break
 * by directory name, so the order is stable across machines.
 */
export function listPublishablePackages(root: string = REPO_ROOT): PublishablePackage[] {
  const packagesDir = join(root, "packages");
  const found = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Bun's `packages/*` workspace glob only counts directories with a manifest.
    .filter((dir) => existsSync(join(packagesDir, dir, "package.json")))
    .sort()
    .map((dir) => {
      const file = join(packagesDir, dir, "package.json");
      const manifest = JSON.parse(readFileSync(file, "utf8")) as PublishableManifest;
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error(`packages/${dir}/package.json must declare a name and a version`);
      }
      return { dir, name: manifest.name, version: manifest.version, manifest };
    })
    .filter((pkg) => !pkg.manifest.private);

  const byName = new Map(found.map((pkg) => [pkg.name, pkg]));
  const dependsOn = new Map(
    found.map((pkg) => [
      pkg.name,
      new Set(
        Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies })
          .filter((dep) => byName.has(dep) && dep !== pkg.name)
      ),
    ])
  );

  const ordered: PublishablePackage[] = [];
  const placed = new Set<string>();
  while (ordered.length < found.length) {
    const next = found.find(
      (pkg) => !placed.has(pkg.name) && [...dependsOn.get(pkg.name)!].every((dep) => placed.has(dep))
    );
    if (!next) {
      const stuck = found.filter((pkg) => !placed.has(pkg.name)).map((pkg) => pkg.name);
      throw new Error(
        `Cannot order the publishable packages: their internal dependencies form a cycle among ${stuck.join(", ")}`
      );
    }
    ordered.push(next);
    placed.add(next.name);
  }
  return ordered;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? REPO_ROOT);
  const packages = listPublishablePackages(root);
  if (packages.length === 0) {
    console.error(`No publishable packages found under ${join(root, "packages")}`);
    process.exit(1);
  }
  console.log(packages.map((pkg) => pkg.dir).join("\n"));
}
