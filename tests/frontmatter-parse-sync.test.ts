/**
 * frontmatter-parse sync gate — the cache-free parse helper is a COPY, and
 * this test is what makes a copy safe (#142).
 *
 * Every package that parses frontmatter carries the same
 * `src/lib/frontmatter-parse.ts`. There is deliberately no shared package or
 * public export for it: one function does not justify a dependency edge
 * (ui-server does not depend on core) or a new entry in core's public API.
 * `packages/core/src/lib/frontmatter-parse.ts` is the canonical copy, every
 * other copy must be byte-identical to it, and scripts/check-frontmatter-parse.ts
 * makes the copies the only files that may call gray-matter's parser.
 *
 * On failure: edit the canonical copy, copy it verbatim to every
 * `packages/*\/src/lib/frontmatter-parse.ts`, and rerun.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const COPY = join("src", "lib", "frontmatter-parse.ts");
const CANONICAL = join(PACKAGES_DIR, "core", COPY);

const withCopy = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, COPY)))
  .map((entry) => entry.name)
  .sort();

/** True if some other source file in the package imports its copy. */
function importsCopy(dir: string): boolean {
  const glob = new Bun.Glob("src/**/*.{ts,tsx}");
  for (const file of glob.scanSync({ cwd: join(PACKAGES_DIR, dir) })) {
    if (file === COPY) continue;
    if (/from\s+["'][^"']*frontmatter-parse(\.js)?["']/.test(readFileSync(join(PACKAGES_DIR, dir, file), "utf8"))) {
      return true;
    }
  }
  return false;
}

describe("frontmatter-parse sync", () => {
  test("the canonical copy exists and states the sync rule in its header", () => {
    const header = readFileSync(CANONICAL, "utf8");
    expect(header).toContain("SYNC-ENFORCED");
    expect(header).toContain("tests/frontmatter-parse-sync.test.ts");
  });

  test("the packages that parse frontmatter are the ones carrying a copy", () => {
    // A package gaining a parser must copy the helper in; this list moving is
    // the review trail for that.
    expect(withCopy).toEqual(["core", "module-finance", "module-jobs", "ui-server"]);
  });

  test("every copy is used by its package", () => {
    expect(withCopy.filter((dir) => !importsCopy(dir))).toEqual([]);
  });

  const canonicalText = readFileSync(CANONICAL, "utf8");
  for (const dir of withCopy.filter((d) => d !== "core")) {
    test(`packages/${dir}/${COPY} is byte-identical to the canonical copy`, () => {
      expect(
        readFileSync(join(PACKAGES_DIR, dir, COPY), "utf8"),
        `packages/${dir}/${COPY} has drifted from packages/core/${COPY} — edit one, copy to all`
      ).toBe(canonicalText);
    });
  }
});
