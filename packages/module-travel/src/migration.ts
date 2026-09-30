import ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import { configSchema } from "./module.js";

// These are canonical config keys, not runtime imports of another module.
const MODULE_PREFIX = "@schlessera/brain-module-";
const SPEAKING = `${MODULE_PREFIX}speaking`;
const TRAVEL = `${MODULE_PREFIX}travel`;

export interface MigrationPlan {
  source: string;
  changed: boolean;
}

function manual(reason: string): never {
  throw new Error(`${reason}. No changes made; move travelParty to the travel module manually, preserving its complete value.`);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

function object(node: ts.Expression, what: string): ts.ObjectLiteralExpression {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) manual(`${what} must be a literal object; dynamic construction is ambiguous`);
  return value;
}

function properties(node: ts.ObjectLiteralExpression): Map<string, ts.PropertyAssignment> {
  const result = new Map<string, ts.PropertyAssignment>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
      manual("Spreads, computed keys and shorthand properties in a migration target need manual review");
    }
    const name = property.name.text;
    if (result.has(name)) manual(`Ambiguous duplicate property ${JSON.stringify(name)}`);
    result.set(name, property);
  }
  return result;
}

/** Read data literals only. Never execute configuration or move dynamic logic. */
function literal(node: ts.Expression): unknown {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.operand)) return -Number(value.operand.text);
  if (ts.isArrayLiteralExpression(value)) return value.elements.map((item) => literal(item));
  if (ts.isObjectLiteralExpression(value)) {
    return Object.fromEntries([...properties(value)].map(([key, property]) => [key, literal(property.initializer)]));
  }
  return manual("travelParty must be literal data; a dynamic value needs manual migration");
}

interface Edit { start: number; end: number; text: string }

function commaAfter(source: string, position: number, end: number): { start: number; end: number } | null {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
  scanner.setText(source, position, end - position);
  return scanner.scan() === ts.SyntaxKind.CommaToken
    ? { start: scanner.getTokenPos(), end: scanner.getTextPos() }
    : null;
}

function removeProperty(
  source: string, file: ts.SourceFile, owner: ts.ObjectLiteralExpression, property: ts.PropertyAssignment,
): Edit[] {
  const following = commaAfter(source, property.end, owner.end - 1);
  if (following) return [{ start: property.getStart(file), end: following.end, text: "" }];
  const index = owner.properties.indexOf(property);
  const previous = index > 0 ? owner.properties[index - 1] : undefined;
  const separator = previous ? commaAfter(source, previous.end, property.getStart(file)) : null;
  return [
    ...(separator ? [{ start: separator.start, end: separator.end, text: "" }] : []),
    { start: property.getStart(file), end: property.end, text: "" },
  ];
}

function insertProperty(source: string, owner: ts.ObjectLiteralExpression, text: string): Edit {
  const last = owner.properties.at(-1);
  const separator = last && !commaAfter(source, last.end, owner.end - 1) ? "," : "";
  return { start: owner.end - 1, end: owner.end - 1, text: `${separator} ${text} ` };
}

/**
 * Move the one owned data field, preserving every byte outside the edits.
 * Ambiguous or dynamic targets are reported rather than re-serializing logic.
 * JSON uses the same AST checks, so duplicate keys cannot silently lose data.
 */
export function planTravelConfigMigration(source: string, format: "json" | "ts"): MigrationPlan {
  if (format === "json") JSON.parse(source);
  const prefix = format === "json" ? "export default " : "";
  const input = prefix + source;
  const diagnostics = ts.transpileModule(input, { reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) manual("Configuration syntax is invalid");
  const file = ts.createSourceFile("brain.config.ts", input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) manual("A direct default-exported config literal is required");
  let expression = unwrap(exports[0]!.expression);
  if (ts.isCallExpression(expression)) {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "defineConfig" ||
      expression.arguments.length !== 1) manual("Only a direct defineConfig literal is supported");
    expression = expression.arguments[0]!;
  }
  const root = properties(object(expression, "Config"));
  const moduleProperty = root.get("modules");
  if (!moduleProperty) return { source, changed: false };
  const moduleObject = object(moduleProperty.initializer, "modules");
  const modules = properties(moduleObject);
  const speaking = modules.get(SPEAKING);
  if (!speaking) return { source, changed: false };
  const speakingObject = object(speaking.initializer, "Speaking config");
  const legacy = properties(speakingObject).get("travelParty");
  if (!legacy) return { source, changed: false };
  const party = literal(legacy.initializer);
  configSchema.parse({ travelParty: party });
  const travel = modules.get(TRAVEL);
  const travelObject = travel ? object(travel.initializer, "Travel config") : null;
  const existing = travelObject ? properties(travelObject).get("travelParty") : undefined;
  if (existing && !isDeepStrictEqual(literal(existing.initializer), party)) {
    throw new Error("Conflicting speaking and travel travelParty values; no changes made. Review both complete values before choosing one.");
  }
  const edits = removeProperty(input, file, speakingObject, legacy);
  if (!existing) {
    const value = input.slice(legacy.initializer.getStart(file), legacy.initializer.end);
    edits.push(travelObject
      ? insertProperty(input, travelObject, `"travelParty": ${value}`)
      : insertProperty(input, moduleObject, `${JSON.stringify(TRAVEL)}: { "travelParty": ${value} }`));
  }
  let migrated = input;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    migrated = migrated.slice(0, edit.start) + edit.text + migrated.slice(edit.end);
  }
  const result = migrated.slice(prefix.length);
  if (format === "json") JSON.parse(result);
  else if ((ts.transpileModule(result, { reportDiagnostics: true }).diagnostics ?? [])
    .some((d) => d.category === ts.DiagnosticCategory.Error)) manual("The migration could not preserve valid syntax");
  return { source: result, changed: result !== source };
}
