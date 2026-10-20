/** Additive unit proof inputs; unresolved imports select their runnable owners. */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { CheckPlan } from "./ci-plan";
import { resolveRuntimeModule } from "./runtime-module-resolution";
import { discoverTests } from "./test-shards";

export interface UnitImportGraph {
  tests: string[];
  /** Dependency -> immediate consumers, including statically named fixture scripts. */
  reverse: Map<string, Set<string>>;
  unresolved: Map<string, string[]>;
}

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const sourceExtension = /\.[cm]?[jt]sx?$/i;
const options: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
  customConditions: ["bun"], resolveJsonModule: true, allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX,
};
const inside = (root: string, path: string) => {
  const value = relative(root, path).replaceAll("\\", "/");
  return value && !value.startsWith("../") && !isAbsolute(value) ? value : undefined;
};
const stem = (path: string) => basename(path).replace(/\.[cm]?[jt]sx?$/i, "");

/** A new graph per planning invocation: no stale working-tree or dependency cache. */
export function discoverUnitImports(root: string): UnitImportGraph {
  root = realpathSync(root);
  const roots = ["packages", "tests"].filter(path => existsSync(join(root, path)));
  const tests = discoverTests(root, roots), leaves = new Set(tests);
  const reverse = new Map<string, Set<string>>(), unresolved = new Map<string, string[]>();
  const fixtures = new Map<string, string[]>();
  // Named spawned/file-read helpers are inputs too. Basename collisions add all
  // candidates; this is conservative ownership, not arbitrary expression evaluation.
  const inventory = (path: string) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.toLowerCase() === "node_modules") continue;
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) inventory(file);
      else if (sourceExtension.test(file) && !leaves.has(file) &&
          /^(?:tests\/|packages\/[^/]+\/tests\/)/.test(file)) {
        const key = stem(file), values = fixtures.get(key) ?? [];
        values.push(file); fixtures.set(key, values);
      }
    }
  };
  for (const path of roots) inventory(path);
  const visited = new Set<string>();
  const unknown = (file: string, reason: string) => {
    const reasons = unresolved.get(file) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    unresolved.set(file, reasons);
  };
  const input = (owner: string, target: string) => {
    const consumers = reverse.get(target) ?? new Set<string>();
    consumers.add(owner); reverse.set(target, consumers);
  };
  // Resolution reads package scopes as well as source bytes. Include absent
  // scopes too: adding/deleting package.json can redirect the same import.
  // These are metadata inputs, not missing executable source dependencies.
  const scopes = (owner: string, target: string) => {
    for (let dir = dirname(target); dir !== "."; dir = dirname(dir))
      input(owner, `${dir}/package.json`);
    input(owner, "package.json");
  };
  const edge = (owner: string, target: string) => {
    input(owner, target);
    scopes(owner, target);
    visit(target);
  };
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const absolute = resolve(root, file);
    let source: string;
    try {
      if (inside(root, absolute) !== file || realpathSync(absolute) !== absolute ||
          !(lstatSync(absolute).mode & 0o444) || !lstatSync(absolute).isFile()) {
        unknown(file, "Unsupported, unreadable or symbolic input"); return;
      }
      if (!sourceExtension.test(file)) return;
      source = readFileSync(absolute, "utf8");
    } catch { unknown(file, "Missing or unreadable input"); return; }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
      unknown(file, "Invalid source");
    const imported = (specifier: string, typeOnly = false) => {
      // Module namespaces/defaults, destructuring, re-exports and dynamic
      // access can all expose createRequire/Module._load. Without evaluating
      // that dataflow, retain this source's runnable owners conservatively.
      if (!typeOnly && (specifier === "module" || specifier === "node:module"))
        unknown(file, "Unsupported module loader access");
      if (builtins.has(specifier) || specifier.startsWith("bun:")) return;
      scopes(file, file);
      const result = typeOnly ? ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule :
        resolveRuntimeModule(specifier, absolute, options);
      if (!result) {
        const asset = specifier.startsWith(".") ? resolve(dirname(absolute), specifier.split("?")[0]!) : "";
        const target = asset && inside(root, asset);
        if (target && existsSync(asset)) edge(file, target);
        else unknown(file, `Unresolved import: ${specifier}`);
        return;
      }
      const target = inside(root, result.resolvedFileName);
      if (target?.split("/").includes("node_modules") ||
          !target && result.isExternalLibraryImport && !specifier.startsWith("@schlessera/") && !specifier.startsWith(".")) return;
      if (!target) { unknown(file, `External source import: ${specifier}`); return; }
      edge(file, target);
    };
    const walk = (node: ts.Node) => {
      if (ts.isImportTypeNode(node)) {
        if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
          imported(node.argument.literal.text, true);
        else unknown(file, "Unsupported import type");
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imported(node.moduleSpecifier.text, ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const value = node.moduleReference.expression;
        if (value && ts.isStringLiteralLike(value)) imported(value.text, node.isTypeOnly);
        else unknown(file, "Unsupported import assignment");
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          /^(?:require|require\.resolve|import\.meta\.resolve|Bun\.resolveSync)$/.test(node.expression.getText(ast)))) {
        if (node.arguments.length > 1 && /^(?:require\.resolve|import\.meta\.resolve|Bun\.resolveSync)$/.test(node.expression.getText(ast)))
          unknown(file, "Unsupported custom resolution base");
        const value = node.arguments[0];
        if (value && ts.isStringLiteralLike(value)) imported(value.text);
        else unknown(file, `Computed import: ${node.getText(ast)}`);
      }
      if (ts.isIdentifier(node) && node.text === "require" &&
          !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === "resolve"))
        unknown(file, "Unsupported require alias");
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "createRequire" &&
          node.name.text !== "createRequire")
        unknown(file, "Unsupported require factory alias");
      if (ts.isCallExpression(node) && /^(?:createRequire|import\.meta\.glob)$/.test(node.expression.getText(ast)))
        unknown(file, "Runtime-selected loader");
      if (ts.isIdentifier(node) && (node.text === "Bun" || node.text === "module") ||
          ts.isMetaProperty(node) && node.getText(ast) === "import.meta") {
        const parent = node.parent;
        const object = node.getText(ast);
        const property = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : undefined;
        const directCall = ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
        const indirectObject = ts.isVariableDeclaration(parent) && parent.initializer === node ||
          ts.isElementAccessExpression(parent) && parent.expression === node ||
          ts.isCallExpression(parent) && parent.arguments.some(argument => argument === node) ||
          ts.isParenthesizedExpression(parent);
        const resolver = property && /^(?:resolve|resolveSync|require)$/.test(property);
        const supportedCall = directCall && (object === "Bun" ? property === "resolveSync" : property === "resolve");
        if (object === "module" ? property && /^(?:require|createRequire|_load|constructor)$/.test(property) || indirectObject :
            indirectObject || resolver && !supportedCall)
          unknown(file, "Unsupported loader object or resolver alias");
      }
      if (/^(?:tests\/|scripts\/|packages\/[^/]+\/(?:tests|scripts)\/)/.test(file) &&
          (ts.isTemplateExpression(node) && sourceExtension.test(node.templateSpans.at(-1)!.literal.text) ||
           ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
           ts.isStringLiteralLike(node.right) && sourceExtension.test(node.right.text)))
        unknown(file, "Computed source/fixture reference");
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
          /^(?:tests\/|scripts\/|packages\/[^/]+\/(?:tests|scripts)\/)/.test(file) &&
          !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) &&
          !ts.isExternalModuleReference(node.parent)) {
        // Fixed names also occur in shell payloads or extension-appending helpers.
        // This never evaluates interpolations; ambiguous names retain all matches.
        const values = /^[./\w-]+$/.test(node.text) ? [node.text] :
          [...node.text.matchAll(/(?:^|[\s"'`])([./\w-]+\.[cm]?[jt]sx?)(?=$|[\s"'`?])/g)].map(match => match[1]!);
        for (const value of values) {
          const resolved = value.startsWith(".") ? resolveRuntimeModule(value, absolute, options)?.resolvedFileName : undefined;
          const targets = fixtures.get(stem(value)) ?? [];
          for (const target of targets) if (!resolved || resolve(root, target) === resolved) edge(file, target);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
  };
  for (const test of tests) visit(test);
  return { tests, reverse, unresolved };
}

/** Cycles are finite; helpers need not themselves be runnable test files. */
export function unitImportOwners(graph: UnitImportGraph, inputs: readonly string[]): string[] {
  const seen = new Set(inputs), pending = [...inputs];
  for (let i = 0; i < pending.length; i++) for (const owner of graph.reverse.get(pending[i]!) ?? []) {
    if (!seen.has(owner)) { seen.add(owner); pending.push(owner); }
  }
  return graph.tests.filter(file => seen.has(file));
}

export function selectUnitImportConsumers(graph: UnitImportGraph, changed: readonly string[]): {
  tests: string[]; fallbackTests: string[];
} {
  const fallbackTests = unitImportOwners(graph, [...graph.unresolved.keys()]);
  return { tests: [...new Set([...unitImportOwners(graph, changed), ...fallbackTests])].sort(), fallbackTests };
}

/** Preserve the manifest/root floor and all categories; only unit inventory grows. */
export function addUnitImportConsumers(plan: CheckPlan, root: string, graph?: UnitImportGraph): CheckPlan {
  if (plan.global || !plan.local.fullTests) return plan;
  const roots = ["tests", ...plan.affected.map(dir => `packages/${dir}`)].filter(path => existsSync(join(root, path)));
  const floor = plan.unitTests ?? discoverTests(root, roots);
  const discovered = new Set(graph?.tests ?? discoverTests(root, ["packages", "tests"].filter(path => existsSync(join(root, path)))));
  if (plan.unitTests && (!floor.length || new Set(floor).size !== floor.length || floor.some(file => !discovered.has(file))))
    throw new Error("Invalid explicit unit inventory before consumer expansion");
  let consumers: string[];
  try { consumers = selectUnitImportConsumers(graph ?? discoverUnitImports(root), plan.changed).tests; }
  catch {
    // No trustworthy graph means complete UNIT discovery, never an empty skip
    // or changes to unrelated browser/runtime/packaging category ownership.
    consumers = [...discovered];
  }
  // Synthetic fixtures may not contain the curated fast groups. They are not
  // executed here; only actual discovered inputs can enter an explicit inventory.
  const selected = [...new Set([...floor, ...consumers, ...plan.tests.filter(file => discovered.has(file))])].sort();
  if (selected.length === floor.length && selected.every(file => floor.includes(file))) return plan;
  return { ...plan, unitTests: selected };
}
