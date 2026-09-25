// Writes a checked-in report of every package's public API surface —
// the exported names per export subpath, split into runtime values and
// type-only exports — and, for the frozen set (`SEAMS` below), the declared
// signature of each declaration.
//
// Why: core's `.` export grew to 136 lines of re-exports one reasonable PR at
// a time, because the surface had no artifact a reviewer could see change. The
// reports under api-report/ are that artifact: any surface change shows up as
// a diff in review, and tests/api-surface.test.ts fails when the sources and
// the checked-in reports disagree.
//
// Names alone miss a retype: in 0.37.0 `DEFAULT_CONFIRM_BASH_PATTERNS` went
// from `readonly string[]` to `readonly ConfirmPattern[]` and the report did
// not move. So the seams also get their declarations printed, and the types
// those declarations are made of, transitively. A retyped member is then a
// changed line in the report like an added export is.
//
// The surface is derived STATICALLY with the TypeScript compiler API — the
// packages are never imported. ui-react is browser code and core/ui-server
// pull `bun:sqlite`; importing them here would tie this report to a runtime.
//
// Regenerate: bun run api-report

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const REPORT_DIR = join(ROOT, "api-report");

/**
 * The frozen set: the seams `docs/extending/README.md` documents, by package
 * directory and export subpath. Their signatures are recorded together with
 * every type declared in this repo that they reference, directly or through
 * another such type. Which other exports 1.0 freezes is not decided yet
 * (schlessera/brain-kit#343); widen this list when it is.
 */
const SEAMS: Record<string, Record<string, string[]>> = {
  core: { ".": ["AgentRunner", "CompletionProvider", "EmbeddingProvider", "SkillEmitter"] },
  scrape: { ".": ["SiteAdapter"] },
  "ui-sdk": {
    "./client": ["AsrClient", "ToolRenderer"],
    "./server": ["AgentBackend", "BackendModule", "SpeechProvider"],
  },
};

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, string | Record<string, string>>;
}

interface Entry {
  subpath: string;
  target: string; // as written in package.json
  file: string | null; // absolute path when it is TypeScript source, else null
}

function publishablePackages(): { dir: string; manifest: Manifest }[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dir: e.name,
      manifest: JSON.parse(
        readFileSync(join(PACKAGES_DIR, e.name, "package.json"), "utf8")
      ) as Manifest,
    }))
    .filter((p) => !p.manifest.private);
}

/** The source file behind one export subpath — the `bun` condition, which is
 * the TypeScript entry all other conditions are built from. */
function entriesOf(dir: string, manifest: Manifest): Entry[] {
  const entries: Entry[] = [];
  for (const [subpath, value] of Object.entries(manifest.exports ?? {}).sort()) {
    const target = typeof value === "string" ? value : value.bun ?? value.default;
    const isSource = /\.(ts|tsx)$/.test(target ?? "");
    entries.push({
      subpath,
      target,
      file: isSource ? join(PACKAGES_DIR, dir, target) : null,
    });
  }
  return entries;
}

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error("could not read tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true };
}

/** `export type { X }` / `export { type X }` strips the value even when X's
 * declaration has one. */
function isTypeOnlyExport(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (decl) =>
      ts.isExportSpecifier(decl) && (decl.isTypeOnly || decl.parent.parent.isTypeOnly)
  );
}

/** `value` or `type` for one export symbol, resolving alias chains. */
function classify(checker: ts.TypeChecker, symbol: ts.Symbol): "value" | "type" {
  if (isTypeOnlyExport(symbol)) return "type";
  let resolved = symbol;
  if (resolved.flags & ts.SymbolFlags.Alias) {
    try {
      resolved = checker.getAliasedSymbol(resolved);
    } catch {
      return "value"; // unresolved external; assume the stronger claim
    }
  }
  return resolved.flags & ts.SymbolFlags.Value ? "value" : "type";
}

/** Starts the signature section of a report; tests/api-surface.test.ts splits
 * on it so a retype fails its own test. */
export const SIGNATURES_HEADING =
  "signatures (the seams in docs/extending/README.md and the types they are made of)";

type Declaration =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.VariableDeclaration;

function isRecordable(node: ts.Node): node is Declaration {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node)
  );
}

/** Declarations of a symbol that live in this repo's package sources. */
function ownDeclarations(checker: ts.TypeChecker, symbol: ts.Symbol): Declaration[] {
  let resolved = symbol;
  if (resolved.flags & ts.SymbolFlags.Alias) resolved = checker.getAliasedSymbol(resolved);
  if (resolved.flags & ts.SymbolFlags.TypeParameter) return [];
  return (resolved.declarations ?? []).filter(
    (decl): decl is Declaration =>
      isRecordable(decl) &&
      decl.getSourceFile().fileName.startsWith(PACKAGES_DIR + "/") &&
      !decl.getSourceFile().fileName.includes("/node_modules/")
  );
}

/** Every symbol a declaration names in a type position: type references,
 * heritage clauses, and `typeof x` queries. */
function referencedSymbols(checker: ts.TypeChecker, decl: Declaration): ts.Symbol[] {
  const found: ts.Symbol[] = [];
  const visit = (node: ts.Node): void => {
    let name: ts.Node | undefined;
    if (ts.isTypeReferenceNode(node)) name = node.typeName;
    else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
    else if (ts.isTypeQueryNode(node)) name = node.exprName;
    if (name) {
      const symbol = checker.getSymbolAtLocation(
        ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name
      );
      if (symbol) found.push(symbol);
    }
    // A function body or an initializer is implementation, not signature.
    if (ts.isBlock(node)) return;
    ts.forEachChild(node, visit);
  };
  if (ts.isVariableDeclaration(decl)) {
    if (decl.type) visit(decl.type);
  } else {
    ts.forEachChild(decl, visit);
  }
  return found;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** The declaration as a signature: comments dropped, formatting normalized,
 * bodies and private members removed. */
function printSignature(checker: ts.TypeChecker, decl: Declaration): string {
  const source = decl.getSourceFile();
  const f = ts.factory;
  // `async` and a default value are implementation; what a caller sees is the
  // return type and an optional parameter.
  const modifiers = (mods: readonly ts.ModifierLike[] | undefined) =>
    mods?.filter((m) => m.kind !== ts.SyntaxKind.AsyncKeyword);
  const params = (list: readonly ts.ParameterDeclaration[]) =>
    list.map((p) =>
      p.initializer
        ? f.updateParameterDeclaration(
            p, p.modifiers, p.dotDotDotToken, p.name,
            p.questionToken ?? f.createToken(ts.SyntaxKind.QuestionToken), p.type, undefined
          )
        : p
    );
  if (ts.isFunctionDeclaration(decl)) {
    const bare = f.updateFunctionDeclaration(
      decl, modifiers(decl.modifiers), decl.asteriskToken, decl.name, decl.typeParameters,
      params(decl.parameters), decl.type, undefined
    );
    return printer.printNode(ts.EmitHint.Unspecified, bare, source);
  }
  if (ts.isVariableDeclaration(decl)) {
    // An unannotated constant (a zod schema, say) is recorded by the type it
    // infers to, since that is what a `typeof` reference to it means.
    const type =
      decl.type ??
      checker.typeToTypeNode(
        checker.getTypeAtLocation(decl),
        decl,
        ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.MultilineObjectLiterals
      )!;
    return `const ${decl.name.getText(source)}: ${printer.printNode(ts.EmitHint.Unspecified, type, source)};`;
  }
  if (ts.isClassDeclaration(decl)) {
    const members = decl.members
      .filter(
        (m) =>
          !ts.isClassStaticBlockDeclaration(m) &&
          !(ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private) &&
          !(m.name && ts.isPrivateIdentifier(m.name))
      )
      .map((m) => {
        if (ts.isMethodDeclaration(m))
          return f.updateMethodDeclaration(
            m, modifiers(m.modifiers), m.asteriskToken, m.name, m.questionToken, m.typeParameters,
            params(m.parameters), m.type, undefined
          );
        if (ts.isConstructorDeclaration(m))
          return f.updateConstructorDeclaration(m, m.modifiers, params(m.parameters), undefined);
        if (ts.isGetAccessorDeclaration(m))
          return f.updateGetAccessorDeclaration(m, m.modifiers, m.name, [], m.type, undefined);
        if (ts.isSetAccessorDeclaration(m))
          return f.updateSetAccessorDeclaration(m, m.modifiers, m.name, params(m.parameters), undefined);
        if (ts.isPropertyDeclaration(m))
          return f.updatePropertyDeclaration(m, m.modifiers, m.name, m.questionToken, m.type, undefined);
        return m;
      });
    const bare = f.updateClassDeclaration(
      decl, decl.modifiers, decl.name, decl.typeParameters, decl.heritageClauses, members
    );
    return printer.printNode(ts.EmitHint.Unspecified, bare, source);
  }
  return printer.printNode(ts.EmitHint.Unspecified, decl, source);
}

/** The signature lines of one package's seams and everything they are made
 * of, sorted by name so a moved declaration does not reorder the report. */
function signatureLines(
  checker: ts.TypeChecker,
  program: ts.Program,
  seams: Record<string, string[]>,
  entries: Entry[]
): string[] {
  const seen = new Set<Declaration>();
  const queue: Declaration[] = [];
  const enqueue = (decls: Declaration[]) => {
    for (const decl of decls) {
      if (seen.has(decl)) continue;
      seen.add(decl);
      queue.push(decl);
    }
  };

  for (const [subpath, names] of Object.entries(seams)) {
    const entry = entries.find((e) => e.subpath === subpath);
    if (!entry?.file) throw new Error(`SEAMS names export "${subpath}", which has no source entry`);
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry.file)!)!;
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const name of names) {
      const symbol = exports.find((s) => s.getName() === name);
      if (!symbol) throw new Error(`SEAMS names ${name}, which "${subpath}" does not export`);
      const decls = ownDeclarations(checker, symbol);
      if (decls.length === 0) throw new Error(`${name} has no declaration in packages/`);
      enqueue(decls);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const symbol of referencedSymbols(checker, queue[i])) {
      enqueue(ownDeclarations(checker, symbol));
    }
  }

  const blocks = [...seen].map((decl) => {
    const file = relative(ROOT, decl.getSourceFile().fileName);
    return {
      key: `${decl.name!.getText()} ${file}`,
      lines: [`  ${decl.name!.getText()} (${file})`,
        ...printSignature(checker, decl).split("\n").map((l) => `    ${l}`)],
    };
  });
  blocks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return blocks.flatMap((b) => b.lines);
}

/** Builds every package's report in one pass (one program, one lib parse). */
export function generateReports(): Map<string, string> {
  const packages = publishablePackages();
  const allEntries = new Map(packages.map((p) => [p.dir, entriesOf(p.dir, p.manifest)]));

  const rootNames = [...allEntries.values()]
    .flat()
    .map((e) => e.file)
    .filter((f): f is string => f !== null);
  const program = ts.createProgram(rootNames, compilerOptions());
  const checker = program.getTypeChecker();

  for (const dir of Object.keys(SEAMS)) {
    if (!allEntries.has(dir)) throw new Error(`SEAMS names packages/${dir}, which is not published`);
  }

  const reports = new Map<string, string>();
  for (const { dir, manifest } of packages) {
    const lines: string[] = [
      `# ${manifest.name} — public API surface (packages/${dir})`,
      "# Generated by \`bun run api-report\`; verified by tests/api-surface.test.ts.",
      "# A diff in this file is a public-surface change — review it as one.",
      "# Names marked \`type\` are type-only exports; the rest are runtime values.",
    ];
    for (const entry of allEntries.get(dir)!) {
      lines.push("", `export "${entry.subpath}" (${entry.target})${entry.file ? "" : " [asset]"}`);
      if (!entry.file) continue;
      const source = program.getSourceFile(entry.file);
      if (!source) throw new Error(`program did not load ${entry.file}`);
      const moduleSymbol = checker.getSymbolAtLocation(source);
      if (!moduleSymbol) throw new Error(`${entry.file} has no module symbol (no exports?)`);
      const names = checker
        .getExportsOfModule(moduleSymbol)
        .map((s) => ({ name: s.getName(), kind: classify(checker, s) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const { name, kind } of names) {
        lines.push(kind === "type" ? `  type ${name}` : `  ${name}`);
      }
    }
    const seams = SEAMS[dir];
    if (seams) {
      lines.push(
        "",
        SIGNATURES_HEADING,
        ...signatureLines(checker, program, seams, allEntries.get(dir)!)
      );
    }
    reports.set(`${dir}.txt`, lines.join("\n") + "\n");
  }
  return reports;
}

if (import.meta.main) {
  const reports = generateReports();
  mkdirSync(REPORT_DIR, { recursive: true });
  for (const [file, content] of reports) {
    writeFileSync(join(REPORT_DIR, file), content);
    console.log(`wrote ${relative(ROOT, join(REPORT_DIR, file))}`);
  }
  // A report whose package is gone would sit around asserting a surface that
  // no longer exists; sweep it.
  if (existsSync(REPORT_DIR)) {
    for (const file of readdirSync(REPORT_DIR)) {
      if (file.endsWith(".txt") && !reports.has(file)) {
        unlinkSync(join(REPORT_DIR, file));
        console.log(`removed stale ${relative(ROOT, join(REPORT_DIR, file))}`);
      }
    }
  }
}
