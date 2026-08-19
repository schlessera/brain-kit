/**
 * Changeset gate.
 *
 * CONTRIBUTING.md has asked for a changeset on every user-visible change since
 * the repo opened. The commit that made `ui-server`'s exports breaking shipped
 * without one, and a review caught it rather than the build — the exact failure
 * this branch exists to stop.
 *
 * "User-visible" is derived, not guessed: a path counts when it is inside one
 * of the directories its own package lists in `files`, because that is
 * precisely what npm puts in the tarball. `dist` is excluded — it is generated
 * from `src`, which is already covered, so counting it would double-count and
 * would fire on a build artifact that is not tracked anyway.
 *
 *   bun scripts/check-changeset.ts <base-ref>
 */

import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

export interface ChangesetVerdict {
  /** Shipped files that put this change in scope, relative to the repo root. */
  shipped: string[];
  /** Changeset files ADDED by this change. */
  added: string[];
  /** True when this is a `changeset version` release PR, which removes them. */
  release: boolean;
  ok: boolean;
}

/** The tarball-visible directories of one package, `dist` excluded. */
export function shippedRoots(packageDir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  ) as { files?: string[]; private?: boolean };
  if (manifest.private) return [];
  return (manifest.files ?? []).filter((entry) => entry !== "dist");
}

function shippedRootsByPackage(root: string): Map<string, string[]> {
  const packagesDir = join(root, "packages");
  const map = new Map<string, string[]>();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    map.set(entry.name, shippedRoots(join(packagesDir, entry.name)));
  }
  return map;
}

export function judge(
  changed: string[],
  addedChangesets: string[],
  shippedByPackage: Map<string, string[]>
): ChangesetVerdict {
  const shipped: string[] = [];
  for (const file of changed) {
    const match = /^packages\/([^/]+)\/(.+)$/.exec(file);
    if (!match) continue;
    const roots = shippedByPackage.get(match[1]);
    if (!roots) continue;
    // The manifest itself ships: dependencies, exports and engines are all
    // user-visible even when no source moved.
    if (match[2] === "package.json") {
      shipped.push(file);
      continue;
    }
    const top = match[2].split("/")[0];
    if (roots.includes(top) || roots.includes(match[2])) shipped.push(file);
  }

  // `changeset version` consumes the changesets and writes CHANGELOGs. Such a
  // PR legitimately changes every manifest while ADDING no changeset.
  const release =
    changed.some((f) => /^packages\/[^/]+\/CHANGELOG\.md$/.test(f)) &&
    changed.some((f) => /^\.changeset\/.+\.md$/.test(f)) &&
    addedChangesets.length === 0;

  return {
    shipped,
    added: addedChangesets,
    release,
    ok: release || shipped.length === 0 || addedChangesets.length > 0,
  };
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: bun scripts/check-changeset.ts <base-ref>");
    process.exit(2);
  }

  const git = (args: string[]): string[] => {
    const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
    if (result.exitCode !== 0) {
      console.error(`git ${args.join(" ")} failed:`);
      console.error(new TextDecoder().decode(result.stderr));
      // A base ref that will not resolve means a shallow clone or a bad
      // configuration. Fail loudly: a gate that cannot see the diff must not
      // report success.
      process.exit(2);
    }
    return new TextDecoder()
      .decode(result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };

  const changed = git(["diff", "--name-only", `${base}...HEAD`]);
  const addedChangesets = git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    `${base}...HEAD`,
    "--",
    ".changeset",
  ]).filter((file) => file.endsWith(".md") && !file.endsWith("README.md"));

  const verdict = judge(changed, addedChangesets, shippedRootsByPackage(ROOT));

  if (verdict.release) {
    console.log("Release PR (changesets consumed, CHANGELOGs written) — no new changeset required.");
    process.exit(0);
  }
  if (verdict.shipped.length === 0) {
    console.log("No shipped package files changed; no changeset required.");
    process.exit(0);
  }
  if (verdict.ok) {
    console.log(`Changeset present: ${verdict.added.join(", ")}`);
    process.exit(0);
  }

  console.error("Shipped package files changed but no changeset was ADDED:\n");
  for (const file of verdict.shipped.slice(0, 40)) console.error(`  ${file}`);
  if (verdict.shipped.length > 40) {
    console.error(`  … and ${verdict.shipped.length - 40} more`);
  }
  console.error(
    "\nRun `bun run changeset` and say what was added, changed or removed." +
      "\nEditing an existing changeset from the base branch does not count — the" +
      "\ngate requires one this change contributes."
  );
  process.exit(1);
}
