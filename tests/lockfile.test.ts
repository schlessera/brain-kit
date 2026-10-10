// The committed lockfile must be readable by the bun the repository pins.
//
// It was not, for a week. `bun.lock` was committed as `"lockfileVersion": 2`,
// which the then-pinned bun 1.3.14 could not parse:
//
//   error: Unknown lockfile version
//       at bun.lock:2:22
//   warn: Ignoring lockfile
//   error: lockfile had changes, but lockfile is frozen
//
// Both the `test` and `pack` jobs died there within ten seconds of starting,
// on every push to main from 2026-09-14, including the version commits for
// 0.35.0 and 0.36.0. Two releases were cut with no green run behind them, and
// a fresh contributor clone had its lockfile ignored.
//
// Nothing in the suite noticed, because a lockfile that cannot be read is a
// problem for the thing that reads it, and the suite runs after install. This
// test closes that: it reads the committed file directly.
//
// If bun legitimately moves to a new lockfile format, this fails and the fix is
// to raise the CI pin and this constant TOGETHER — which is the coupling that
// was missing when it broke.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Lockfile formats the pinned bun can read. Bun 1.4.2 preserves a compatible
 * loaded format and chooses a newer one when its dependency rules need it.
 * A file above this range needs a newer bun than CI installs.
 */
// Bun 1.4.2: src/install/lockfile/bun.lock.rs, Version::from_int.
const SUPPORTED_LOCKFILE_VERSIONS = [0, 1, 2, 3];

/** The bun `.github/workflows/ci.yml` installs for every job. */
function pinnedBunVersions(): string[] {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  return [...workflow.matchAll(/bun-version:\s*"([^"]+)"/g)].map((match) => match[1]!);
}

describe("bun.lock", () => {
  const raw = readFileSync(join(ROOT, "bun.lock"), "utf8");

  test("is a lockfile format the pinned bun can read", () => {
    // bun.lock is JSONC — trailing commas are legal — so read the field
    // rather than parsing the document.
    const match = raw.match(/"lockfileVersion":\s*(\d+)/);
    expect(match).not.toBeNull();
    const version = Number(match![1]);
    expect(SUPPORTED_LOCKFILE_VERSIONS).toContain(version);
  });

  test("every CI job installs the same bun", () => {
    // The failure above hit `test` and `pack` but not the jobs that never got
    // as far as installing. One pin, so one thing can be wrong instead of five.
    const versions = pinnedBunVersions();
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions).size).toBe(1);
  });

  test("names the workspaces the release ships", () => {
    // A lockfile that parses but has lost a workspace resolves that package
    // from the registry at its last published version, which is exactly the
    // stale-pin failure `scripts/check-publish-pins.ts` exists to catch — and
    // it would catch it at release time rather than here.
    for (const workspace of ["packages/core", "packages/ui-server", "packages/ui-kit"]) {
      expect(raw).toContain(`"${workspace}"`);
    }
  });
});
