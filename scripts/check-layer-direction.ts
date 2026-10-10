// ui-react's lower layers never import its components (#1380). `stores/`,
// `lib/` and `connection.ts` are what components are built on; an import the
// other way makes a store or a helper load React views, and makes a component
// move break code that has nothing to do with rendering.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SRC = "packages/ui-react/src";
const LOWER = [`${SRC}/stores/`, `${SRC}/lib/`, `${SRC}/connection.ts`];
const UPPER = `${SRC}/components/`;

/** True for a repo-relative path the rule applies to. */
export function isLowerLayer(file: string): boolean {
  const path = file.split(sep).join("/");
  return LOWER.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix));
}

/** Findings for one lower-layer file; `file` is repo-relative. */
export function checkLayerDirection(source: string, file: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const check = (literal: ts.Node) => {
    if (!ts.isStringLiteralLike(literal) || !literal.text.startsWith(".")) return;
    const target = relative(".", resolve(dirname(file), literal.text)).split(sep).join("/");
    if (!`${target}/`.startsWith(UPPER)) return;
    const { line } = tree.getLineAndCharacterOfPosition(literal.getStart(tree));
    findings.push(`${file}:${line + 1}: ${literal.text} — stores/, lib/ and connection.ts must not import components/; move the shared code into lib/`);
  };
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) check(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const findings: string[] = [];
  let checked = 0;
  for (const file of new Bun.Glob(`${SRC}/**/*.{ts,tsx}`).scanSync(root)) {
    if (!isLowerLayer(file)) continue;
    checked++;
    findings.push(...checkLayerDirection(readFileSync(resolve(root, file), "utf8"), file));
  }
  if (checked === 0) {
    // A glob that matches nothing would pass forever.
    console.error(`layer-direction: no files under ${LOWER.join(", ")}; the gate checked nothing`);
    process.exit(1);
  }
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exit(1);
  }
  console.log(`layer-direction: ${checked} lower-layer files import no components`);
}
