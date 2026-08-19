// Refuses type assertions on module-contract config values in module sources.
//
// Why: `ModuleManifest<C>` validates the user's config block to `C`, and the
// module contract threads that type through `CommandContext<C>` and
// `HygieneContext<C>` (see packages/core/src/lib/module-types.ts). A module
// authored with `defineModule` + a configSchema gets `ctx.config` fully typed,
// so `ctx.config as MyConfig` is never necessary — and worse, it papers over a
// regression: if the generic is ever dropped again, casts keep every
// first-party module compiling and the loss lands silently on third-party
// authors. The compile test that pins the generic is
// packages/core/tests/module-author-typing.test.ts; this lint keeps the
// first-party modules honest so that test stays the only line of defense that
// matters.
//
// Detection is AST-based (the TypeScript compiler API, same as
// check-env-access.ts): a comment or a string literal mentioning
// `ctx.config as X` does not trip it, and an assertion split across lines by a
// formatter is still seen.
//
// Deliberately narrow: only assertions applied to the CONTEXT CONFIG VALUE
// (`ctx.config as X`, `<X>ctx.config`, and parenthesized/`??`-chained/
// non-null-wrapped variants like `(ctx.config ?? {}) as X`) are banned. `as`
// in general stays available — banning it wholesale would drown the signal in
// noise the modules cannot satisfy. `as const` is exempt (it narrows, it does
// not paper over `unknown`), and `satisfies` is out of scope (it never
// changes the type).

import { readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

interface Finding {
  file: string;
  line: number;
  column: number;
  text: string;
}

/**
 * True when the expression is (or trivially wraps) a `config` property read
 * off a module-contract context — `ctx.config` / `context.config`, including
 * `ctx["config"]`, parens, non-null assertions, and the left side of a
 * `??` / `||` default chain.
 */
function isContextConfigValue(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    return isContextConfigValue(expr.expression);
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isContextConfigValue(expr.left);
  }
  const receiverIsContext = (receiver: ts.Expression) =>
    ts.isIdentifier(receiver) && (receiver.text === "ctx" || receiver.text === "context");
  if (ts.isPropertyAccessExpression(expr)) {
    return receiverIsContext(expr.expression) && expr.name.text === "config";
  }
  if (ts.isElementAccessExpression(expr)) {
    return (
      receiverIsContext(expr.expression) &&
      ts.isStringLiteralLike(expr.argumentExpression) &&
      expr.argumentExpression.text === "config"
    );
  }
  return false;
}

export function scanText(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: Finding[] = [];

  const record = (node: ts.Node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({
      file,
      line: line + 1,
      column: character + 1,
      // Collapse a formatter's line break so the report stays one line each.
      text: node.getText(source).replace(/\s+/g, " "),
    });
  };

  const visit = (node: ts.Node) => {
    // `expr as T` — except `as const`, which narrows rather than asserts over
    // the contract type.
    if (ts.isAsExpression(node) && !ts.isConstTypeReference(node.type)) {
      if (isContextConfigValue(node.expression)) record(node);
    }
    // The angle-bracket spelling, `<T>expr` (unavailable in .tsx, where it
    // parses as JSX — the TSX script kind above handles that).
    if (ts.isTypeAssertionExpression(node) && isContextConfigValue(node.expression)) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function scanModules(root: string): Finding[] {
  const glob = new Bun.Glob("packages/module-*/src/**/*.{ts,tsx}");
  const findings: Finding[] = [];
  for (const relative of [...glob.scanSync({ cwd: root })].sort()) {
    findings.push(...scanText(relative, readFileSync(resolve(root, relative), "utf-8")));
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = scanModules(root);
  if (findings.length === 0) {
    console.log("No config casts in module sources.");
    process.exit(0);
  }

  console.error("Type assertions on module-contract config values found:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}:${finding.column}: ${finding.text}`);
  }
  console.error(
    "\nThe module contract already delivers this type: defineModule threads the " +
      "configSchema's parsed type through CommandContext<C> and HygieneContext<C>, " +
      "so `ctx.config` is typed with no cast. Type the command as " +
      "`CommandModule<MyConfig>` (or the check as `HygieneContext<MyConfig>`) " +
      "and drop the assertion."
  );
  process.exit(1);
}
