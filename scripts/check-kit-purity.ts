// Keeps @schlessera/brain-ui-kit 100% prop-driven (D13).
//
// Why a gate rather than a convention: the four pains the state architecture
// set out to fix do not share one cause, and the one that discipline cannot
// fix is *invisible dependencies* — a presentational component that reaches
// for a module singleton looks identical, from its call site, to one that does
// not. ui-react's eleven zustand stores are plain module singletons with no
// provider anywhere, so a component that imports one cannot be rendered in a
// story, a test, or a second embedder without mutating global state. The kit
// exists so that class of component has somewhere to not be.
//
// Five rules, over packages/ui-kit/src/** only. Every one of them describes
// something the kit takes as a PROP instead:
//
//   1. No zustand. State arrives as props; ui-react owns the stores.
//   2. No fetch. Data arrives as props; the container does the I/O.
//   3. No `uiConfig`. Configuration arrives as props.
//   4. No localStorage / sessionStorage. Persistence is the embedder's.
//   5. No window.location. Navigation arrives as a callback.
//
// Detection is AST-based (the TypeScript compiler API), so a doc comment
// saying "no fetch, no stores" does not trip the gate it describes — which a
// grep for the same strings would, on this file's own header included.

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import ts from "typescript";

const KIT_SOURCES = "packages/ui-kit/src/**/*.{ts,tsx}";

/** Globals the kit may not touch, and what it takes instead. */
const BANNED_GLOBALS: Record<string, { rule: number; instead: string }> = {
  fetch: { rule: 2, instead: "take the data as a prop; the container does the I/O" },
  uiConfig: { rule: 3, instead: "take the configuration as a prop" },
  localStorage: { rule: 4, instead: "persistence belongs to the embedder, not the kit" },
  sessionStorage: { rule: 5, instead: "persistence belongs to the embedder, not the kit" },
};

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: number;
  symbol: string;
  message: string;
}

/** True for `window.<name>` / `globalThis.<name>` / `self.<name>`. */
function hostQualified(node: ts.PropertyAccessExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    ["window", "globalThis", "self"].includes(node.expression.text)
  );
}

/**
 * True when this identifier is a *reference* to a global, not a name being
 * declared or a property being read off something unrelated. `const fetch =`
 * and `{ fetch: … }` are not the thing we are banning; `fetch(…)` is.
 */
function isGlobalReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  // `obj.fetch` — a method on something of our own, unless the object is the
  // host, which the caller handles separately.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  // Declarations, parameters, property names, imports, labels.
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return parent.name !== node;
  }
  return true;
}

export function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: Finding[] = [];
  const record = (node: ts.Node, rule: number, symbol: string, message: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: line + 1, column: character + 1, rule, symbol, message });
  };

  const visit = (node: ts.Node) => {
    // Rule 1 — any import of zustand, including its subpaths and middleware.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^zustand(\/|$)/.test(node.moduleSpecifier.text)
    ) {
      record(
        node,
        1,
        node.moduleSpecifier.text,
        "the kit holds no store — take the state as a prop and let " +
          "@schlessera/brain-ui-react own the zustand store"
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      /^zustand(\/|$)/.test(node.arguments[0].text)
    ) {
      record(node, 1, node.arguments[0].text, "dynamic import of zustand — see rule 1");
    }

    // Rules 2-5 — banned globals, bare or host-qualified.
    if (ts.isIdentifier(node)) {
      const banned = BANNED_GLOBALS[node.text];
      if (banned && isGlobalReference(node)) {
        record(node, banned.rule, node.text, `\`${node.text}\` — ${banned.instead}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && hostQualified(node)) {
      const banned = BANNED_GLOBALS[node.name.text];
      if (banned) {
        record(
          node,
          banned.rule,
          `${(node.expression as ts.Identifier).text}.${node.name.text}`,
          `\`${node.name.text}\` — ${banned.instead}`
        );
      }
      if (node.name.text === "location") {
        record(
          node,
          6,
          `${(node.expression as ts.Identifier).text}.location`,
          "`window.location` — navigation is a callback prop, not something " +
            "the kit performs"
        );
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function scanKit(root: string): Finding[] {
  const glob = new Bun.Glob(KIT_SOURCES);
  const files = [...glob.scanSync({ cwd: root })].sort();
  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...scanSource(file, readFileSync(resolve(root, file), "utf8")));
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = scanKit(root);
  if (findings.length === 0) {
    console.log("packages/ui-kit/src is prop-driven: no store, no I/O, no ambient globals.");
    process.exit(0);
  }

  console.error("ui-kit purity violations found:");
  for (const f of findings) {
    console.error(
      `  ${relative(root, resolve(root, f.file))}:${f.line}:${f.column}: ` +
        `[rule ${f.rule}] ${f.symbol}: ${f.message}`
    );
  }
  console.error(
    `\n${findings.length} finding(s). @schlessera/brain-ui-kit is 100% prop-driven ` +
      "(D13): props in, callbacks out. Anything ambient belongs in " +
      "@schlessera/brain-ui-react, which composes the kit."
  );
  process.exit(1);
}
