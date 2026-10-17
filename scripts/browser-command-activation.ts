/** Conservative registration audit. This prototype never removes execution inputs. */
import {resolveRuntimeModule} from "./runtime-module-resolution";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import type { Spec } from "./proof-inputs";

export interface CommandCandidate { owner: string; name: string; }
export interface CommandActivationAudit {
  candidates: (CommandCandidate & { projects: string[] })[];
  files: string[];
  roots: string[];
  unresolved: string[];
  /** Registration is necessary but does not prove module initialization safe. */
  executionExcluded: false;
}
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
  customConditions: ["bun"], resolveJsonModule: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.ReactJSX };
const propertyName = (node: ts.PropertyName) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;

/** Audit the actual config, every selected spec, and all literal setup/global hooks.
 * Unknown registrations, invocation aliases, loaders and workspace imports stay fresh.
 * Imported top-level effects are deliberately still interpreted by input closure.
 */
export function auditCommandActivation(root: string, config: string, selected: readonly Spec[], candidates: readonly CommandCandidate[]): CommandActivationAudit {
  root = realpathSync(root);
  const files = new Set<string>(), unresolved = new Set<string>(), visited = new Set<string>();
  const inactive: CommandActivationAudit["candidates"] = [];
  const projects = new Set(selected.map(spec => spec.project));
  if (!selected.length || projects.size === 0 || new Set(candidates.map(candidate => candidate.name)).size !== candidates.length)
    unresolved.add("Missing or ambiguous command activation inventory");
  const sourceFile = (file: string) => {
    const absolute = resolve(root, file), normalized = relative(root, absolute).replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("../") || isAbsolute(normalized) || !existsSync(absolute) || realpathSync(absolute) !== absolute)
      throw new Error(`Unsupported activation source: ${file}`);
    files.add(normalized);
    const source = ts.createSourceFile(normalized, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    if (/\.[cm]?[jt]sx?$/.test(normalized) && (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
      throw new Error(`Invalid activation source: ${file}`);
    return source;
  };
  const configAst = sourceFile(config);
  for (const candidate of candidates) {
    const owner = sourceFile(candidate.owner);
    const typeImports = owner.statements.filter(ts.isImportDeclaration).filter(statement =>
      ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "vitest/node")
      .flatMap(statement => statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.filter(element => (element.propertyName?.text ?? element.name.text) === "BrowserCommand").map(element => element.name.text) : []);
    const definitions = owner.statements.filter(ts.isVariableStatement).filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .flatMap(statement => [...statement.declarationList.declarations]).filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === candidate.name &&
        declaration.initializer && ts.isArrowFunction(declaration.initializer) && declaration.type && ts.isTypeReferenceNode(declaration.type) &&
        ts.isIdentifier(declaration.type.typeName) && typeImports.includes(declaration.type.typeName.text));
    if (definitions.length !== 1) { unresolved.add(`Unsupported BrowserCommand definition: ${candidate.owner}`); continue; }
    let imported = 0, unsafe = false;
    const callback = definitions[0]!;
    const ownerReferences = (node: ts.Node) => {
      if (node === callback.initializer) return;
      if (ts.isIdentifier(node) && node.text === candidate.name && node !== callback.name &&
          !((ts.isPropertySignature(node.parent) || ts.isMethodSignature(node.parent)) && node.parent.name === node)) unsafe = true;
      ts.forEachChild(node, ownerReferences);
    };
    ownerReferences(owner);
    const registrations = new Set<string>();
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === candidate.name) {
        const parent = node.parent;
        if (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName) {
          const declaration = parent.parent.parent.parent;
          if (!ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier) ||
              relative(root, resolve(dirname(join(root, config)), declaration.moduleSpecifier.text)).replaceAll("\\", "/") !== candidate.owner) unsafe = true;
          else imported++;
        } else if (ts.isShorthandPropertyAssignment(parent) && parent.name === node && ts.isObjectLiteralExpression(parent.parent)) {
          const commands = parent.parent.parent;
          if (!ts.isPropertyAssignment(commands) || propertyName(commands.name) !== "commands" ||
              parent.parent.properties.some(property => !ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property))) unsafe = true;
          let project: string | undefined;
          for (let ancestor: ts.Node | undefined = commands.parent; ancestor && ancestor !== configAst; ancestor = ancestor.parent) {
            if (!ts.isObjectLiteralExpression(ancestor)) continue;
            const name = ancestor.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === "name");
            if (name && ts.isPropertyAssignment(name)) {
              if (ts.isStringLiteral(name.initializer)) project = name.initializer.text;
              break;
            }
          }
          if (!project) unsafe = true; else registrations.add(project);
        } else unsafe = true;
      }
      ts.forEachChild(node, walk);
    };
    walk(configAst);
    if (unsafe || imported !== 1 || !registrations.size)
      unresolved.add(`Active or ambiguous command registration: ${candidate.name}`);
    else inactive.push({ ...candidate, projects: [...registrations].sort() });
  }
  // Inspect every selected test and all hooks, including inherited hooks. Do
  // not infer nonactivation from grep or only the browser category's filenames.
  const roots = new Set([config, ...selected.map(spec => spec.file)]);
  const hooks = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ["setupFiles", "globalSetup", "setupFile", "globalTeardown"].includes(propertyName(node.name) ?? "")) {
      const values = ts.isArrayLiteralExpression(node.initializer) ? [...node.initializer.elements] : [node.initializer];
      for (const value of values) {
        if (!ts.isStringLiteral(value)) unresolved.add(`Computed activation hook: ${node.getText(configAst)}`);
        else roots.add(relative(root, resolve(dirname(join(root, config)), value.text)).replaceAll("\\", "/"));
      }
    }
    ts.forEachChild(node, hooks);
  };
  hooks(configAst);
  const configUnknowns = (node: ts.Node) => {
    if (ts.isSpreadAssignment(node) || ts.isComputedPropertyName(node)) unresolved.add("Unsupported computed/spread activation configuration");
    ts.forEachChild(node, configUnknowns);
  };
  configUnknowns(configAst);
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    let source: ts.SourceFile;
    try { source = sourceFile(file); } catch (error) { unresolved.add(String(error)); return; }
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const commands = new Set<string>();
    const moduleRequire = source.statements.filter(ts.isImportDeclaration).some(statement => ts.isStringLiteral(statement.moduleSpecifier) &&
      ["node:module", "module"].includes(statement.moduleSpecifier.text) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(binding => !binding.propertyName && binding.name.text === "createRequire"));
    const boundedRequireUse = (node: ts.Identifier) => {
      if (node.text !== "require" || !moduleRequire) return false;
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === node && parent.initializer?.getText(source) === "createRequire(import.meta.url)") return true;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || parent.name.text !== "resolve" || !ts.isCallExpression(parent.parent) || parent.parent.expression !== parent) return false;
      return parent.parent.arguments.length === 1 && ts.isStringLiteral(parent.parent.arguments[0]!) && parent.parent.arguments[0]!.text !== "vitest/browser";
    };
    const edge = (specifier: string, typeOnly: boolean) => {
      if (typeOnly || builtins.has(specifier) || specifier.startsWith("bun:")) return;
      // Styles/assets are bytes, not JavaScript command entrypoints. Their
      // producer ownership remains mandatory in the separate input closure.
      if (/\.(?:css|svg|png|jpe?g|woff2?|wasm)(?:\?.*)?$/.test(specifier)) return;
      if (file !== config && candidates.some(candidate => specifier.startsWith(".") && resolve(dirname(join(root, file)), specifier) === resolve(root, candidate.owner)))
        unresolved.add(`Selected execution imports command owner: ${file}`);
      const result = resolveRuntimeModule(specifier, join(root, file), options);
      if (result?.isExternalLibraryImport && !specifier.startsWith("@schlessera/")) return;
      const asset = specifier.startsWith(".") ? resolve(dirname(join(root, file)), specifier.split("?")[0]!) : "";
      const target = result?.resolvedFileName ?? (asset && existsSync(asset) ? asset : undefined);
      if (!target) { unresolved.add(`Unresolved activation import ${file}: ${specifier}`); return; }
      const normalized = relative(root, target).replaceAll("\\", "/");
      if (normalized.startsWith("node_modules/")) return;
      if (file !== config && candidates.some(candidate => resolve(root, candidate.owner) === target)) unresolved.add(`Selected execution imports command owner: ${file}`);
      visit(normalized);
    };
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "vitest/browser") {
      const bindings = statement.importClause?.namedBindings;
      if (statement.importClause?.name || bindings && ts.isNamespaceImport(bindings)) unresolved.add(`Aliased browser command namespace: ${file}`);
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
        if ((binding.propertyName?.text ?? binding.name.text) === "commands") commands.add(binding.name.text);
    }
    const bindings = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isAwaitExpression(node.initializer) &&
          ts.isCallExpression(node.initializer.expression) && node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.initializer.expression.arguments.length === 1 && ts.isStringLiteral(node.initializer.expression.arguments[0]!) &&
          node.initializer.expression.arguments[0]!.text === "vitest/browser") {
        if (!ts.isObjectBindingPattern(node.name)) unresolved.add(`Aliased dynamic browser namespace: ${file}`);
        else for (const binding of node.name.elements) {
          if (binding.dotDotDotToken || binding.propertyName && !ts.isIdentifier(binding.propertyName) || !ts.isIdentifier(binding.name)) unresolved.add(`Ambiguous dynamic browser binding: ${file}`);
          else if ((binding.propertyName && ts.isIdentifier(binding.propertyName) ? binding.propertyName.text : binding.name.text) === "commands") commands.add(binding.name.text);
        }
      }
      ts.forEachChild(node, bindings);
    };
    bindings(source);
    const walk = (node: ts.Node) => {
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "vitest/browser" && !node.isTypeOnly)
        unresolved.add(`Re-exported browser command namespace: ${file}`);
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === "vitest/browser" &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
        const parent = node.parent;
        if (node.expression.kind !== ts.SyntaxKind.ImportKeyword || !ts.isAwaitExpression(parent) || !ts.isVariableDeclaration(parent.parent) || !ts.isObjectBindingPattern(parent.parent.name))
          unresolved.add(`Unsupported dynamic browser namespace: ${file}`);
      }
      if (ts.isIdentifier(node) && ["eval", "Function", "require"].includes(node.text) && !boundedRequireUse(node) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
          !(ts.isNewExpression(node.parent) && node.parent.expression === node)) unresolved.add(`Aliased activation evaluator/loader: ${file}`);
      if (ts.isCallExpression(node) && /^(?:eval|Function)$/.test(node.expression.getText(source)) ||
          ts.isNewExpression(node) && node.expression.getText(source) === "Function") unresolved.add(`Dynamic activation evaluation: ${file}`);
      if (ts.isIdentifier(node) && commands.has(node.text)) {
        const parent = node.parent;
        if (!ts.isImportSpecifier(parent) && !ts.isBindingElement(parent)) {
          if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || !ts.isCallExpression(parent.parent) || parent.parent.expression !== parent)
            unresolved.add(`Dynamic or aliased command invocation: ${file}`);
          else if (candidates.some(candidate => candidate.name === parent.name.text)) unresolved.add(`Selected command invocation ${file}: ${parent.name.text}`);
        }
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        edge(node.moduleSpecifier.text, ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) edge(node.arguments[0]!.text, false);
        else unresolved.add(`Computed activation loader: ${file}`);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source).startsWith("import.meta.glob")) unresolved.add(`Computed activation glob: ${file}`);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  for (const file of roots) visit(file);
  return { candidates: inactive, files: [...files].sort(), roots: [...roots].sort(), unresolved: [...unresolved].sort(), executionExcluded: false };
}

// This is a bounded audit of one actual runner/configuration and its seven
// dormant callbacks, not a JavaScript partial evaluator. A source edit requires
// an explicit new audit; imports still run through normal runtime closure.
const auditedSources: Record<string,string> = {
  "packages/ui-react/tests/browser/mermaid-proof-command.ts": "df7cc849b743c55c897236cd021793ad489548d780db2d053248116563832d3c",
  "packages/ui-react/tests/browser/offline/scene-commands.ts": "ad76a69e553d1d0208a5a92c8270876403930788964bd75f3887d06a426c17d2",
  "packages/ui-kit/vitest.config.ts": "e724696a55955e9f32d396b2031214600086533c3f9b8baabcc1c6bb7311f1db",
  "packages/ui-kit/vite.config.ts": "ffdb82cbcf2fd0106799690580ca7af612a0bcceeacf198ef0e8a77313b4cb91",
  "scripts/visual.mjs": "2576ce91c63843b6d9b2018c477e64734ea8343124170d4fca5cfd8257c3d1c8",
  "packages/ui-react/tests/browser/hygiene-loop-command.ts": "fd9c5e18f1e374be3657fefd6c7aac76f16794f1ca59f0f038761c75130da35a",
  "packages/ui-react/tests/browser/hygiene-server-command.ts": "13706860dac40cab354554cadbd809143a0f32ee0314d8fcec8f1d6d1d70b1bb",
  "packages/ui-react/tests/browser/policy-server-command.ts": "9cd4bfe73ea42e200f795c42a4ce1d2eb014daf9e117275d171b95314db1f148",
  "packages/ui-react/tests/browser/dispatch-actions-command.ts": "1e832b08a6560980f224bfc38713517091f381446da8e6eabeb28062f7ac151e",
  "packages/ui-react/tests/browser/hygiene-completion-frame.ts": "30d48865921cb18bfcae7942fedf53e8933c04444c85fdad291d2aca2b30d2f1"
};
export function auditedInactiveCommands(root: string, selected: readonly Spec[]) {
  for (const [file, expected] of Object.entries(auditedSources)) {
    const absolute = resolve(root,file);
    if (!existsSync(absolute) || realpathSync(absolute) !== absolute || createHash("sha256").update(readFileSync(absolute)).digest("hex") !== expected) return undefined;
  }
  return {config:"packages/ui-kit/vitest.config.ts",selected,candidates:[
    {name:"mermaidOutput",owner:"packages/ui-react/tests/browser/mermaid-proof-command.ts"},
    {name:"mermaidScreenComparison",owner:"packages/ui-react/tests/browser/mermaid-proof-command.ts"},
    {name:"offlineScene",owner:"packages/ui-react/tests/browser/offline/scene-commands.ts"},
    {name:"hygieneLoop",owner:"packages/ui-react/tests/browser/hygiene-loop-command.ts"},
    {name:"hygieneServer",owner:"packages/ui-react/tests/browser/hygiene-server-command.ts"},
    {name:"policyServer",owner:"packages/ui-react/tests/browser/policy-server-command.ts"},
    {name:"dispatchActions",owner:"packages/ui-react/tests/browser/dispatch-actions-command.ts"},
  ]};
}
