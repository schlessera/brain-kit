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
import ts from "typescript";
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

/** Names that look like an environment variable rather than a field. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Every environment variable name read in a chokepoint file, whether through
 * `process.env` directly or through a parameter holding the environment.
 *
 * Syntactic on purpose: the object being read is either `process.env` or an
 * identifier declared as `NodeJS.ProcessEnv`/`ProcessEnv`, which is exactly how
 * every resolver in this repo is written, and needs no type checker.
 */
function envReadsIn(file: string): Set<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true
  );
  const envIdentifiers = new Set<string>();
  const names = new Set<string>();

  const typeNamesEnv = (type: ts.TypeNode | undefined): boolean =>
    !!type && /(^|\.)ProcessEnv$/.test(type.getText(source).replace(/\s/g, ""));

  const isEnvObject = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return envIdentifiers.has(node.text);
    return (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    );
  };

  // Two passes: collect the identifiers that hold an environment first, since a
  // parameter is declared before it is read but a variable may not be.
  const collect = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      (typeNamesEnv(node.type) ||
        (node.initializer !== undefined && isEnvObject(node.initializer)))
    ) {
      envIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) {
      if (ENV_NAME.test(node.name.text)) names.add(node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      isEnvObject(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      ENV_NAME.test(node.argumentExpression.text)
    ) {
      names.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

const withEnv = packagesWithEnv();
const allPackages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("environment documentation", () => {
  test("some package declares an environment contract", () => {
    expect(withEnv.length).toBeGreaterThan(0);
  });

  test("the env-read detector sees both read forms", () => {
    // A gate is only worth what it catches, so prove it on a fixture rather
    // than trusting that the real chokepoints happen to pass.
    const fixture = join(ROOT, "tests", "fixtures", "env-reads.fixture.ts");
    const found = envReadsIn(fixture);
    expect([...found].sort()).toEqual([
      "ALIASED_READ",
      "BRACKET_READ",
      "DEFAULTED_PARAM_READ",
      "DIRECT_READ",
      "TYPED_PARAM_READ",
    ]);
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
      // a variable read inside env.ts and left out of ENV_VARS would otherwise
      // be invisible to the documentation and to this gate.
      //
      // Reads take two forms and BOTH must be covered. `process.env.X` is the
      // obvious one. The resolvers, though, take the environment as a parameter
      // (`resolveEnv(env: NodeJS.ProcessEnv = process.env)`) and then read
      // `env.X` — so a text scan for `process.env` sees almost nothing and
      // passes while the descriptor omits a real variable. Found by an
      // adversarial review of exactly this test.
      const pkg = await loadPackageEnv(dir);
      const literals = envReadsIn(pkg.envModule);
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
