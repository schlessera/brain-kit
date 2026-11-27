// ui-react's lower layers never import its components (#1380). `stores/`,
// `lib/`, `connection.ts` and the `ws-client/` parts it composes (#1362) are
// what components are built on; an import the
// other way makes a store or a helper load React views, and makes a component
// move break code that has nothing to do with rendering.
//
// Core's library code never imports its CLI (#4823): `lib/`, `providers/`,
// `queries/` and `config/` are what the CLI, the MCP server and the published
// entry points are built on, and an import of `cli/` from them pulls the CLI
// layer into every one of those.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

interface LayerRule {
  /** Names the rule in the gate's report. */
  name: string;
  /** The package source the rule scans. */
  src: string;
  /** Directory prefixes (ending in `/`) and single files of the lower layer. */
  lower: string[];
  /** The directory the lower layer must not import. */
  upper: string;
  /** What a finding tells the author. */
  message: string;
}

const UI = "packages/ui-react/src";
const CORE = "packages/core/src";
const RULES: LayerRule[] = [
  {
    name: "ui-react lower-layer files import no components",
    src: UI,
    lower: [`${UI}/stores/`, `${UI}/lib/`, `${UI}/connection.ts`, `${UI}/ws-client/`],
    upper: `${UI}/components/`,
    message: "stores/, lib/, connection.ts and ws-client/ must not import components/; move the shared code into lib/",
  },
  {
    name: "core lower-layer files import nothing under cli/",
    src: CORE,
    lower: [`${CORE}/lib/`, `${CORE}/providers/`, `${CORE}/queries/`, `${CORE}/config/`],
    upper: `${CORE}/cli/`,
    message: "lib/, providers/, queries/ and config/ must not import cli/; move the shared code out of cli/",
  },
];

function ruleFor(file: string): LayerRule | undefined {
  const path = file.split(sep).join("/");
  return RULES.find((rule) => rule.lower.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix)));
}

/** True for a repo-relative path a rule applies to. */
export function isLowerLayer(file: string): boolean {
  return ruleFor(file) !== undefined;
}

/** Findings for one lower-layer file; `file` is repo-relative. */
export function checkLayerDirection(source: string, file: string): string[] {
  const rule = ruleFor(file);
  if (!rule) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const check = (literal: ts.Node) => {
    if (!ts.isStringLiteralLike(literal) || !literal.text.startsWith(".")) return;
    const target = relative(".", resolve(dirname(file), literal.text)).split(sep).join("/");
    if (!`${target}/`.startsWith(rule.upper)) return;
    const { line } = tree.getLineAndCharacterOfPosition(literal.getStart(tree));
    findings.push(`${file}:${line + 1}: ${literal.text} — ${rule.message}`);
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
  const report: string[] = [];
  for (const rule of RULES) {
    let checked = 0;
    for (const file of new Bun.Glob(`${rule.src}/**/*.{ts,tsx}`).scanSync(root)) {
      if (ruleFor(file) !== rule) continue;
      checked++;
      findings.push(...checkLayerDirection(readFileSync(resolve(root, file), "utf8"), file));
    }
    if (checked === 0) {
      // A glob that matches nothing would pass forever.
      console.error(`layer-direction: no files under ${rule.lower.join(", ")}; the gate checked nothing`);
      process.exit(1);
    }
    report.push(`${checked} ${rule.name}`);
  }
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exit(1);
  }
  console.log(`layer-direction: ${report.join("; ")}`);
}
