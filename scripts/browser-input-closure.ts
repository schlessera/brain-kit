/** Source-owned browser proof inputs. Unknown edges retain complete broad proof. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { cssInputs } from "./css-inputs";
import { normalizeInventory, type Spec } from "./proof-inputs";

export type BrowserCategory = "browser" | "layout" | "endurance" | "captures";
export interface IndirectInput {
  /** Exact call expression: a source edit invalidates its declaration. */
  expression: string;
  targets: string[];
}
export interface InputDeclaration { owner: string; inputs: IndirectInput[]; }
export interface InputClosure { files: string[]; directories?: string[]; unresolved: string[]; }
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const sourceExtension = /\.[cm]?[jt]sx?$/;
const readOperations = new Set(["readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync", "createReadStream", "open", "openSync", "opendir", "opendirSync", "access", "accessSync", "existsSync", "stat", "statSync", "lstat", "lstatSync", "watch", "watchFile", "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

function inside(root: string, file: string): string | undefined {
  const path = relative(root, file).replaceAll("\\", "/");
  return !path.startsWith("../") && !isAbsolute(path) ? path : undefined;
}
/** No declaration can suppress an unresolved call: every declaration names real inputs. */
export function discoverInputClosure(root: string, entrypoints: readonly string[], declarations: readonly InputDeclaration[] = []): InputClosure {
  root = realpathSync(root);
  const unresolved = new Set<string>(), files = new Set<string>(), directories = new Set<string>();
  const declared = new Map<string, Map<string, IndirectInput>>();
  for (const declaration of declarations) {
    if (!declaration || typeof declaration.owner !== "string" || !/\.(?:[cm]?[jt]sx?|css)$/.test(declaration.owner) || !Array.isArray(declaration.inputs) || declared.has(declaration.owner) || !inside(root, resolve(root, declaration.owner)) || !existsSync(join(root, declaration.owner))) {
      unresolved.add(`Invalid declaration owner: ${declaration?.owner}`); continue;
    }
    const inputs = new Map<string, IndirectInput>();
    for (const input of declaration.inputs) {
      if (!input || typeof input.expression !== "string" || !Array.isArray(input.targets) || !input.targets.length || input.targets.some(target => typeof target !== "string" || resolve(root, target) === resolve(root, declaration.owner)) || new Set(input.targets).size !== input.targets.length || inputs.has(input.expression))  { unresolved.add(`Invalid declaration: ${declaration.owner}`); continue; }
      inputs.set(input.expression, input);
    }
    declared.set(declaration.owner, inputs);
  }
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext, customConditions: ["bun"], resolveJsonModule: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.ReactJSX };
  const visited = new Set<string>();
  const visit = (file: string, scanOnly = false) => {
    const absolute = resolve(root, file), normalized = inside(root, absolute);
    if (normalized === undefined || normalized.startsWith("node_modules/") || normalized === "node_modules") { unresolved.add(`Input escapes repository: ${file}`); return; }
    const key = `${scanOnly}:${normalized}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!existsSync(absolute)) { unresolved.add(`Missing input: ${normalized}`); return; }
    const real = inside(root, realpathSync(absolute));
    if (real !== normalized) { unresolved.add(`Unsupported symbolic input: ${normalized}`); return; }
    if (normalized) files.add(normalized);
    const stat = ts.sys.directoryExists(absolute);
    if (stat) {
      directories.add(normalized || ".");
      for (const entry of readdirSync(absolute).sort()) visit(normalized ? `${normalized}/${entry}` : entry, scanOnly);
      return;
    }
    if (scanOnly) return; // Tailwind scans bytes; it does not execute/import scanned source.
    if (file.endsWith(".css")) {
      const css = cssInputs(readFileSync(absolute, "utf8"));
      const uses = new Set<string>();
      if (css.unsupported) unresolved.add(`Unsupported CSS/build inputs: ${normalized}`);
      for (const input of css.inputs) {
        const declaration = input.kind === "import" && !input.value?.startsWith(".") ? declared.get(normalized)?.get(input.expression) : undefined;
        if (declaration) {
          if (uses.has(input.expression)) unresolved.add(`Ambiguous declaration site ${normalized}: ${input.expression}`);
          uses.add(input.expression);
          for (const target of declaration.targets) visit(target);
        } else if (input.value?.startsWith(".")) {
          const target = relative(root, resolve(dirname(absolute), input.value));
          if (input.kind === "source" && !ts.sys.directoryExists(resolve(root, target))) unresolved.add(`Missing CSS scan directory ${normalized}: ${input.value}`);
          else visit(target, input.kind === "source");
        } else unresolved.add(`Undeclared CSS input ${normalized}: ${input.expression}`);
      }
      for (const expression of declared.get(normalized)?.keys() ?? []) if (!uses.has(expression)) unresolved.add(`Stale declaration ${normalized}: ${expression}`);
      return;
    }
    if (!sourceExtension.test(file)) return;
    const source = readFileSync(absolute, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) unresolved.add(`Invalid source: ${normalized}`);
    const uses = new Set<string>(), sites = new Set<string>();
    const aliases = new Map<string, string>(), namespaces = new Set<string>();
    for (const statement of ast.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text.replace(/^node:/, "");
      if (["fs", "fs/promises", "child_process"].includes(specifier)) {
        if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
    const edge = (specifier: string) => {
      if (builtins.has(specifier) || specifier.startsWith("bun:")) return;
      const result = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule;
      if (!result) {
        // Bundler-owned assets are still repository inputs, even when TypeScript has no declaration.
        const asset = specifier.startsWith(".") ? resolve(dirname(absolute), specifier.split("?")[0]!) : "";
        if (asset && existsSync(asset)) { visit(relative(root, asset)); return; }
        unresolved.add(`Unresolved import ${normalized}: ${specifier}`); return;
      }
      const target = inside(root, result.resolvedFileName);
      if (target?.startsWith("node_modules/") || result.isExternalLibraryImport && !specifier.startsWith("@schlessera/")) return;
      if (!target) { unresolved.add(`External workspace input ${normalized}: ${specifier}`); return; }
      visit(target);
    };
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.getText(ast);
        if (declared.get(normalized)?.has(expression)) {
          if (sites.has(expression)) unresolved.add(`Ambiguous declaration site ${normalized}: ${expression}`);
          sites.add(expression);
        }
      }
      if (ts.isIdentifier(node) && aliases.has(node.text) && readOperations.has(aliases.get(node.text)!)) {
        const parent = node.parent;
        if (!ts.isImportSpecifier(parent) && !(ts.isCallExpression(parent) && parent.expression === node)) unresolved.add(`Unsupported input alias ${normalized}: ${node.text}`);
      }
      if (ts.isIdentifier(node) && namespaces.has(node.text)) {
        const parent = node.parent;
        if (!ts.isImportClause(parent) && !ts.isNamespaceImport(parent) && !(ts.isPropertyAccessExpression(parent) && parent.expression === node) && !(ts.isElementAccessExpression(parent) && parent.expression === node)) unresolved.add(`Unsupported input namespace alias ${normalized}: ${node.text}`);
      }
      if (ts.isIdentifier(node) && node.text === "require" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) unresolved.add(`Unsupported require alias ${normalized}`);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) edge(node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        const originalCallee = node.expression.getText(ast), callee = aliases.get(originalCallee) ?? originalCallee, expression = node.getText(ast);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) edge(node.arguments[0]!.text);
          else {
            const declaration = declared.get(normalized)?.get(expression);
            if (!declaration) unresolved.add(`Computed import ${normalized}: ${expression}`);
            else { uses.add(expression); for (const target of declaration.targets) visit(target); }
          }
        } else if (aliases.has(originalCallee) && readOperations.has(callee) ||
          [...namespaces].some(name => originalCallee.startsWith(name + ".") && readOperations.has(originalCallee.split(".").at(-1)!)) ||
          /^(?:require|Bun\.(?:file|spawn|spawnSync|build|resolveSync)|import\.meta\.glob)$/.test(originalCallee) || ts.isElementAccessExpression(node.expression) || /\.(?:fulfill|setContent)$/.test(originalCallee)) {
          const declaration = declared.get(normalized)?.get(expression);
          if (!declaration) unresolved.add(`Undeclared input ${normalized}: ${expression}`);
          else { uses.add(expression); for (const target of declaration.targets) visit(target); }
        }
      }
      if (ts.isNewExpression(node) && /^(?:Worker|SharedWorker|Bun\.Glob)$/.test(node.expression.getText(ast))) {
        const expression = node.getText(ast), declaration = declared.get(normalized)?.get(expression);
        if (!declaration) unresolved.add(`Undeclared constructed input ${normalized}: ${expression}`);
        else { uses.add(expression); for (const target of declaration.targets) visit(target); }
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
    for (const expression of declared.get(normalized)?.keys() ?? []) if (!uses.has(expression)) unresolved.add(`Stale declaration ${normalized}: ${expression}`);
  };
  for (const file of entrypoints) visit(file);
  for (const owner of declared.keys()) if (!files.has(owner)) unresolved.add(`Unused declaration owner: ${owner}`);
  return { files: [...files].sort(), directories: [...directories].sort(), unresolved: [...unresolved].sort() };
}
export function closureSelects(changed: readonly string[], closure: InputClosure, broad: boolean): boolean {
  const inputs = new Set(closure.files);
  return changed.some(file => inputs.has(file) || closure.directories?.some(dir => dir === "." || file.startsWith(dir + "/"))) || (closure.unresolved.length > 0 && broad);
}

export type BrowserClosures = Record<BrowserCategory, InputClosure>;
/** Use the installed runner's actual file discovery; a failure leaves every category broad. */
export function discoverBrowserClosures(root: string): BrowserClosures {
  const declarations = (file: string): InputDeclaration[] => {
    const data = JSON.parse(readFileSync(join(root, file), "utf8"));
    if (!Array.isArray(data)) throw new Error("Invalid indirect-input declarations");
    return data;
  };
  const cssConfig = ["scripts/css-proof-inputs.json", "packages/ui-kit/src/styles.css", "packages/ui-react/src/styles.css"];
  const cssDeclarations = () => declarations("scripts/css-proof-inputs.json");
  let captures: InputClosure;
  try { captures = discoverInputClosure(root, ["scripts/capture.ts", "scripts/captures", "docs/process/feature-captures.md", ...cssConfig], [...declarations("scripts/captures/proof-inputs.json"), ...cssDeclarations()]); }
  catch { captures = { files: [], unresolved: ["Cannot establish capture input ownership"] }; }
  const output = join(root, "tmp", `browser-selection-${process.pid}.json`);
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const failed = (message: string): BrowserClosures => Object.fromEntries(
    ["browser", "layout", "endurance", "captures"].map(category => [category, category === "captures" ? captures : { files: [], unresolved: [message] }])) as unknown as BrowserClosures;
  let specs: Spec[];
  try {
    const command = Bun.spawnSync(["node", "../../node_modules/vitest/vitest.mjs", "list", "--filesOnly", `--json=${output}`], {
      cwd: join(root, "packages/ui-kit"), env: { ...process.env, CI: "true" }, stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    if (command.exitCode !== 0) return failed("Installed Vitest discovery failed");
    specs = normalizeInventory(JSON.parse(readFileSync(output, "utf8")), root);
    const declaration = /const projects = projectArgs\.length \?[^\n]+ : (\[[^\n]+\]);/.exec(readFileSync(join(root, "scripts/visual.mjs"), "utf8"));
    if (!declaration) return failed("Unknown browser project selection");
    const expected = [...JSON.parse(declaration[1]!), "ui-react-layout", "ui-react-endurance"].sort();
    const actual = [...new Set(specs.map(spec => spec.project))].sort();
    if (new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) return failed("Incomplete browser project discovery");
  } catch { return failed("Installed Vitest discovery unavailable"); }
  finally { rmSync(output, { force: true }); }
  try {
    const visualDeclarations = [...declarations("packages/ui-kit/tests/proof-inputs.json"), ...cssDeclarations()];
    const config = [...cssConfig, "packages/ui-kit/tests/proof-inputs.json", "packages/ui-kit/vitest.config.ts", "packages/ui-kit/vite.config.ts", "packages/ui-kit/.storybook/main.ts", "packages/ui-kit/.storybook/preview.ts"];
    const entries = (category: BrowserCategory) => [...config, ...specs.filter(spec => category === "layout" ? spec.project === "ui-react-layout" : category === "endurance" ? spec.project === "ui-react-endurance" : !["ui-react-layout", "ui-react-endurance"].includes(spec.project)).map(spec => spec.file)];
    return { browser: discoverInputClosure(root, entries("browser"), visualDeclarations),
      layout: discoverInputClosure(root, entries("layout"), visualDeclarations),
      endurance: discoverInputClosure(root, entries("endurance"), visualDeclarations),
      captures };
  } catch (error) { return failed(`Cannot establish indirect input ownership: ${String(error)}`); }
}
