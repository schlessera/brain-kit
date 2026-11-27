/**
 * The front end core's two config editors share (#4769): the module-flag
 * editor (`module-config-edit.ts`) and the media-policy editor
 * (`media-config-edit.ts`). core edits `brain.config.ts` and
 * `brain.config.json` as source text and never evaluates them. Before an
 * edit, the file must be a direct default export, optionally wrapped in one
 * `defineConfig(...)` call, of an object literal; an object it reads must have
 * only plain `key: value` properties with unique names. JSON is parsed as
 * TypeScript behind an `export default ` prefix.
 *
 * Every check refuses through the caller's `refuse`, so each editor keeps its
 * own refusal type and wording. The travel module carries its own copy of
 * these checks (`packages/module-travel/src/migration.ts`), because modules
 * cannot import core's internals; `tests/config-literal-parity.test.ts` holds
 * it to this one.
 */
import ts from "typescript";

/** Why a config is not a literal an editor may touch. `what` names the object being read. */
export type ConfigLiteralRefusal =
  | { reason: "invalid-json"; error: unknown }
  | { reason: "syntax" }
  | { reason: "no-default-literal" }
  | { reason: "not-define-config" }
  | { reason: "not-object"; what: string }
  | { reason: "not-assignment"; what: string }
  | { reason: "duplicate"; what: string; key: string };

/** An editor's refusal: it throws and never returns. */
export type RefuseConfigLiteral = (refusal: ConfigLiteralRefusal) => never;

export interface ConfigLiteral {
  file: ts.SourceFile;
  /** The text the file was parsed from: `prefix` followed by the source. */
  input: string;
  /** `"export default "` for JSON, empty for TypeScript; slice it off an edited `input`. */
  prefix: string;
  /** The exported object literal. */
  root: ts.ObjectLiteralExpression;
}

/** The expression under any parentheses, `as`, `satisfies` and non-null wrappers. */
export function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  return node;
}

/** `node` unwrapped, when it is an object literal. */
export function literalObject(node: ts.Expression, what: string, refuse: RefuseConfigLiteral): ts.ObjectLiteralExpression {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) refuse({ reason: "not-object", what });
  return value;
}

/** The properties of `node` by name, when every one is a plain assignment and no name repeats. */
export function literalProperties(node: ts.ObjectLiteralExpression, what: string, refuse: RefuseConfigLiteral): Map<string, ts.PropertyAssignment> {
  const found = new Map<string, ts.PropertyAssignment>();
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) {
      refuse({ reason: "not-assignment", what });
    }
    if (found.has(p.name.text)) refuse({ reason: "duplicate", what, key: p.name.text });
    found.set(p.name.text, p);
  }
  return found;
}

/** Parse `source` and find its exported object literal, or refuse. */
export function parseConfigLiteral(source: string, format: "ts" | "json", refuse: RefuseConfigLiteral): ConfigLiteral {
  if (format === "json") {
    try {
      JSON.parse(source);
    } catch (error) {
      refuse({ reason: "invalid-json", error });
    }
  }
  const prefix = format === "json" ? "export default " : "";
  const input = prefix + source;
  const file = ts.createSourceFile("brain.config.ts", input, ts.ScriptTarget.Latest, true);
  const diagnostics = ts.transpileModule(input, { reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) refuse({ reason: "syntax" });
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) refuse({ reason: "no-default-literal" });
  let expression = unwrap(exports[0]!.expression);
  if (ts.isCallExpression(expression)) {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "defineConfig" || expression.arguments.length !== 1) {
      refuse({ reason: "not-define-config" });
    }
    expression = expression.arguments[0]!;
  }
  return { file, input, prefix, root: literalObject(expression, "the config", refuse) };
}
