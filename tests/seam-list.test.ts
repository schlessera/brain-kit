/**
 * The extension seams 1.0 will freeze are listed in three places: the table in
 * docs/extending/README.md "The seams", the table in
 * docs/integration-contract.md "Extension interfaces", and the
 * `@experimental Extension seam` tag on each interface's own declaration.
 * Nothing checked that they agreed, and they drifted apart one additive change
 * at a time (#340). This test fails naming any seam that is in one and not the
 * others.
 *
 * The tags are read statically with the TypeScript compiler API, as
 * scripts/api-report.ts does; no package is imported.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

/** The text a seam's own `@experimental` tag starts with. Types a seam is made
 * of carry `@experimental` with other text, so they are not counted as seams. */
const SEAM_MARKER = "Extension seam";

interface Seam {
  name: string;
  /** The import specifier, e.g. `@schlessera/brain-ui-sdk/server`. */
  from: string;
}

const key = (s: Seam) => `${s.name} from ${s.from}`;

/** The body of the `## heading` section, up to the next heading of level 1 or 2. */
function section(file: string, heading: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`${file} has no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

/** Reads the first table in a section whose header has `Interface` and
 * `Imported from` columns. */
function seamTable(file: string, heading: string): Seam[] {
  const rows = section(file, heading)
    .split("\n")
    .filter((l) => l.trimStart().startsWith("|"))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const header = rows.findIndex((r) => r.includes("Interface") && r.includes("Imported from"));
  if (header < 0) throw new Error(`${file} "${heading}" has no Interface / Imported from table`);
  const nameCol = rows[header].indexOf("Interface");
  const fromCol = rows[header].indexOf("Imported from");
  const code = (cell: string) => /^`([^`]+)`$/.exec(cell)?.[1] ?? cell;
  return rows
    .slice(header + 2) // the header and its --- separator
    .map((r) => ({ name: code(r[nameCol]), from: code(r[fromCol]) }));
}

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, string | Record<string, string>>;
}

/** Every TypeScript export entry of every publishable package, by specifier. */
function exportEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const dir of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifest = JSON.parse(
      readFileSync(join(PACKAGES_DIR, dir.name, "package.json"), "utf8")
    ) as Manifest;
    if (manifest.private) continue;
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
      const target = typeof value === "string" ? value : value.bun ?? value.default;
      if (!/\.(ts|tsx)$/.test(target ?? "")) continue;
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      entries.set(specifier, join(PACKAGES_DIR, dir.name, target));
    }
  }
  return entries;
}

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error("could not read tsconfig.json");
  return { ...ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options, noEmit: true };
}

/** The text of each `@experimental` tag on a declaration itself — not one on a
 * file header, which neither the type checker nor an editor attaches to it. */
function experimentalTags(decl: ts.Declaration): string[] {
  return ts
    .getJSDocTags(decl)
    .filter((t) => t.tagName.text === "experimental")
    .map((t) => ts.getTextOfJSDocComment(t.comment) ?? "");
}

function isSeam(decls: ts.Declaration[]): boolean {
  return decls.some((d) => experimentalTags(d).some((t) => t.startsWith(SEAM_MARKER)));
}

const entries = exportEntries();
const program = ts.createProgram([...entries.values()], compilerOptions());
const checker = program.getTypeChecker();

/** Exported declarations by specifier and name, aliases resolved. */
function exportsOf(specifier: string): Map<string, ts.Declaration[]> {
  const file = entries.get(specifier);
  const source = file ? program.getSourceFile(file) : undefined;
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const out = new Map<string, ts.Declaration[]>();
  if (!moduleSymbol) return out;
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    out.set(symbol.getName(), resolved.declarations ?? []);
  }
  return out;
}

/** The name of every exported declaration whose own tag marks it a seam. */
function taggedSeams(): Set<string> {
  const names = new Set<string>();
  for (const specifier of entries.keys()) {
    for (const [name, decls] of exportsOf(specifier)) {
      if (isSeam(decls)) names.add(name);
    }
  }
  return names;
}

const extending = seamTable("docs/extending/README.md", "The seams");
const contract = seamTable("docs/integration-contract.md", "Extension interfaces");

describe("the extension seam list", () => {
  test("both documents list seams", () => {
    // A table the parser could not read would make every comparison below vacuous.
    expect(extending.length).toBeGreaterThan(0);
    expect(contract.length).toBeGreaterThan(0);
  });

  test("docs/extending/README.md and docs/integration-contract.md name the same seams", () => {
    const inContract = new Set(contract.map(key));
    const inExtending = new Set(extending.map(key));
    expect({
      "only in docs/extending/README.md": extending.map(key).filter((k) => !inContract.has(k)),
      "only in docs/integration-contract.md": contract.map(key).filter((k) => !inExtending.has(k)),
    }).toEqual({
      "only in docs/extending/README.md": [],
      "only in docs/integration-contract.md": [],
    });
  });

  test("every documented seam is exported where the docs say, with its own seam tag", () => {
    const seams = new Map([...extending, ...contract].map((s) => [key(s), s]));
    const untagged = [...seams.values()]
      .filter((s) => !isSeam(exportsOf(s.from).get(s.name) ?? []))
      .map(key);
    expect(untagged, `each needs \`@experimental ${SEAM_MARKER}; …\` on its declaration`).toEqual(
      []
    );
  });

  test("every declaration tagged as a seam is in both documents", () => {
    const tagged = [...taggedSeams()].sort();
    expect(tagged.length).toBeGreaterThan(0);
    const missingFrom = (seams: Seam[]) => {
      const names = new Set(seams.map((s) => s.name));
      return tagged.filter((name) => !names.has(name));
    };
    expect({
      "missing from docs/extending/README.md": missingFrom(extending),
      "missing from docs/integration-contract.md": missingFrom(contract),
    }).toEqual({
      "missing from docs/extending/README.md": [],
      "missing from docs/integration-contract.md": [],
    });
  });
});
