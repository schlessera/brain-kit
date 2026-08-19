/**
 * Internal dependency-edge table.
 *
 * Which package may depend on which is an architecture decision, but until now
 * it lived nowhere a test could read — so `backend-claude` became a hard
 * dependency of `ui-server` simply by being written first, and every install
 * pulled the Anthropic Agent SDK even with AGENT_BACKEND=pi. This table is the
 * explicit statement: every allowed internal edge, and of what kind. An edge
 * outside it is not a lint nit — it is an undecided architecture change.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Edges {
  /** Internal packages this one may list in `dependencies` (hard, always installed). */
  dependencies: string[];
  /** Internal packages this one may list only as OPTIONAL `peerDependencies`. */
  optionalPeers: string[];
}

// The table. Keyed by npm name; values are the edges the architecture allows.
// Widening it is a deliberate decision with a review trail, not a fix-the-test
// reflex — see the failure messages below.
const ALLOWED_EDGES: Record<string, Edges> = {
  // core owns the render template (the CLI's `brain render` uses it); the
  // Puppeteer renderer is heavyweight and optional, so it may never be hard.
  "@schlessera/brain": {
    dependencies: ["@schlessera/brain-render-template"],
    optionalPeers: ["@schlessera/brain-render-puppeteer"],
  },
  // Content modules extend core and nothing else.
  "@schlessera/brain-module-finance": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  "@schlessera/brain-module-images": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  "@schlessera/brain-module-jobs": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  "@schlessera/brain-module-speaking": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  // Leaves: no internal edges at all.
  "@schlessera/brain-render-template": { dependencies: [], optionalPeers: [] },
  "@schlessera/brain-render-puppeteer": { dependencies: [], optionalPeers: [] },
  "@schlessera/brain-ui-sdk": { dependencies: [], optionalPeers: [] },
  // Agent backends implement the SDK seam; pi additionally embeds core.
  "@schlessera/brain-backend-claude": {
    dependencies: ["@schlessera/brain-ui-sdk"],
    optionalPeers: [],
  },
  "@schlessera/brain-backend-pi": {
    dependencies: ["@schlessera/brain", "@schlessera/brain-ui-sdk"],
    optionalPeers: [],
  },
  "@schlessera/brain-ui-react": {
    dependencies: ["@schlessera/brain-ui-sdk"],
    optionalPeers: [],
  },
  // ui-server drives whichever backend the deployment picks, so BOTH backends
  // are optional peers — a hard dependency on either would ship that agent SDK
  // to every install regardless of AGENT_BACKEND. The consumer (brain-ui)
  // declares the backend it actually deploys.
  "@schlessera/brain-ui-server": {
    dependencies: ["@schlessera/brain-render-template", "@schlessera/brain-ui-sdk"],
    optionalPeers: ["@schlessera/brain-backend-claude", "@schlessera/brain-backend-pi"],
  },
};

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
  "This edge is not in the ALLOWED_EDGES table in tests/dependency-edges.test.ts. " +
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
describe("internal specifiers match declared edges", () => {
  const SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](@schlessera\/[^"']+)["']/gm;

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
        used.add(match[1].split("/").slice(0, 2).join("/"));
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
