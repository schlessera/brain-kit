// Refuses a hand-written path-containment check in package source (#3423).
//
// Why: "is this path the root or below it?" has one implementation,
// `isWithin(root, path, rule)` in `@schlessera/brain-common/internal/safe-path`
// (#2506). Its callers disagree on equality, the separator and a root that
// already ends in one, so those are named parameters there rather than choices
// each copy makes silently. An inline `path.startsWith(`${root}/`)` makes the
// same choices without naming them, and is the copy a later fix misses.
//
// The refused shapes, over `packages/*/src`: a `startsWith` call whose
// argument is
//
//   - a template that is one interpolation followed by `/` or by `${sep}`
//     (`${root}/`, `${root}${sep}`), or
//   - a concatenation ending in `"/"`, `sep` or `path.sep` (`root + "/"`,
//     `root + sep`).
//
// A prefix that is not a filesystem or brain-relative path (a URL hash route,
// a cache key, a package specifier) may keep its inline check. Each such file
// is in NOT_A_PATH with its reason and the exact number of sites it holds, so
// a new path check added to an allowlisted file still fails.
//
// Detection is AST-based (the TypeScript compiler API), so comments and string
// literals mentioning the shapes do not trip it.

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import ts from "typescript";

/** Package source whose inline prefixes are not paths, how many, and why. */
export const NOT_A_PATH: ReadonlyArray<{ file: string; count: number; reason: string }> = [
  {
    file: "packages/ui-react/src/hooks/use-hash-routes.ts",
    count: 1,
    reason: "a `#/view/...` URL hash route, matched in the browser",
  },
  {
    file: "packages/ui-react/src/lib/recordings.ts",
    count: 5,
    reason: "`<partition>/<id>` recording cache keys in the browser, not paths",
  },
  {
    file: "packages/core/src/lib/module-renderers.ts",
    count: 1,
    reason: "an npm export specifier (`<package>/<subpath>`), not a path",
  },
  {
    file: "packages/ui-server/src/db/reference-grants.ts",
    count: 1,
    reason: "a canonical repository URL prefix at a `/` segment boundary, not a filesystem path",
  },
];

const SCANNED = "packages/*/src/**/*.{ts,tsx,js,mjs,cjs}";

export interface Finding {
  file: string;
  line: number;
  column: number;
  text: string;
}

const isSep = (node: ts.Expression) =>
  (ts.isIdentifier(node) && node.text === "sep") ||
  (ts.isPropertyAccessExpression(node) && node.name.text === "sep");

/** Strip parentheses and `as`/`satisfies`/`!` wrappers from an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
    else return node;
  }
}

/** Whether a `startsWith` argument is a root followed by a separator. */
export function isRootPlusSeparator(arg: ts.Expression): boolean {
  arg = unwrap(arg);
  if (ts.isTemplateExpression(arg)) {
    if (arg.head.text !== "") return false;
    const spans = arg.templateSpans;
    if (spans.length === 1) return spans[0].literal.text === "/";
    return spans.length === 2 && spans[0].literal.text === "" && isSep(unwrap(spans[1].expression)) &&
      spans[1].literal.text === "";
  }
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const right = unwrap(arg.right);
    const left = unwrap(arg.left);
    if (ts.isStringLiteralLike(left)) return false;
    return (ts.isStringLiteralLike(right) && right.text === "/") || isSep(right);
  }
  return false;
}

export function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "startsWith" && node.arguments.length > 0 &&
      isRootPlusSeparator(node.arguments[0])) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({ file, line: line + 1, column: character + 1, text: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export interface Report {
  /** Sites outside any allowlisted file. */
  findings: Finding[];
  /** Allowlisted files whose site count differs from the recorded one. */
  miscounted: Array<{ file: string; expected: number; actual: number }>;
}

export function scanTree(root: string): Report {
  const files = [...new Bun.Glob(SCANNED).scanSync({ cwd: root })]
    .filter((file) => !/(^|\/)(node_modules|dist)\//.test(file))
    .sort();
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  for (const file of files) {
    const found = scanSource(file, readFileSync(resolve(root, file), "utf8"));
    if (NOT_A_PATH.some((entry) => entry.file === file)) counts.set(file, found.length);
    else findings.push(...found);
  }
  const miscounted = NOT_A_PATH
    .map((entry) => ({ file: entry.file, expected: entry.count, actual: counts.get(entry.file) ?? 0 }))
    .filter((entry) => entry.expected !== entry.actual);
  return { findings, miscounted };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { findings, miscounted } = scanTree(root);
  if (findings.length === 0 && miscounted.length === 0) {
    console.log("No package source checks path containment with an inline startsWith; every check goes through isWithin.");
    process.exit(0);
  }
  if (findings.length > 0) {
    console.error("Inline path-containment checks (`startsWith(`${root}/`)`, `startsWith(root + sep)`):");
    for (const f of findings) {
      console.error(`  ${relative(root, resolve(root, f.file))}:${f.line}:${f.column}: ${f.text}`);
    }
  }
  for (const m of miscounted) {
    console.error(`  ${m.file}: NOT_A_PATH records ${m.expected} non-path prefix site(s), found ${m.actual}; ` +
      "update the count only if every site is still not a path");
  }
  console.error(
    `\n${findings.length + miscounted.length} finding(s). Ask isWithin(root, path, rule) from ` +
      "@schlessera/brain-common/internal/safe-path; a prefix that is not a path goes in NOT_A_PATH " +
      "(scripts/check-inline-containment.ts) with its reason.",
  );
  process.exit(1);
}
