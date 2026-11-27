import ts from "typescript";

import { literalObject, literalProperties, parseConfigLiteral, unwrap, type RefuseConfigLiteral } from "./config-literal.js";

function refuse(reason: string): never {
  throw new Error(`${reason}; no changes made. Set the module's enabled boolean manually in a literal config entry, then retry.`);
}

/** The shared front end's refusals in this editor's words. Invalid JSON stays the parser's own SyntaxError. */
const refuseLiteral: RefuseConfigLiteral = (refusal) => {
  switch (refusal.reason) {
    case "invalid-json": throw refusal.error;
    case "syntax": return refuse("Config syntax is invalid");
    case "no-default-literal": return refuse("A direct default-exported config literal is required");
    case "not-define-config": return refuse("Only a direct defineConfig literal is supported");
    case "not-object": return refuse("The module config uses dynamic construction");
    case "not-assignment": return refuse("Spreads, computed keys or shorthand in the toggle target require explicit review");
    case "duplicate": return refuse(`Duplicate config property ${JSON.stringify(refusal.key)}`);
  }
};

const object = (node: ts.Expression) => literalObject(node, "the module config", refuseLiteral);
const properties = (node: ts.ObjectLiteralExpression) => literalProperties(node, "the module config", refuseLiteral);

/** Edit only the reserved flag; never serialize the brain's executable logic. */
export function planModuleFlag(source: string, format: "ts" | "json", key: string, enabled: boolean): string {
  const { file, input, prefix, root } = parseConfigLiteral(source, format, refuseLiteral);
  const modules = properties(root).get("modules");
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
