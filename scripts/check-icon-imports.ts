// ui-react names its icon set in one file (#4737), as the kit does in
// `primitives/Icon.tsx`: `components/icons.ts` re-exports the lucide glyphs
// the app uses, so an icon-set swap or a lucide major is a change to that file.
// Three rules under packages/ui-react/src:
//   1. only `components/icons.ts` may name the module `lucide-react` or any
//      subpath of it, in any import form;
//   2. every statement in it is a named re-export from `lucide-react` (no key
//      map, no component: a bundler can still place each glyph in the chunk
//      that uses it);
//   3. every name it re-exports is imported from it by another file. The
//      unused-exports gate cannot hold this one: it skips a re-export whose
//      source is outside the repository.
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
import { parse, treeFiles } from "./lib/source";

const SRC = "packages/ui-react/src";
export const ICONS = `${SRC}/components/icons.ts`;
const MODULE = "lucide-react";

type Sources = Record<string, string>;

const lineOf = (tree: ts.SourceFile, node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

/** Every module specifier a file names, in any import or re-export form. */
function specifiers(tree: ts.SourceFile): ts.StringLiteralLike[] {
  const found: ts.StringLiteralLike[] = [];
  const add = (node: ts.Node | undefined) => { if (node && ts.isStringLiteralLike(node)) found.push(node); };
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

/** True for `lucide-react` and any subpath of it, such as `lucide-react/dist/esm/icons/x`. */
const namesLucide = (specifier: string) => specifier === MODULE || specifier.startsWith(`${MODULE}/`);

/** True when `specifier`, written in `file`, names `components/icons.ts`. */
function namesIcons(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.(js|ts|tsx)$/, "");
  return target === ICONS.replace(/\.ts$/, "");
}

/** Findings for the files under packages/ui-react/src; keys are repo-relative paths. */
export function checkIconImports(sources: Sources): string[] {
  const findings: string[] = [];
  const exported = new Map<string, number>();
  const imported = new Set<string>();
  for (const [file, source] of Object.entries(sources)) {
    const tree = parse(file, source);
    if (file === ICONS) {
      for (const statement of tree.statements) {
        const line = lineOf(tree, statement);
        const reexport = ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === MODULE && statement.exportClause && ts.isNamedExports(statement.exportClause);
        if (!reexport) {
          findings.push(`${file}:${line}: only named re-exports from "${MODULE}" belong here — no map, component or other statement`);
          continue;
        }
        for (const element of (statement.exportClause as ts.NamedExports).elements) exported.set(element.name.text, lineOf(tree, element));
      }
      continue;
    }
    for (const literal of specifiers(tree)) {
      if (namesLucide(literal.text)) findings.push(`${file}:${lineOf(tree, literal)}: imports "${literal.text}" directly — import the glyph from components/icons.ts`);
      else if (namesIcons(file, literal.text)) {
        const clause = literal.parent;
        if ((ts.isImportDeclaration(clause) && clause.importClause?.namedBindings && ts.isNamedImports(clause.importClause.namedBindings))) {
          for (const element of clause.importClause.namedBindings.elements) imported.add((element.propertyName ?? element.name).text);
        } else if (ts.isExportDeclaration(clause) && clause.exportClause && ts.isNamedExports(clause.exportClause)) {
          for (const element of clause.exportClause.elements) imported.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }
  for (const [name, line] of exported) {
    if (!imported.has(name)) findings.push(`${ICONS}:${line}: ${name} is re-exported but no other file under ${SRC} imports it — remove it`);
  }
  return findings;
}

/** The ui-react sources under `root`, by repository-relative path. */
export function scanSources(root: string): Sources {
  const sources: Sources = {};
  for (const file of treeFiles(root, `${SRC}/**/*.{ts,tsx}`)) sources[file.split("\\").join("/")] = readFileSync(resolve(root, file), "utf8");
  return sources;
}

/** The gate as `bun run lint` runs it: prints its findings, returns its exit code. */
export function lintGate(root: string): number {
  const sources = scanSources(root);
  if (!(ICONS in sources)) {
    // A missing module would leave rules 2 and 3 checking nothing.
    console.error(`icon-imports: ${ICONS} is missing; the gate checked nothing`);
    return 1;
  }
  const findings = checkIconImports(sources);
  if (findings.length) {
    console.error(findings.join("\n"));
    return 1;
  }
  console.log(`icon-imports: ${Object.keys(sources).length} files name lucide-react only through ${ICONS}`);
  return 0;
}

if (import.meta.main) process.exit(lintGate(resolve(process.argv[2] ?? ".")));
