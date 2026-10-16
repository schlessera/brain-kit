/** Source-owned browser proof inputs. Unknown edges retain complete broad proof. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { auditCommandActivation, type CommandCandidate } from "./browser-command-activation";
import { generatedThemeInputs } from "./generated-theme-inputs";
import { sourceBrowserDispatch } from "./source-browser-dispatch";
import { boundBrowserDocuments, type BrowserDocumentInputs } from "./bound-browser-documents";
import { browserImporters, boundBrowserRuntimeInputs, type BrowserRuntimeBindings } from "./bound-browser-runtime-inputs";
import { sourceBrowserPayload } from "./source-browser-payloads";
import { lockedBrowserAsset, type LockedBrowserAsset } from "./locked-browser-assets";
import { generatedCssInputs, generatedCssReadInputs } from "./generated-build-inputs";
import { cssInputs } from "./css-inputs";
import { normalizeInventory, type Spec } from "./proof-inputs";

export type BrowserCategory = "browser" | "layout" | "endurance" | "captures";
export interface IndirectInput {
  /** Exact call expression: a source edit invalidates its declaration. */
  expression: string;
  targets: string[];
  /** Exact lexical function path disambiguates identical expressions. */
  scope?: string;
  /** Only literal, bounded kernel identity observations; never repository data. */
  observation?: "linux-proc-self-identity";
}
export interface InputDeclaration { owner: string; inputs: IndirectInput[]; }
export interface InputClosure { files: string[]; directories?: string[]; external?: LockedBrowserAsset[]; unresolved: string[]; }
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const sourceExtension = /\.[cm]?[jt]sx?$/;
const readOperations = new Set(["readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync", "createReadStream", "open", "openSync", "opendir", "opendirSync", "access", "accessSync", "existsSync", "stat", "statSync", "lstat", "lstatSync", "watch", "watchFile", "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

function inside(root: string, file: string): string | undefined {
  const path = relative(root, file).replaceAll("\\", "/");
  return !path.startsWith("../") && !isAbsolute(path) ? path : undefined;
}
/** No declaration can suppress an unresolved call: every declaration names real inputs. */
export function discoverInputClosure(root: string, entrypoints: readonly string[], declarations: readonly InputDeclaration[] = [], activation?: { config: string; selected: readonly Spec[]; candidates: readonly CommandCandidate[] }): InputClosure {
  root = realpathSync(root);
  const unresolved = new Set<string>(), files = new Set<string>(), directories = new Set<string>();
  const external = new Map<string, LockedBrowserAsset>();
  const declared = new Map<string, Map<string, IndirectInput>>();
  const inactive = new Map<string, Set<string>>();
  const executionRoots = new Set<string>();
  let runtimeBindings: BrowserRuntimeBindings = new Map();
  let dispatchBindings = new Map<string, Set<string>>();
  let documentBindings = new Map<string, Map<string,BrowserDocumentInputs>>();
  let themeBinding: ReturnType<typeof generatedThemeInputs>;
  if (activation) {
    const audit = auditCommandActivation(root, activation.config, activation.selected, activation.candidates);
    for (const failure of audit.unresolved) unresolved.add(failure);
    if (!audit.unresolved.length) {
      for(const file of audit.roots)executionRoots.add(file);
      const importers = browserImporters(root, audit.files);
      runtimeBindings = boundBrowserRuntimeInputs(root, audit.files, importers);
      dispatchBindings = sourceBrowserDispatch(root, audit.files, importers);
      documentBindings = boundBrowserDocuments(root, audit.files, importers);
      themeBinding = generatedThemeInputs(root, audit.files, importers);
    }
    if (!audit.unresolved.length) for (const candidate of audit.candidates) {
      const names = inactive.get(candidate.owner) ?? new Set<string>();
      names.add(candidate.name); inactive.set(candidate.owner, names);
    }
  }
  const inputKey = (input: IndirectInput) => input.scope ? `${input.scope}\0${input.expression}` : input.expression;
  for (const declaration of declarations) {
    if (!declaration || typeof declaration.owner !== "string" || !/\.(?:[cm]?[jt]sx?|css)$/.test(declaration.owner) || !Array.isArray(declaration.inputs) || declared.has(declaration.owner) || !inside(root, resolve(root, declaration.owner)) || !existsSync(join(root, declaration.owner))) {
      unresolved.add(`Invalid declaration owner: ${declaration?.owner}`); continue;
    }
    const inputs = new Map<string, IndirectInput>();
    for (const input of declaration.inputs) {
      if (!input || typeof input.expression !== "string" || !Array.isArray(input.targets) || (!input.targets.length && !input.observation) || (input.observation !== undefined && (input.observation !== "linux-proc-self-identity" || input.targets.length !== 0)) || (input.scope !== undefined && (typeof input.scope !== "string" || !/^[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)*$/.test(input.scope))) || input.targets.some(target => typeof target !== "string" || resolve(root, target) === resolve(root, declaration.owner)) || new Set(input.targets).size !== input.targets.length || inputs.has(inputKey(input)))  { unresolved.add(`Invalid declaration: ${declaration.owner}`); continue; }
      inputs.set(inputKey(input), input);
    }
    declared.set(declaration.owner, inputs);
  }
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext, customConditions: ["bun"], resolveJsonModule: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.ReactJSX };
  const visited = new Set<string>();
  const visit = (file: string, scanOnly = false, sourceOnly = false) => {
    const absolute = resolve(root, file), normalized = inside(root, absolute);
    if (normalized === undefined || normalized.startsWith("node_modules/") || normalized === "node_modules") { unresolved.add(`Input escapes repository: ${file}`); return; }
    const key = `${scanOnly}:${sourceOnly}:${normalized}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!existsSync(absolute)) { unresolved.add(`Missing input: ${normalized}`); return; }
    const real = inside(root, realpathSync(absolute));
    if (real !== normalized) { unresolved.add(`Unsupported symbolic input: ${normalized}`); return; }
    if (normalized) files.add(normalized);
    const stat = ts.sys.directoryExists(absolute);
    if (stat) {
      directories.add(normalized || ".");
      for (const entry of readdirSync(absolute).sort()) visit(normalized ? `${normalized}/${entry}` : entry, scanOnly, sourceOnly);
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
          if (declaration.observation || declaration.scope) unresolved.add(`Invalid CSS input declaration ${normalized}: ${input.expression}`);
          if (uses.has(input.expression)) unresolved.add(`Ambiguous declaration site ${normalized}: ${input.expression}`);
          uses.add(input.expression);
          for (const target of declaration.targets) visit(target);
        } else if (input.value?.startsWith(".")) {
          const target = relative(root, resolve(dirname(absolute), input.value));
          if (input.kind === "source" && !ts.sys.directoryExists(resolve(root, target))) unresolved.add(`Missing CSS scan directory ${normalized}: ${input.value}`);
          else visit(target, input.kind === "source");
        } else unresolved.add(`Undeclared CSS input ${normalized}: ${input.expression}`);
      }
      for (const [key, declaration] of declared.get(normalized) ?? []) if (!uses.has(key)) unresolved.add(`Stale declaration ${normalized}: ${declaration.expression}`);
      return;
    }
    if (!sourceExtension.test(file)) return;
    const source = readFileSync(absolute, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) unresolved.add(`Invalid source: ${normalized}`);
    const uses = new Set<string>(), sites = new Set<string>();
    const pathResolveAliases = new Set<string>();
    const aliases = new Map<string, string>(), namespaces = new Set<string>(), filesystemAliases = new Set<string>(), shadowedBindings = new Set<string>();
    for (const statement of ast.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text.replace(/^node:/, "");
      if (specifier === "path" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings))
        for (const binding of statement.importClause.namedBindings.elements) if ((binding.propertyName?.text ?? binding.name.text) === "resolve") pathResolveAliases.add(binding.name.text);
      if (["fs", "fs/promises", "child_process"].includes(specifier)) {
        if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
          aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
          if (specifier === "fs" || specifier === "fs/promises") filesystemAliases.add(element.name.text);
        }
      }
    }
    const edge = (specifier: string, typeOnly = false) => {
      if (builtins.has(specifier) || specifier.startsWith("bun:")) return;
      const generated = specifier.startsWith(".") ? generatedCssInputs(root, resolve(dirname(absolute), specifier.split("?")[0]!)) : undefined;
      if (generated) {
        visit(generated.entry);
        for (const producer of generated.producer) visit(producer, true);
        return;
      }
      const result = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule;
      if (!result) {
        // Bundler-owned assets are still repository inputs, even when TypeScript has no declaration.
        const asset = specifier.startsWith(".") ? resolve(dirname(absolute), specifier.split("?")[0]!) : "";
        if (asset && existsSync(asset)) { visit(relative(root, asset), typeOnly, sourceOnly); return; }
        unresolved.add(`Unresolved import ${normalized}: ${specifier}`); return;
      }
      const target = inside(root, result.resolvedFileName);
      if (target?.startsWith("node_modules/") || result.isExternalLibraryImport && !specifier.startsWith("@schlessera/")) return;
      if (!target) { unresolved.add(`External workspace input ${normalized}: ${specifier}`); return; }
      visit(target, typeOnly, sourceOnly);
    };
    const lexicalScope = (node: ts.Node): string => {
      const names: string[] = [];
      for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent) && parent.name) names.unshift(parent.name.text);
        else if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) names.unshift(parent.parent.name.text);
      }
      return names.join("/");
    };
    const declarationAt = (node: ts.Node): IndirectInput | undefined => {
      const expression = node.getText(ast), candidates = declared.get(normalized);
      const general = candidates?.get(expression), scoped = candidates?.get(`${lexicalScope(node)}\0${expression}`);
      if (general && scoped) { unresolved.add(`Ambiguous declaration scope ${normalized}: ${expression}`); return undefined; }
      return scoped ?? general;
    };
    const collectBindings = (node: ts.Node) => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && ts.isIdentifier(node.name)) shadowedBindings.add(node.name.text);
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(ast);
    const kernelObservation = (node: ts.Node, declaration: IndirectInput): boolean => {
      if (!declaration.observation) return false;
      if (!ts.isCallExpression(node) || !node.arguments.length || !ts.isStringLiteral(node.arguments[0]!)) return false;
      const name = node.expression.getText(ast);
      if (!filesystemAliases.has(name) || shadowedBindings.has(name)) return false;
      const callee = aliases.get(name);
      const path = node.arguments[0]!.text;
      return (callee === "readFileSync" || callee === "readFile") && ["/proc/sys/kernel/random/boot_id", "/proc/self/status"].includes(path) ||
        ["readlinkSync", "readlink", "statSync", "stat"].includes(callee ?? "") && path === "/proc/self/ns/pid";
    };
    // Result transformations can be declared exactly, but only along the
    // direct receiver chain of a recognised input call. An arbitrary outer
    // function cannot conceal unrelated input operations.
    const inputDeclarations = (node: ts.Node): IndirectInput[] => {
      const matches: IndirectInput[] = [];
      let current = node;
      for (;;) {
        const declaration = declarationAt(current);
        if (declaration) matches.push(declaration);
        const property = current.parent;
        if (!property || !ts.isPropertyAccessExpression(property) || property.expression !== current ||
            !ts.isCallExpression(property.parent) || property.parent.expression !== property) break;
        current = property.parent;
      }
      return matches;
    };
    const boundAlias = (node: ts.Identifier): boolean => {
      if(themeBinding?.owner!==normalized)return false;
      const contexts=themeBinding.aliases.get(node.text);if(!contexts)return false;
      return [node.parent,node.parent?.parent].some(parent=>parent&&contexts.has(parent.getText(ast)));
    };
    const walk = (node: ts.Node, dormant = sourceOnly) => {
      if (!dormant && ts.isPropertyAccessExpression(node) && /^(?:process|Bun)\.env$/.test(node.getText(ast)) &&
          !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node))
        unresolved.add(`Git-dependent execution input: ${normalized}`);
      if (!dormant && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && /^(?:process|Bun)\.env$/.test(node.expression.getText(ast))) {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
        if (!name || name.startsWith("GITHUB_")) unresolved.add(`Git-dependent execution input: ${normalized}`);
      }
      if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && inactive.get(normalized)?.has(node.parent.name.text)) dormant = true;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.getText(ast);
        const matching = declarationAt(node);
        if (matching) {
          const key = inputKey(matching);
          if (sites.has(key)) unresolved.add(`Ambiguous declaration site ${normalized}: ${expression}`);
          sites.add(key);
        }
      }
      if (!dormant && ts.isIdentifier(node) && aliases.has(node.text) && readOperations.has(aliases.get(node.text)!)) {
        const parent = node.parent;
        if (!ts.isImportSpecifier(parent) && !(ts.isCallExpression(parent) && parent.expression === node) && !boundAlias(node)) unresolved.add(`Unsupported input alias ${normalized}: ${node.text}`);
      }
      if (!dormant && ts.isIdentifier(node) && namespaces.has(node.text)) {
        const parent = node.parent;
        if (!ts.isImportClause(parent) && !ts.isNamespaceImport(parent) && !(ts.isPropertyAccessExpression(parent) && parent.expression === node) && !(ts.isElementAccessExpression(parent) && parent.expression === node)) unresolved.add(`Unsupported input namespace alias ${normalized}: ${node.text}`);
      }
      if (!dormant && ts.isIdentifier(node) && node.text === "require" && !(ts.isCallExpression(node.parent) && node.parent.expression === node) && !boundAlias(node)) unresolved.add(`Unsupported require alias ${normalized}`);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        edge(node.moduleSpecifier.text, ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly);
      if (dormant && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        for (const declaration of inputDeclarations(node)) {
          uses.add(inputKey(declaration));
          for (const target of declaration.targets) visit(target, false, true);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
          // Imported modules execute only when the inactive callback executes.
          const specifier = node.arguments[0]!.text;
          const result = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule;
          if (builtins.has(specifier) || specifier.startsWith("bun:")) { /* Runtime-provided builtin; already in runner identity. */ }
          else if (result && !result.isExternalLibraryImport) visit(relative(root, result.resolvedFileName), false, true);
          else if (!result) unresolved.add(`Unresolved dormant import ${normalized}: ${specifier}`);
        }
      }
      if (!dormant && ts.isCallExpression(node)) {
        const originalCallee = node.expression.getText(ast), callee = aliases.get(originalCallee) ?? originalCallee, expression = node.getText(ast);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) edge(node.arguments[0]!.text);
          else {
            const declaration = declared.get(normalized)?.get(expression);
            if (declaration?.observation) unresolved.add(`Invalid runner observation ${normalized}: ${expression}`);
            if (!declaration) unresolved.add(`Computed import ${normalized}: ${expression}`);
            else { uses.add(expression); for (const target of declaration.targets) visit(target); }
          }
        } else if (aliases.has(originalCallee) && readOperations.has(callee) ||
          [...namespaces].some(name => originalCallee.startsWith(name + ".") && readOperations.has(originalCallee.split(".").at(-1)!)) ||
          /^(?:require|Bun\.(?:file|spawn|spawnSync|build|resolveSync)|import\.meta\.glob)$/.test(originalCallee) || ts.isElementAccessExpression(node.expression) || /\.(?:fulfill|setContent)$/.test(originalCallee)) {
          const path = node.arguments[0];
          const literalRead = filesystemAliases.has(originalCallee) && !shadowedBindings.has(originalCallee) && callee === "readFile" &&
            node.arguments.length === 2 && ts.isStringLiteral(node.arguments[1]!) && node.arguments[1]!.text === "utf8" &&
            path && ts.isCallExpression(path) && ts.isIdentifier(path.expression) && pathResolveAliases.has(path.expression.text) &&
            path.arguments.length === 1 && ts.isStringLiteral(path.arguments[0]!) ? path.arguments[0]!.text : undefined;
          const generated = literalRead ? generatedCssReadInputs(root, normalized, literalRead) : undefined;
          const locked = literalRead ? lockedBrowserAsset(root, normalized, literalRead) : undefined;
          const literalPayload = /\.(?:fulfill|setContent)$/.test(originalCallee) && sourceBrowserPayload(root, normalized, expression);
          const boundRuntime = runtimeBindings.get(normalized)?.get(expression);
          const boundDispatch = dispatchBindings.get(normalized)?.has(expression) === true;
          const boundDocument = documentBindings.get(normalized)?.get(expression);
          if(boundDocument){for(const target of boundDocument.runtime)visit(target);for(const target of boundDocument.bytes)visit(target,true);}
          const generatedTheme = themeBinding?.owner===normalized && themeBinding.read===expression ? themeBinding : undefined;
          if(generatedTheme){for(const target of generatedTheme.css)visit(target);for(const target of generatedTheme.bytes)visit(target,true);external.set(`${generatedTheme.compiler.package}/${generatedTheme.compiler.asset}`,generatedTheme.compiler);}
          if (boundRuntime) for (const target of boundRuntime) visit(target, true);
          if (locked) {
            external.set(`${locked.package}/${locked.asset}`, locked);
            visit("package.json", true); visit("bun.lock", true);
          }
          if (generated) {
            visit(generated.entry);
            for (const producer of generated.producer) visit(producer, true);
          }
          const matching = inputDeclarations(node);
          if (matching.some(declaration => declaration.observation && !kernelObservation(node, declaration))) unresolved.add(`Invalid runner observation ${normalized}: ${expression}`);
          if (!matching.length && !generated && !locked && !literalPayload && !boundRuntime && !boundDispatch && !generatedTheme && !boundDocument) unresolved.add(`Undeclared input ${normalized}: ${expression}`);
          else for (const declaration of matching) { uses.add(inputKey(declaration)); for (const target of declaration.targets) visit(target); }
        }
      }
      if (!dormant && ts.isNewExpression(node) && /^(?:Worker|SharedWorker|Bun\.Glob)$/.test(node.expression.getText(ast))) {
        const expression = node.getText(ast), declaration = declared.get(normalized)?.get(expression);
        if (declaration?.observation) unresolved.add(`Invalid runner observation ${normalized}: ${expression}`);
        if (!declaration) unresolved.add(`Undeclared constructed input ${normalized}: ${expression}`);
        else { uses.add(expression); for (const target of declaration.targets) visit(target); }
      }
      ts.forEachChild(node, child => walk(child, dormant));
    };
    walk(ast);
    for (const [key, declaration] of declared.get(normalized) ?? []) if (!uses.has(key)) unresolved.add(`Stale declaration ${normalized}: ${declaration.expression}`);
  };
  for (const file of [...entrypoints,...executionRoots]) visit(file);
  for (const owner of declared.keys()) if (!files.has(owner)) unresolved.add(`Unused declaration owner: ${owner}`);
  return { files: [...files].sort(), directories: [...directories].sort(), ...(external.size ? { external: [...external.values()].sort((a,b) => `${a.package}/${a.asset}`.localeCompare(`${b.package}/${b.asset}`)) } : {}), unresolved: [...unresolved].sort() };
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
