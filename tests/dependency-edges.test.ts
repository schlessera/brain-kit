/**
 * Internal dependency-edge table.
 *
 * Which package may depend on which is an architecture decision, but until now
 * it lived nowhere a test could read — so `backend-claude` became a hard
 * dependency of `ui-server` simply by being written first, and every install
 * pulled the Anthropic Agent SDK even with AGENT_BACKEND=pi. The table
 * (tests/allowed-edges.ts) is the explicit statement: every allowed internal
 * edge, and of what kind. An edge outside it is not a lint nit — it is an
 * undecided architecture change.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "node:module";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
}

// The table itself lives in tests/allowed-edges.ts so the release-order guard
// in tests/release-manifest.test.ts can consume the same edges. Widening it is
// a deliberate decision with a review trail, not a fix-the-test reflex — see
// the failure messages below.
import { ALLOWED_EDGES } from "./allowed-edges";

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

const packages = publishablePackages();
const internalNames = new Set(packages.map((p) => p.manifest.name));

const DECIDE =
  "This edge is not in the ALLOWED_EDGES table in tests/allowed-edges.ts. " +
  "Do not widen the table to make the test pass — decide whether the edge should " +
  "exist at all, and if so whether it must be a hard dependency or an optional " +
  "peer, then record the decision in the table with a comment saying why.";

describe("internal dependency edges", () => {
  test("the table and the workspace agree on what exists", () => {
    // A package missing from the table has no declared edge policy; a table
    // row without a package is a leftover that would silently allow edges.
    const tabled = Object.keys(ALLOWED_EDGES).sort();
    expect(tabled).toEqual([...internalNames].sort());
  });

  for (const { manifest } of packages) {
    const allowed = ALLOWED_EDGES[manifest.name] ?? { dependencies: [], optionalPeers: [] };

    test(`${manifest.name}: internal hard dependencies are exactly the decided ones`, () => {
      const internal = Object.keys(manifest.dependencies ?? {}).filter((d) =>
        internalNames.has(d)
      );
      const undecided = internal.filter((d) => !allowed.dependencies.includes(d));
      expect(undecided, DECIDE).toEqual([]);
    });

    test(`${manifest.name}: internal peers are decided AND marked optional`, () => {
      const internal = Object.keys(manifest.peerDependencies ?? {}).filter((d) =>
        internalNames.has(d)
      );
      const undecided = internal.filter((d) => !allowed.optionalPeers.includes(d));
      expect(undecided, DECIDE).toEqual([]);
      // A peer that is not optional:true still hard-fails a plain `npm install`
      // for consumers who do not want it — which defeats the point of the peer.
      const notOptional = internal.filter(
        (d) => manifest.peerDependenciesMeta?.[d]?.optional !== true
      );
      expect(notOptional).toEqual([]);
    });

    test(`${manifest.name}: nothing the table wants optional is a hard dependency`, () => {
      // The exact regression that motivated this file: an optional-peer edge
      // quietly (re)appearing in `dependencies`, so every consumer installs it.
      const hardened = allowed.optionalPeers.filter((d) => manifest.dependencies?.[d]);
      expect(hardened).toEqual([]);
    });
  }
});

// Companion: the manifests must agree with the source. A specifier used but
// not declared works in the monorepo (hoisting) and breaks for the npm
// consumer; a declared internal dep that nothing imports is a stale edge that
// keeps installing (and keeps looking load-bearing) for no reason.
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return; // package without src/
    }
    for (const entry of entries) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(join(PACKAGES_DIR, dir, "src"));
  return out;
}

describe("internal specifiers match declared edges", () => {
  // Import syntax, plus any whole string literal that IS an internal
  // specifier: ui-server's lazy backend loading keeps its optional-peer
  // specifiers in a plain object literal and feeds them to a non-literal
  // `import()` (see the declaration-surface guard for why), and those
  // references must still count as "imported somewhere".
  const SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](@schlessera\/[^"']+)["']|["'](@schlessera\/[\w./-]*[a-z0-9])["']/gm;

  for (const { dir, manifest } of packages) {
    const declared = new Set(
      [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ].filter((d) => internalNames.has(d))
    );

    const used = new Set<string>();
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(SPECIFIER)) {
        used.add((match[1] ?? match[2]).split("/").slice(0, 2).join("/"));
      }
    }

    test(`${manifest.name}: every internal specifier in src/ is declared`, () => {
      const undeclared = [...used].filter((u) => !declared.has(u) && u !== manifest.name);
      expect(undeclared).toEqual([]);
    });

    test(`${manifest.name}: every declared internal dep is imported somewhere`, () => {
      const unused = [...declared].filter((d) => !used.has(d));
      expect(unused).toEqual([]);
    });
  }
});

// Companion, widened to EVERY external package: a bare specifier used in src/
// but declared nowhere resolves in the monorepo through hoisting and breaks —
// or silently floats to whatever version happens to be hoisted — for the npm
// consumer. Exactly how @earendil-works/pi-agent-core rode into
// ui-backend-pi's public .d.ts undeclared: the internal check above only
// matched @schlessera/*. Tests may lean on devDependencies; src may not.
describe("external specifiers are declared dependencies", () => {
  // Static string specifiers only — template-literal dynamic imports carry no
  // resolvable name, and the lazy-backend specifiers live in a plain object
  // literal (declared as optional peers, asserted by the edge table above).
  const SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

  // The import-syntax regex also fires on lookalikes inside ordinary strings
  // ('..., "from", "they", ...' in a stopword list). A real specifier is a
  // path or a package name; anything with whitespace, interpolation or quotes
  // in it is prose.
  const PLAUSIBLE_SPECIFIER = /^[@a-zA-Z_./][\w@./:-]*$/;

  const BUILTINS = new Set(builtinModules);

  /** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
  function packageNameOf(specifier: string): string {
    const segments = specifier.split("/");
    return segments.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  }

  function isRuntimeProvided(specifier: string): boolean {
    return (
      specifier.startsWith("node:") ||
      specifier.startsWith("bun:") ||
      specifier === "bun" ||
      BUILTINS.has(packageNameOf(specifier))
    );
  }

  for (const { dir, manifest } of packages) {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);

    test(`${manifest.name}: every bare specifier in src/ is a declared dependency`, () => {
      const undeclared = new Set<string>();
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(SPECIFIER)) {
          const specifier = match[1];
          if (!PLAUSIBLE_SPECIFIER.test(specifier)) continue;
          if (specifier.startsWith(".") || isRuntimeProvided(specifier)) continue;
          const name = packageNameOf(specifier);
          if (name === manifest.name || declared.has(name)) continue;
          undeclared.add(name);
        }
      }
      expect(
        [...undeclared].sort(),
        `${manifest.name} imports these in src/ without declaring them in ` +
          "dependencies/peerDependencies/optionalDependencies. In the monorepo they " +
          "resolve through hoisting; for the npm consumer they are missing or an " +
          "unpinned lottery. Declare each one (and decide hard vs peer) — do not " +
          "widen this test."
      ).toEqual([]);
    });
  }
});
