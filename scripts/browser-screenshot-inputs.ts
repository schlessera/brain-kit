/** Vitest's pinned default reference-image ownership over immutable tracked inputs. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lockedPackageAsset } from "./locked-browser-assets";
import type { InputClosure } from "./browser-input-closure";
import type { Spec } from "./proof-inputs";

// Installed @vitest/browser 4.1.11, resolveOptions/defaultOptions: the default
// resolver joins the test directory, __screenshots__, test basename and a
// sanitized image basename. Custom resolvers/directories are unsupported.
const frameworkHash = "0453902c16246ee96fd57727fe438c9a8383d49f7b908f242501aa8faf193455";
const pathOptions = new Set(["resolveScreenshotPath", "screenshotDirectory"]);
const ordinaryOptions = new Set(["comparatorName", "comparatorOptions", "screenshotOptions", "timeout", "strict"]);
const key = (node: ts.PropertyName) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;

/** This is called on a Git materialization, never current dist or untracked files. */
export function includeBrowserScreenshots(root: string, closure: InputClosure, selected: readonly Spec[], tracked: ReadonlySet<string>): InputClosure {
  let calls = 0;
  for (const file of closure.files.filter(file => /\.[cm]?[jt]sx?$/.test(file))) {
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const constants = new Map<string, ts.VariableDeclaration>();
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) constants.set(declaration.name.text, declaration);
    const literal = (node: ts.Expression, top: boolean, seen = new Set<string>()): boolean => {
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, top, seen);
      if (ts.isIdentifier(node)) {
        const declaration = constants.get(node.text);
        if (!declaration?.initializer || seen.has(node.text)) return false;
        let escaped = false;
        const references = (value: ts.Node) => {
          if (ts.isIdentifier(value) && value.text === node.text && value !== declaration.name &&
            !(ts.isCallExpression(value.parent) && value.parent.arguments[1] === value && ts.isPropertyAccessExpression(value.parent.expression) && value.parent.expression.name.text === "toMatchScreenshot")) escaped = true;
          ts.forEachChild(value, references);
        };
        references(source);
        return !escaped && literal(declaration.initializer, top, new Set([...seen, node.text]));
      }
      if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => ts.isPropertyAssignment(property) &&
        key(property.name) !== undefined && !pathOptions.has(key(property.name)!) && (!top || ordinaryOptions.has(key(property.name)!)) && literal(property.initializer, false, seen));
      if (top) return false;
      if (ts.isArrayLiteralExpression(node)) return node.elements.every(value => !ts.isSpreadElement(value) && literal(value, false, seen));
      return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
    };
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isPropertyAssignment(node) && pathOptions.has(key(node.name) ?? "") ||
        ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && pathOptions.has(node.argumentExpression.text))
        throw new Error(`Unsupported screenshot path override: ${file}`);
      if (ts.isPropertyAccessExpression(node) && node.name.text === "toMatchScreenshot") {
        const call = node.parent;
        if (!ts.isCallExpression(call) || call.expression !== node || call.arguments.length > 2 || call.arguments[1] && !literal(call.arguments[1], true))
          throw new Error(`Unsupported screenshot matcher options or alias: ${file}`);
        calls++;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (!calls) return closure;
  const framework = lockedPackageAsset(root, "@vitest/browser", "dist/index.js");
  if (!framework || framework.version !== "4.1.11" || framework.sha256 !== frameworkHash) throw new Error("Unsupported installed screenshot resolver");
  const directories = new Set(closure.directories), files = new Set(closure.files);
  for (const spec of selected) {
    const directory = `${dirname(spec.file)}/__screenshots__/${basename(spec.file)}`;
    if (tracked.has(directory) || tracked.has(`${dirname(spec.file)}/__screenshots__`)) throw new Error("Screenshot directory is a tracked non-directory input");
    for (const path of tracked) if (path.startsWith(directory + "/")) {
      files.add(path); directories.add(directory);
    }
  }
  // Git path/mode/blob validation remains mandatory in the inclusion caller;
  // symlinks and missing eligible files can never become passing ownership.
  return { ...closure, files: [...files].sort(), directories: [...directories].sort(), external: [...(closure.external ?? []), framework] };
}
