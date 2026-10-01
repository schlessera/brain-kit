import ts from "typescript";
import { isRecord } from "./module-settings-source.js";

export function equalSettings(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equalSettings(v, b[i]));
  if (isRecord(a) && isRecord(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && equalSettings(a[k], b[k]));
  return false;
}

/** Keep unchanged JSON subtrees verbatim, including unsupported values and number spelling. */
export function rewriteSettingsJson(source: string | null, next: Record<string, unknown>): string {
  if (source === null) return JSON.stringify(next, null, 2) + "\n";
  const previous: unknown = JSON.parse(source);
  if (equalSettings(previous, next)) return source;
  const prefix = "export default ";
  const file = ts.createSourceFile("settings.ts", prefix + source, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  if (!statement || !ts.isExportAssignment(statement)) throw new Error("Invalid settings object");
  const raw = (node: ts.Node): string => (prefix + source).slice(node.getStart(file), node.end);
  function rewrite(node: ts.Expression, before: unknown, after: unknown): string {
    if (equalSettings(before, after)) return raw(node);
    if (ts.isObjectLiteralExpression(node) && isRecord(before) && isRecord(after)) {
      const nodes = new Map<string, ts.Expression>();
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.name)) throw new Error("Settings must use JSON property names");
        if (nodes.has(prop.name.text)) throw new Error(`Duplicate settings key ${prop.name.text}`);
        nodes.set(prop.name.text, prop.initializer);
      }
      const keys = [...Object.keys(before).filter((k) => Object.hasOwn(after, k)), ...Object.keys(after).filter((k) => !Object.hasOwn(before, k))];
      return "{\n" + keys.map((key) => `  ${JSON.stringify(key)}: ${nodes.has(key) ? rewrite(nodes.get(key)!, before[key], after[key]) : JSON.stringify(after[key])}`).join(",\n") + "\n}";
    }
    if (ts.isArrayLiteralExpression(node) && Array.isArray(before) && Array.isArray(after)) {
      return "[" + after.map((value, i) => {
        // Reordering a record must carry its untouched source subtree with it.
        const match = before.findIndex((old) => equalSettings(old, value));
        const at = match >= 0 ? match : i;
        const oldNode = node.elements[at];
        return oldNode ? rewrite(oldNode, before[at], value) : JSON.stringify(value);
      }).join(", ") + "]";
    }
    return JSON.stringify(after);
  }
  return rewrite(statement.expression, previous, next) + (source.endsWith("\n") ? "\n" : "");
}
