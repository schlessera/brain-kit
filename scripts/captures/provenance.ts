import ts from "typescript";
import { sha256 } from "./hash.ts";
export { sha256 } from "./hash.ts";
import { execFileSync } from "node:child_process";
import { readFile, readdir, realpath, mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Sorted paths and actual bytes; timestamps are not build identity. */
export async function hashTree(root: string, directory: string, excluded: string[] = []): Promise<string> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const next = resolve(path, entry.name);
      const name = relative(root, next).split(sep).join("/");
      if (excluded.includes(name)) continue;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) files.push({ path: name, sha256: sha256(await readFile(next)) });
      else throw new Error(`Unexpected non-file build input: ${name}`);
    }
  }
  await visit(resolve(root, directory));
  if (!files.length) throw new Error(`Empty capture input directory: ${directory}`);
  return sha256(JSON.stringify(files));
}

export async function sourceProvenance(root: string): Promise<{
  commit: string; dirty: boolean; dirty_files: string[]; inputs_sha256: string;
}> {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\u0000").filter(Boolean);
  const relevant = files.filter((path) => path === "bun.lock" || path === "package.json" ||
    path === "docs/process/feature-captures.md" || path === "scripts/capture.ts" || path === "scripts/build.ts" || path === "scripts/visual.mjs" || path === "scripts/workspace-lease.mjs" || path.startsWith("scripts/captures/") ||
    /^packages\/(?:core|ui-kit|ui-react|ui-sdk|ui-server|render-template)\//.test(path)).sort();
  const records = await Promise.all(relevant.map(async (path) => {
    try { return { path, sha256: sha256(await readFile(resolve(root, path))) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path, sha256: "deleted" };
    }
  }));
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(status),
    dirty_files: status ? status.split("\n").map((line) => line.trim()) : [],
    inputs_sha256: sha256(JSON.stringify(records)),
  };
}

/** An explicit output cannot overwrite the repo or the visual baselines, including through a symlink. */
export async function outputDirectory(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(root);
  const desired = resolve(root, requested);
  let existing = desired;
  const pending: string[] = [];
  while (true) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (dirname(existing) === existing) throw error;
      pending.unshift(relative(dirname(existing), existing));
      existing = dirname(existing);
    }
  }
  const actual = resolve(existing, ...pending);
  const baseline = resolve(rootReal, "packages/ui-kit/tests/visual");
  if (actual === rootReal || actual === baseline || actual.startsWith(baseline + sep)) {
    throw new Error("Capture output must be a dedicated directory outside the regression baselines and repository root");
  }
  const markerPath = resolve(actual, ".brain-kit-feature-captures.json");
  let marker: unknown;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
  catch {
    try {
      if ((await stat(actual)).isDirectory() && (await readdir(actual)).length) {
        throw new Error("Capture output already contains unrelated files; choose an empty or previously managed capture directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (marker !== undefined && (typeof marker !== "object" || marker === null ||
      (marker as { purpose?: string }).purpose !== "brain-kit editorial captures")) {
    throw new Error("Unrecognized capture output ownership marker");
  }
  await mkdir(actual, { recursive: true });
  if (marker === undefined) await writeFile(markerPath, JSON.stringify({ purpose: "brain-kit editorial captures" }) + "\n", { flag: "wx" });
  return actual;
}

function pinSource(text: string, file: string): ts.SourceFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("Malformed shared browser pin source");
  return source;
}
function pinBindings(source: ts.SourceFile, name: string): ts.Node[] {
  const bindings: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) || ts.isImportClause(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) bindings.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source); return bindings;
}
function pinConstant(source: ts.SourceFile, name: string, exported = false): ts.Expression {
  const bindings = pinBindings(source, name);
  const declaration = bindings.length === 1 && ts.isVariableDeclaration(bindings[0]!) ? bindings[0]! : undefined;
  const list = declaration?.parent, statement = list?.parent;
  if (!declaration || !list || !ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) ||
      !statement || !ts.isVariableStatement(statement) || statement.parent !== source || !declaration.initializer ||
      exported && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    throw new Error(`The shared browser source must declare exactly one static ${name} pin`);
  }
  return declaration.initializer;
}
function runnerImageSource(text: string): { image: string } | { producer: true } {
  const source = pinSource(text, "visual.mjs"), value = pinConstant(source, "IMAGE");
  if (ts.isStringLiteral(value)) return { image: value.text };
  if (!ts.isIdentifier(value) || value.text !== "diagramProducerImageIdentity") throw new Error("Unsupported shared IMAGE initializer");
  const imports = source.statements.filter(ts.isImportDeclaration).flatMap(statement => {
    const bindings = statement.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(element => element.name.text === value.text).map(element => ({ statement, element })) : [];
  });
  const imported = imports.length === 1 ? imports[0] : undefined;
  if (pinBindings(source, value.text).length !== 1 || !imported || imported.statement.importClause?.isTypeOnly || imported.element.isTypeOnly ||
      imported.element.propertyName && imported.element.propertyName.text !== value.text ||
      !ts.isStringLiteral(imported.statement.moduleSpecifier) || imported.statement.moduleSpecifier.text !== "./diagram-export-producer.mjs") {
    throw new Error("Unsupported shared IMAGE import ownership");
  }
  return { producer: true };
}
/** Both current and immutable historical callers read only this fixed owned module. */
export function browserPinUsesProducer(runner: string): boolean {
  return "producer" in runnerImageSource(runner);
}
/** Parse executable static declarations; comments/strings and runner imports never execute. */
export function parseBrowserPin(runner: string, producer?: string): { image: string; playwright: string } {
  const source = runnerImageSource(runner);
  let image: string, tag: string;
  if ("image" in source) image = tag = source.image;
  else {
    if (producer === undefined) throw new Error("Missing shared browser producer pin source");
    const module = pinSource(producer, "diagram-export-producer.mjs");
    const tagPin = pinConstant(module, "diagramProducerImage", true), identity = pinConstant(module, "diagramProducerImageIdentity", true);
    if (!ts.isStringLiteral(tagPin) || !ts.isStringLiteral(identity) ||
        !/^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/.test(identity.text)) throw new Error("Unrecognized immutable shared Playwright image pin");
    tag = tagPin.text; image = identity.text;
  }
  const version = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble$/.exec(tag)?.[1];
  if (!version) throw new Error("Unrecognized shared Playwright image pin");
  return { image, playwright: version };
}
export async function resolveBrowserPin(root: string): Promise<{ image: string; playwright: string }> {
  const runner = await readFile(resolve(root, "scripts/visual.mjs"), "utf8");
  const pin = parseBrowserPin(runner, browserPinUsesProducer(runner) ? await readFile(resolve(root, "scripts/diagram-export-producer.mjs"), "utf8") : undefined);
  const pkg = JSON.parse(await readFile(resolve(root, "packages/ui-kit/package.json"), "utf8"));
  const installed = JSON.parse(await readFile(resolve(root, "node_modules/playwright/package.json"), "utf8"));
  if (pkg.devDependencies?.playwright !== pin.playwright || installed.version !== pin.playwright) {
    throw new Error("Shared image, declared Playwright and installed Playwright versions differ; run the frozen install and verify the pin");
  }
  return pin;
}

/** Qualify overrides without changing an approved default filename. */
export function variantFile(file:string,declaredTheme:string,theme:string,viewport?:{width:number;height:number}):string {
  let result=file.replace(`-${declaredTheme}.`,`-${theme}.`);
  if(theme!==declaredTheme && result===file)result=result.replace(/(\.\w+)$/,`-${theme}$1`);
  return viewport?result.replace(/(\.\w+)$/,`-${viewport.width}x${viewport.height}$1`):result;
}
