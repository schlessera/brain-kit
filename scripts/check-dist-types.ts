/**
 * Typecheck what npm consumers actually get.
 *
 * The repo's own `bun run typecheck` runs with customConditions ["bun"], so
 * every cross-package import resolves to the sibling's src/ — the emitted
 * dist/*.d.ts (what the `types` condition serves to consumers) is never
 * typechecked by it. That blind spot is exactly how a phantom dependency
 * (@earendil-works/pi-agent-core in ui-backend-pi's history.d.ts) and a
 * bun-types leak through module .d.ts files shipped without anyone noticing.
 *
 * So, after `bun run build`, this script generates one minimal probe per
 * package — importing its entry and every subpath export — into a temp
 * project whose tsconfig has NO customConditions (moduleResolution "bundler",
 * strict, skipLibCheck OFF so errors inside the .d.ts graph count), resolving
 * through the workspace's own node_modules, and runs tsc over it. Any error
 * is a broken consumer typecheck and fails the script (and the CI pack job,
 * which runs it right after the build).
 *
 * Consumers come in two flavors, mirrored from ci.yml's smoke-test partition:
 * bunApiPackages document a bun: dependency, so their probe compiles with
 * bun-types (`types: ["bun"]`, the documented consumer setup); nodePackages
 * must typecheck for a consumer WITHOUT @types/bun installed, so their probe
 * excludes it — a bun-types reference leaking into one of their declaration
 * graphs fails here. The two lists are read from ci.yml itself and asserted
 * complete against packages/*, so a new package cannot dodge the check.
 *
 * With skipLibCheck off, tsc also reports defects inside THIRD-PARTY .d.ts
 * (e.g. @anthropic-ai/sdk's speculative ../../node_modules/undici-types
 * references). Those are not our surface and not ours to fix, so diagnostics
 * are filtered: only errors in the probes themselves or in our packages'
 * dist/ declarations fail the run.
 *
 * Two resolution roots, because the default one has a blind spot:
 *
 * - Default (no flag): probes resolve through the WORKSPACE's node_modules.
 *   That is the weaker approximation — hoisting installs every transitive of
 *   every package, so a dependency a .d.ts reaches for WITHOUT its package
 *   declaring it still resolves here and the gate passes in exactly the
 *   missing-dependency case. It still catches bun-types leaks (types: [] is
 *   authoritative for that) and broken subpath exports, so it stays useful
 *   as the fast local run.
 * - `--root <dir>`: probes are written into and resolve through <dir>'s
 *   node_modules instead. CI passes the pack job's tarball-consumer install
 *   (which holds ONLY the packed packages and their DECLARED dependencies,
 *   plus consumer-side @types/bun, @types/react and @types/react-dom), so an
 *   undeclared dependency in a published declaration has nothing to resolve
 *   against and fails loudly. This is the authoritative form.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

function parseRootFlag(argv: string[]): string {
  const index = argv.indexOf("--root");
  if (index === -1) return ROOT;
  const value = argv[index + 1];
  if (!value) {
    console.error("check-dist-types: --root requires a directory argument.");
    process.exit(1);
  }
  return resolve(value);
}

/** The install whose node_modules the probes resolve through. */
const RESOLVE_ROOT = parseRootFlag(process.argv.slice(2));
// Under node_modules so module resolution walks up to the root's installs,
// and so the probes are inherently untracked.
const PROBE_ROOT = join(RESOLVE_ROOT, "node_modules", ".brainkit-dist-type-probes");

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, unknown>;
}

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

/** A `const <name> = [ ... ]` string list inside ci.yml's node smoke test. */
function ciImportList(source: string, variable: string): string[] {
  const block = new RegExp(`const ${variable} = \\[([\\s\\S]*?)\\];`).exec(source);
  if (!block) throw new Error(`could not find \`const ${variable} = [...]\` in ci.yml`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function packageNameOf(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

const packages = publishablePackages();
const allNames = packages.map((p) => p.manifest.name).sort();

const ciYml = readFileSync(join(ROOT, ".depot/workflows/ci.yml"), "utf8");
const nodeNames = new Set(ciImportList(ciYml, "nodePackages").map(packageNameOf));
const bunNames = new Set(ciImportList(ciYml, "bunApiPackages").map(packageNameOf));

// Same guarantee tests/release-manifest.test.ts gives the smoke tests: the
// partition must cover every publishable package exactly once, or a package
// ships with no consumer-typecheck at all.
const union = [...new Set([...nodeNames, ...bunNames])].sort();
const overlap = [...nodeNames].filter((n) => bunNames.has(n));
if (overlap.length > 0) {
  console.error(`ci.yml lists packages as both node and bun consumers: ${overlap.join(", ")}`);
  process.exit(1);
}
if (JSON.stringify(union) !== JSON.stringify(allNames)) {
  console.error(
    "ci.yml's nodePackages/bunApiPackages lists do not cover packages/* exactly.\n" +
      `  listed:   ${union.join(", ")}\n  expected: ${allNames.join(", ")}`
  );
  process.exit(1);
}

/** Subpath exports worth probing: importable modules, not assets or metadata. */
function probeSubpaths(manifest: Manifest): string[] {
  return Object.keys(manifest.exports ?? { ".": true }).filter(
    (key) => key !== "./package.json" && !key.endsWith(".css")
  );
}

/**
 * The names api-report/<dir>.txt records for one export subpath, split into
 * runtime values and type-only exports. The report is generated from source;
 * the probe below holds the emitted declarations to the same boundary.
 */
function reportedNames(dir: string, subpath: string): { values: string[]; types: string[] } {
  const report = readFileSync(join(ROOT, "api-report", `${dir}.txt`), "utf8");
  const values: string[] = [];
  const types: string[] = [];
  let current: string | undefined;
  for (const line of report.split("\n")) {
    if (line.startsWith("signatures (")) break;
    const entry = /^export "([^"]+)"/.exec(line);
    if (entry) {
      current = entry[1];
      continue;
    }
    if (current !== subpath) continue;
    const name = /^  (type )?([\w$]+)$/.exec(line);
    if (name) (name[1] ? types : values).push(name[2]);
  }
  return { values, types };
}

function probeSource(dir: string, manifest: Manifest): string {
  const lines = probeSubpaths(manifest).map((subpath, i) => {
    const specifier = subpath === "." ? manifest.name : manifest.name + subpath.slice(1);
    // The curated boundary, from the consumer's side: every runtime value the
    // report lists and nothing else is a key of the emitted module, and every
    // type-only export the report lists resolves. A name dropped from the
    // source but left in dist, or a dist entry missing a curated name, fails.
    const { values, types } = reportedNames(dir, subpath);
    const keys = values.length > 0 ? values.map((v) => JSON.stringify(v)).join(" | ") : "never";
    // Aliased, so subpaths re-exporting the same type do not collide; an
    // import of a name the declarations lack fails with TS2305.
    const typeImport = types.length > 0
      ? `import type { ${types.map((t) => `${t} as Probe${i}_${t}`).join(", ")} } from "${specifier}";\n`
      : "";
    return `import * as probe${i} from "${specifier}";\nprobe${i};\n` +
      `type ProbeKeys${i} = BoundaryAssert<BoundaryEqual<keyof typeof probe${i}, ${keys}>>;\n` +
      typeImport;
  });
  lines.unshift(`type BoundaryEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type BoundaryAssert<T extends true> = T;`);
  if (manifest.name === "@schlessera/brain-ui-react") {
    // Check the emitted public helper, not the source selected by the bun condition.
    // Exact keys make a restored phantom version or missing timestamp fail too.
    lines.push(`import { createBrainApi, type BrainApi } from "@schlessera/brain-ui-react";
 type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
 type Assert<T extends true> = T;
 type Health = { status: string; uptime: number; timestamp: string };
 type FactoryHealth = Assert<Equal<Awaited<ReturnType<ReturnType<typeof createBrainApi>["health"]>>, Health>>;
 type ServiceHealth = Assert<Equal<Awaited<ReturnType<BrainApi["health"]>>, Health>>;
 type Sync = Assert<Equal<Awaited<ReturnType<BrainApi["brainSync"]>>, { success: boolean; message: string }>>;
`);
  }
  if (manifest.name === "@schlessera/brain") {
    lines.push(`import type { SearchResult, RerankCandidate } from "@schlessera/brain";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type SearchTags = Assert<Equal<SearchResult["tags"], string | null>>;
type CandidateTags = Assert<Equal<RerankCandidate["tags"], string | null | undefined>>;`);
  }
  return lines.join("\n") + "\n";
}

function writeProbeProject(
  name: "node-consumers" | "bun-consumers",
  members: { dir: string; manifest: Manifest }[]
): string {
  const dir = join(PROBE_ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const { dir: packageDir, manifest } of members) {
    writeFileSync(join(dir, `${packageDir}.probe.ts`), probeSource(packageDir, manifest));
  }
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          // The conventional consumer resolution: no customConditions, so the
          // `types` condition serves dist/*.d.ts — the artifact under test.
          moduleResolution: "bundler",
          strict: true,
          // The point of the exercise: errors INSIDE the resolved .d.ts graph
          // (an undeclared import, a bun-types reference a node consumer
          // cannot resolve) must fail, and skipLibCheck would wave them past.
          skipLibCheck: false,
          noEmit: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          jsx: "react-jsx",
          types: name === "bun-consumers" ? ["bun"] : [],
        },
        include: ["*.probe.ts"],
      },
      null,
      2
    ) + "\n"
  );
  return dir;
}

const bunx = Bun.which("bunx");
if (!bunx) {
  console.error("check-dist-types failed: could not find `bunx` on PATH.");
  process.exit(1);
}

/**
 * Diagnostics that are OUR problem: in a probe file, or inside one of our
 * packages' emitted dist/ declarations. In the workspace run tsc prints the
 * symlinks' realpaths (packages/<dir>/dist/...); in an isolated --root run
 * the tarball installs are real directories, so the same declarations show
 * as .../node_modules/@schlessera/<name>/dist/... — both count. `--pretty
 * false` output is one diagnostic per `path(line,col): error TS...` line,
 * with indented elaboration lines following; a line with no path (a global
 * config error, e.g. an unresolvable `types` entry) always counts.
 */
function ownDiagnostics(tscOutput: string): string[] {
  const own: string[] = [];
  let keepElaboration = false;
  for (const line of tscOutput.split("\n")) {
    if (/^\s/.test(line)) {
      if (keepElaboration && line.trim()) own.push(line);
      continue;
    }
    if (!/\berror TS\d+:/.test(line)) {
      keepElaboration = false;
      continue;
    }
    keepElaboration =
      /^error TS\d+:/.test(line) ||
      line.includes(".brainkit-dist-type-probes") ||
      /(?:^|\/)packages\/[^(]*\/dist\//.test(line) ||
      /node_modules\/@schlessera\/[^(]*\/dist\//.test(line);
    if (keepElaboration) own.push(line);
  }
  return own;
}

rmSync(PROBE_ROOT, { recursive: true, force: true });
let failed = false;
for (const flavor of ["node-consumers", "bun-consumers"] as const) {
  const wanted = flavor === "node-consumers" ? nodeNames : bunNames;
  const members = packages.filter((p) => wanted.has(p.manifest.name));
  const dir = writeProbeProject(flavor, members);

  console.log(
    `Typechecking dist for ${flavor} against ${RESOLVE_ROOT} ` +
      `(${members.map((m) => m.dir).join(", ")})...`
  );
  const tsc = Bun.spawn([bunx, "tsc", "-p", dir, "--pretty", "false"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(tsc.stdout).text(),
    new Response(tsc.stderr).text(),
  ]);
  const exitCode = await tsc.exited;
  if (exitCode === 0) continue;
  const own = ownDiagnostics(stdout + stderr);
  if (own.length > 0) {
    console.error(own.join("\n"));
    failed = true;
  } else {
    console.log(
      `  (tsc exited ${exitCode}, but every error is inside third-party .d.ts — ignored)`
    );
  }
}

if (failed) {
  console.error(
    "\ncheck-dist-types failed: the published type surface breaks for consumers. " +
      "Fix the declaration (usually a dependency missing from the offending " +
      "package's manifest, or bun-only types leaking into a node-clean package) " +
      "rather than loosening the probe."
  );
  process.exit(1);
}
console.log("check-dist-types: all consumer type surfaces are clean.");
