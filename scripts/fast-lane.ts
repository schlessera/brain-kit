/**
 * The one definition of the core packages (#4110). A pull request whose diff
 * touches none of them may take the fast lane; one that touches any of them
 * keeps ready confirmation and needs a recorded independent review
 * (`scripts/review-receipt.ts`). Both rules read this predicate, so the two
 * lanes cannot drift apart.
 *
 *   gh pr diff <pr> --name-only | bun scripts/fast-lane.ts
 *
 * prints one line of JSON: the lane and the core-package paths that decided it.
 */
export const CORE_PACKAGES = ["ui-react", "ui-kit", "ui-server", "core"] as const;

export function isCorePackagePath(path: string): boolean {
  return CORE_PACKAGES.some(name => path.startsWith(`packages/${name}/`));
}

/** True when any changed path lies under a core package: the full lane. */
export function touchesCorePackages(paths: readonly string[]): boolean {
  return paths.some(isCorePackagePath);
}

if (import.meta.main) {
  const paths = (await Bun.stdin.text()).split("\n").map(line => line.trim()).filter(Boolean);
  if (!paths.length) { console.error("usage: gh pr diff <pr> --name-only | bun scripts/fast-lane.ts (no changed paths were read)"); process.exit(2); }
  const corePaths = paths.filter(isCorePackagePath);
  console.log(JSON.stringify({ lane: corePaths.length ? "full" : "fast", paths: paths.length, corePaths }));
}
