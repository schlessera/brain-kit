import ts from "typescript";

function refuse(reason: string): never {
  throw new Error(`${reason}; no changes made. Set the module's enabled boolean manually in a literal config entry, then retry.`);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

function object(node: ts.Expression): ts.ObjectLiteralExpression {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) refuse("The module config uses dynamic construction");
  return value;
}

function properties(node: ts.ObjectLiteralExpression): Map<string, ts.PropertyAssignment> {
  const found = new Map<string, ts.PropertyAssignment>();
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) {
      refuse("Spreads, computed keys or shorthand in the toggle target require explicit review");
    }
    if (found.has(p.name.text)) refuse(`Duplicate config property ${JSON.stringify(p.name.text)}`);
    found.set(p.name.text, p);
  }
  return found;
}

/** Edit only the reserved flag; never serialize the brain's executable logic. */
export function planModuleFlag(source: string, format: "ts" | "json", key: string, enabled: boolean): string {
  if (format === "json") JSON.parse(source);
  const prefix = format === "json" ? "export default " : "";
  const input = prefix + source;
  const file = ts.createSourceFile("brain.config.ts", input, ts.ScriptTarget.Latest, true);
  const diagnostics = ts.transpileModule(input, { reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) refuse("Config syntax is invalid");
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) refuse("A direct default-exported config literal is required");
  let expression = unwrap(exports[0]!.expression);
  if (ts.isCallExpression(expression)) {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "defineConfig" || expression.arguments.length !== 1) {
      refuse("Only a direct defineConfig literal is supported");
    }
    expression = expression.arguments[0]!;
  }
  const modules = properties(object(expression)).get("modules");
  if (!modules) refuse("No modules literal exists");
  const entry = properties(object(modules.initializer)).get(key);
  if (!entry) refuse("The module has no literal config entry");
  const block = object(entry.initializer);
  const flag = properties(block).get("enabled");
  if (flag) {
    const value = unwrap(flag.initializer);
    if (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword) refuse("enabled is not a literal boolean");
    const replacement = String(enabled);
    return (input.slice(0, value.getStart(file)) + replacement + input.slice(value.end)).slice(prefix.length);
  }
  if (enabled) return source; // omission already means active
  const last = block.properties.at(-1);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
  scanner.setText(input, last?.end ?? block.end - 1, block.end - 1 - (last?.end ?? block.end - 1));
  const separator = last && scanner.scan() !== ts.SyntaxKind.CommaToken ? "," : "";
  const at = block.end - 1;
  return (input.slice(0, at) + `${separator} "enabled": false ` + input.slice(at)).slice(prefix.length);
}
