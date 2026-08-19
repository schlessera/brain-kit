/**
 * G4 — the environment contract is documented, and the documentation is the
 * descriptor.
 *
 * `scripts/check-env-access.ts` guarantees a package reads the environment in
 * exactly one file. That is worth little on its own: `ui-server` read 31
 * variables from 59 sites for a year while its README listed nine names and two
 * wildcards, and the only true list lived in a *different repo*'s
 * `.env.example`. So the descriptor in `src/config/env.ts` is the source of
 * truth, the README table is generated from it, and these tests fail when they
 * disagree — in either direction.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  BEGIN,
  END,
  applyBlock,
  loadPackageEnv,
  packagesWithEnv,
  renderBlock,
} from "../scripts/env-docs.ts";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

const withEnv = packagesWithEnv();
const allPackages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("environment documentation", () => {
  test("some package declares an environment contract", () => {
    expect(withEnv.length).toBeGreaterThan(0);
  });

  for (const dir of withEnv) {
    test(`packages/${dir}: README env table matches the descriptor`, async () => {
      const pkg = await loadPackageEnv(dir);
      const readme = readFileSync(pkg.readmePath, "utf8");
      const updated = applyBlock(readme, renderBlock(pkg));
      expect(updated).not.toBeNull();
      // Regenerate with `bun run env-docs` after changing src/config/env.ts.
      expect(updated).toBe(readme);
    });

    test(`packages/${dir}: descriptor is well formed`, async () => {
      const pkg = await loadPackageEnv(dir);
      const names = pkg.vars.map((spec) => spec.name);
      expect(names).toEqual([...new Set(names)]);
      for (const spec of pkg.vars) {
        expect(spec.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(spec.description.trim().length).toBeGreaterThan(0);
        // `true` = always required; a string = the condition that makes it
        // required. Both render; a number or an object would not.
        expect(["boolean", "string"]).toContain(typeof spec.required);
        if (typeof spec.required === "string") {
          expect(spec.required.trim().length).toBeGreaterThan(0);
        }
      }
      for (const spec of pkg.dynamic) {
        expect(spec.source.trim().length).toBeGreaterThan(0);
        expect(spec.description.trim().length).toBeGreaterThan(0);
      }
    });

    test(`packages/${dir}: every literal env read is declared`, async () => {
      // The chokepoint lint proves nothing else in the package reads the
      // environment. This proves the chokepoint itself declares what it reads:
      // a `process.env.NEW_THING` added inside env.ts and left out of ENV_VARS
      // would otherwise be invisible to the documentation and to G4.
      const pkg = await loadPackageEnv(dir);
      const source = readFileSync(pkg.envModule, "utf8");
      const literals = new Set<string>();
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g)) {
        literals.add(match[1]);
      }
      for (const match of source.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
        literals.add(match[1]);
      }
      const declared = new Set(pkg.vars.map((spec) => spec.name));
      expect([...literals].filter((name) => !declared.has(name)).sort()).toEqual([]);
    });
  }

  for (const dir of allPackages.filter((d) => !withEnv.includes(d))) {
    test(`packages/${dir}: no stale env block without a descriptor`, () => {
      let readme: string;
      try {
        readme = readFileSync(join(PACKAGES_DIR, dir, "README.md"), "utf8");
      } catch {
        return; // no README is not this gate's business
      }
      expect(readme.includes(BEGIN) || readme.includes(END)).toBe(false);
    });
  }
});
