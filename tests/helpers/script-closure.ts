/**
 * Copies a command's scripts into a throwaway repository (#4847): the entry
 * points, every file they reach through static and dynamic relative imports,
 * and the inputs no import names. Fixtures used to hand-copy these lists, so
 * one new import in scripts/test.ts meant editing every copy, and a missed
 * copy failed as module-not-found in a test about something else.
 *
 * The walk follows `import`, `export … from`, `import("…")` and `require("…")`
 * with a literal relative specifier. A relative specifier that resolves to no
 * file fails naming the importer and the specifier, and so does a dynamic
 * `import()` whose specifier is not a literal: the walk cannot see what it
 * loads, and skipping it would lose a file behind a green fixture.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

const REPO = join(import.meta.dir, "../..");

/** The test runner's entry point, the one most fixtures copy. */
export const TEST_RUNNER_ENTRY = "scripts/test.ts";

/** A file a command needs that no import names, and why. */
export interface ScriptInput { file: string; reason: string }

/** What `bun scripts/test.ts` reads without importing it. */
export const TEST_RUNNER_INPUTS: readonly ScriptInput[] = [
  { file: "scripts/offline-command.py", reason: "the offline launcher offline-command.ts runs by path" },
  { file: "scripts/test-network-preload.ts", reason: "the test preload scripts/test.ts names by path" },
  { file: "scripts/test-network-child-preload.ts", reason: "the preload the network guard hands to child processes by path" },
];

/** What `bun scripts/build.ts` reads without importing it. */
export const BUILD_INPUTS: readonly ScriptInput[] = [
  { file: "scripts/ci-build-entry.ts", reason: "the isolated build's container entry, launched by path from ci-build-operation.ts" },
  { file: "scripts/ci-build-qualification.json", reason: "the isolated build's policy, read by path from ci-build-operation.ts" },
];

const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

function resolveRelative(root: string, from: string, specifier: string): string {
  const base = normalize(join(dirname(from), specifier));
  const candidates = [base, base.replace(/\.js$/, ".ts"), ...[".ts", ".tsx", ".mts", ".mjs", ".js", ".json"].map(ext => base + ext), join(base, "index.ts")];
  const found = candidates.find(file => existsSync(join(root, file)) && statSync(join(root, file)).isFile());
  if (!found) throw new Error(`${from}: cannot resolve the relative import ${JSON.stringify(specifier)}`);
  return found;
}

/** The relative specifiers `file` imports, statically or dynamically. */
function relativeImports(root: string, file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) out.push(argument.text);
      else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error(`${file}: cannot follow the dynamic import ${node.getText(source)}; give it a literal specifier`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.filter(specifier => specifier.startsWith("."));
}

/** Repository-relative files the entries reach, plus the inputs (and what source inputs reach), sorted. */
export function scriptClosure(entries: readonly string[], inputs: readonly ScriptInput[] = [], root = REPO): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    if (!existsSync(join(root, file))) throw new Error(`${file}: does not exist`);
    seen.add(file);
    if (SOURCE.test(file)) for (const specifier of relativeImports(root, file)) walk(resolveRelative(root, file, specifier));
  };
  for (const file of [...entries, ...inputs.map(input => input.file)]) walk(file);
  return [...seen].sort();
}

/** Copies the closure into `destination` at the same repository-relative paths and returns it. */
export function copyScriptClosure(destination: string, entries: readonly string[], inputs: readonly ScriptInput[] = [], root = REPO): string[] {
  const files = scriptClosure(entries, inputs, root);
  for (const file of files) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(root, file), join(destination, file));
  }
  return files;
}
