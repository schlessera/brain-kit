// ui-react's lower layers never import its components (#1380). `stores/`,
// `lib/`, `connection.ts` and the `ws-client/` parts it composes (#1362) are
// what components are built on; an import the
// other way makes a store or a helper load React views, and makes a component
// move break code that has nothing to do with rendering.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { parse, treeFiles } from "./lib/source";

const SRC = "packages/ui-react/src";
const LOWER = [`${SRC}/stores/`, `${SRC}/lib/`, `${SRC}/connection.ts`, `${SRC}/ws-client/`];
const UPPER = `${SRC}/components/`;

/** True for a repo-relative path the rule applies to. */
export function isLowerLayer(file: string): boolean {
  const path = file.split(sep).join("/");
  return LOWER.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix));
}

/** Findings for one lower-layer file; `file` is repo-relative. */
export function checkLayerDirection(source: string, file: string): string[] {
  const tree = parse(file, source, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const check = (literal: ts.Node) => {
    if (!ts.isStringLiteralLike(literal) || !literal.text.startsWith(".")) return;
    const target = relative(".", resolve(dirname(file), literal.text)).split(sep).join("/");
    if (!`${target}/`.startsWith(UPPER)) return;
    const { line } = tree.getLineAndCharacterOfPosition(literal.getStart(tree));
    findings.push(`${file}:${line + 1}: ${literal.text} — stores/, lib/, connection.ts and ws-client/ must not import components/; move the shared code into lib/`);
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

/** Findings for every lower-layer file under `root`, and how many files were checked. */
export function scanLayerDirection(root: string): { checked: number; findings: string[] } {
  const findings: string[] = [];
  let checked = 0;
  for (const file of treeFiles(root, `${SRC}/**/*.{ts,tsx}`)) {
    if (!isLowerLayer(file)) continue;
    checked++;
    findings.push(...checkLayerDirection(readFileSync(resolve(root, file), "utf8"), file));
  }
  return { checked, findings };
}

/** The gate as `bun run lint` runs it: prints its findings, returns its exit code. */
export function lintGate(root: string): number {
  const { checked, findings } = scanLayerDirection(root);
  if (checked === 0) {
    // A glob that matches nothing would pass forever.
    console.error(`layer-direction: no files under ${LOWER.join(", ")}; the gate checked nothing`);
    return 1;
  }
  if (findings.length) {
    console.error(findings.join("\n"));
    return 1;
  }
  console.log(`layer-direction: ${checked} lower-layer files import no components`);
  return 0;
}

if (import.meta.main) process.exit(lintGate(resolve(process.argv[2] ?? ".")));
