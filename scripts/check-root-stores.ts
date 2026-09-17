// Store hooks select from React context. Their attached statics address only
// the default application and must never be used by library internals (D15).
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

export function checkRootStores(source: string, file = "source.tsx"): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hooks = new Set<string>();
  const namespaces = new Set<string>();
  const isHook = (name: string) => /^use\w+Store$/.test(name);
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const path = node.moduleSpecifier.text;
    if (!/(?:-store(?:\.js)?$|brain-ui-react(?:\/|$)|(?:^|\/)index(?:\.js)?$)/.test(path)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (isHook((specifier.propertyName ?? specifier.name).text)) hooks.add(specifier.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  const findings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) return;
    const named = ts.isIdentifier(node) && hooks.has(node.text)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
    const namespace = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)
      && (ts.isPropertyAccessExpression(node) ? isHook(node.name.text)
        : ts.isStringLiteral(node.argumentExpression) && isHook(node.argumentExpression.text));
    if (named || namespace) {
      // Even aliasing/destructuring the hook is rejected: it can hide a later
      // static access. Call the selector hook directly or use an explicit root.
      if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        findings.push(`${file}:${line + 1}: store hooks are selectors; use root.stores for imperative access`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const findings: string[] = [];
  for (const file of new Bun.Glob("packages/ui-react/src/**/*.{ts,tsx}").scanSync(root)) {
    findings.push(...checkRootStores(readFileSync(resolve(root, file), "utf8"), relative(root, resolve(root, file))));
  }
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exit(1);
  }
  console.log("root-stores: internal store access is root-bound");
}
