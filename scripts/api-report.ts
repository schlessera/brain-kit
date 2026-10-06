// Writes a checked-in report of every package's public API surface —
// the exported names per export subpath, split into runtime values and
// type-only exports — and the declared signature of every name a public
// entry point exports, with the types those signatures are made of.
//
// Why: core's `.` export grew to 136 lines of re-exports one reasonable PR at
// a time, because the surface had no artifact a reviewer could see change. The
// reports under api-report/ are that artifact: any surface change shows up as
// a diff in review, and tests/api-surface.test.ts fails when the sources and
// the checked-in reports disagree.
//
// Names alone miss a retype: in 0.37.0 `DEFAULT_CONFIRM_BASH_PATTERNS` went
// from `readonly string[]` to `readonly ConfirmPattern[]` and the report did
// not move. So every public declaration is printed, and the types it is made
// of, transitively. A retyped member is then a changed line in the report
// like an added export is. The supported surface includes the types reachable
// through public signatures (#343 question 1,
// docs/decisions/public-export-boundary.md), so the traversal is the
// compatibility check for them too.
//
// `./internal` entry points carry no compatibility promise: their names are
// listed, so a new internal export is still a reviewed diff, but their
// signatures are not recorded.
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
 * Export subpaths with no compatibility promise. Their names are reported;
 * their signatures are not, and a public signature may not reach a type that
 * only they export.
 */
export function isInternalSubpath(subpath: string): boolean {
  return subpath === "./internal" || subpath.startsWith("./internal/");
}

/**
 * The extension seams `docs/extending/README.md` documents, by package
 * directory and export subpath. Every public export is signature-tracked; this
 * list is what tests/api-surface.test.ts additionally asserts by shape, so a
 * seam that stopped being exported, or that came out with no declaration,
 * fails by name rather than as one line missing from a long report.
 */
export const SEAMS: Record<string, Record<string, string[]>> = {
  core: {
    ".": ["AgentRunner", "CompletionProvider", "EmbeddingProvider", "SkillEmitter", "SearchResult", "RerankCandidate"],
    "./queries": ["readGraphMeta", "readGraphClusters", "readGraphNeighborhood", "readGraphDiscovery", "readGraphMaintenance", "readLinkWalk", "readVoiceVocabulary", "listIndexDocuments", "findIndexDocuments", "ContentIndexQueries"],
  },
  scrape: { ".": ["SiteAdapter", "runAdapters", "ok", "partial"] },
  "module-jobs": { ".": ["JobAdapter"] },
  "ui-server": { ".": ["ServerConfig"] },
  "ui-sdk": {
    "./client": ["AsrClient", "AsrClientFactory", "AsrClientRegistry", "ToolRenderer"],
    "./server": [
      "AgentBackend", "BackendModule", "SpeechProvider",
      "decideToolPermission", "createToolPermissionRequest", "requestToolPermission",
      "checkEditedApproval", "compileConfirmPatterns",
    ],
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
  // Sorted: directory order differs between filesystems, and the order the
  // program loads its roots in is the order the checker creates types in.
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
  "signatures (every public export and the types it is made of)";

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
function ownDeclarations(checker: ts.TypeChecker, symbol: ts.Symbol, within: string): Declaration[] {
  let resolved = symbol;
  if (resolved.flags & ts.SymbolFlags.Alias) resolved = checker.getAliasedSymbol(resolved);
  if (resolved.flags & ts.SymbolFlags.TypeParameter) return [];
  return (resolved.declarations ?? []).filter(
    (decl): decl is Declaration =>
      isRecordable(decl) &&
      decl.getSourceFile().fileName.startsWith(within + "/") &&
      !decl.getSourceFile().fileName.includes("/node_modules/")
  );
}

const unionPrinter = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/**
 * The checker prints an inferred union's members in the order it created
 * their types, which depends on what it happened to check first (two CI
 * shards printed `"gold" | "teal"` and `"teal" | "gold"` for one type). The
 * members of a printed (synthesized) union are sorted by their text, so the
 * report records the type, not the checker's history. Written unions keep
 * their source order.
 */
function canonicalUnions<T extends ts.Node | undefined>(node: T): T {
  if (!node) return node;
  const sourceless = ts.createSourceFile("inferred.ts", "", ts.ScriptTarget.Latest);
  const text = (n: ts.Node) => unionPrinter.printNode(ts.EmitHint.Unspecified, n, sourceless);
  const canonical = (context: ts.TransformationContext) => {
    const visit = (n: ts.Node): ts.Node => {
      const updated = ts.visitEachChild(n, visit, context);
    const byText = <N extends ts.Node>(list: readonly N[]) =>
      [...list].sort((a, b) => {
        const x = text(a), y = text(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    if (ts.isUnionTypeNode(updated)) {
      return ts.factory.updateUnionTypeNode(updated, ts.factory.createNodeArray(byText(updated.types)));
    }
    // A mapped type over a union (a zod enum's record) lists its keys in the
    // same creation order; member order carries no meaning in a type.
    if (ts.isTypeLiteralNode(updated)) {
      return ts.factory.updateTypeLiteralNode(updated, ts.factory.createNodeArray(byText(updated.members)));
    }
    return updated;
    };
    return (root: ts.Node) => visit(root);
  };
  const result = ts.transform(node, [canonical]);
  const out = result.transformed[0] as T;
  result.dispose();
  return out;
}

/**
 * A class or interface member whose own JSDoc carries `@internal`: first-party
 * wiring that a public declaration has to expose to sibling modules (a field
 * the package's own composition reads), excluded from the supported surface
 * on the member itself. It is not recorded or walked, as a private member
 * is not. The tag is the compatibility statement; see
 * docs/decisions/public-export-boundary.md.
 */
function isInternalMember(member: ts.Node): boolean {
  return ts.getJSDocTags(member).some((tag) => tag.tagName.text === "internal");
}

/**
 * What a declaration shows its callers: the node that is printed AND walked
 * for the types it is made of, so the two cannot disagree. Bodies, `async`,
 * default values, property initializers and private class members are
 * implementation and are dropped. The members kept are the source's own
 * nodes, so the checker can still resolve the names inside them.
 *
 * An unannotated constant (a zod schema, say) is recorded by the type it
 * infers to, since that is what a `typeof` reference to it means, and so is
 * the inferred return type of a function or method (a React component's
 * `JSX.Element`). Those nodes are synthesized, so they are not walked as
 * source; the types they print are returned as `inferred`, and the repo's own
 * declarations those types name are followed like written references.
 */
function publicSurface(
  checker: ts.TypeChecker,
  decl: Declaration
): { node: ts.Node; walk: boolean; inferred: ts.Type[] } {
  const f = ts.factory;
  const inferred: ts.Type[] = [];
  const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.MultilineObjectLiterals;
  /** The written return type, or the inferred one printed and recorded. */
  const returnType = (fn: ts.SignatureDeclaration): ts.TypeNode | undefined => {
    if (fn.type) return fn.type;
    const signature = checker.getSignatureFromDeclaration(fn);
    if (!signature) return undefined;
    const type = checker.getReturnTypeOfSignature(signature);
    inferred.push(type);
    return canonicalUnions(checker.typeToTypeNode(type, fn, flags));
  };
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
    const node = f.updateFunctionDeclaration(
      decl, modifiers(decl.modifiers), decl.asteriskToken, decl.name, decl.typeParameters,
      params(decl.parameters), returnType(decl), undefined
    );
    return { node, walk: true, inferred };
  }
  if (ts.isVariableDeclaration(decl)) {
    if (decl.type) return { node: decl.type, walk: true, inferred };
    const type = checker.getTypeAtLocation(decl);
    const node = canonicalUnions(checker.typeToTypeNode(type, decl, flags)!);
    return { node, walk: false, inferred: [type] };
  }
  if (ts.isClassDeclaration(decl)) {
    const members = decl.members
      .filter(
        (m) =>
          !ts.isClassStaticBlockDeclaration(m) &&
          !(ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private) &&
          !(m.name && ts.isPrivateIdentifier(m.name)) &&
          !isInternalMember(m)
      )
      .map((m) => {
        if (ts.isMethodDeclaration(m))
          return f.updateMethodDeclaration(
            m, modifiers(m.modifiers), m.asteriskToken, m.name, m.questionToken, m.typeParameters,
            params(m.parameters), returnType(m), undefined
          );
        if (ts.isConstructorDeclaration(m))
          return f.updateConstructorDeclaration(m, m.modifiers, params(m.parameters), undefined);
        if (ts.isGetAccessorDeclaration(m))
          return f.updateGetAccessorDeclaration(m, m.modifiers, m.name, [], returnType(m), undefined);
        if (ts.isSetAccessorDeclaration(m))
          return f.updateSetAccessorDeclaration(m, m.modifiers, m.name, params(m.parameters), undefined);
        if (ts.isPropertyDeclaration(m))
          return f.updatePropertyDeclaration(m, m.modifiers, m.name, m.questionToken, m.type, undefined);
        return m;
      });
    const node = f.updateClassDeclaration(
      decl, decl.modifiers, decl.name, decl.typeParameters, decl.heritageClauses, members
    );
    return { node, walk: true, inferred };
  }
  if (ts.isInterfaceDeclaration(decl) && decl.members.some(isInternalMember)) {
    const node = f.updateInterfaceDeclaration(
      decl, decl.modifiers, decl.name, decl.typeParameters, decl.heritageClauses,
      decl.members.filter((m) => !isInternalMember(m))
    );
    return { node, walk: true, inferred };
  }
  return { node: decl, walk: true, inferred };
}

/** Every symbol a public surface names in a type position: type references,
 * inline `import("…").T` types, heritage clauses, and `typeof x` queries. */
function referencedSymbols(checker: ts.TypeChecker, surface: ts.Node): ts.Symbol[] {
  const found: ts.Symbol[] = [];
  const visit = (node: ts.Node): void => {
    let name: ts.Node | undefined;
    if (ts.isTypeReferenceNode(node)) name = node.typeName;
    else if (ts.isImportTypeNode(node)) name = node.qualifier;
    else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
    else if (ts.isTypeQueryNode(node)) name = node.exprName;
    if (name) {
      const symbol = checker.getSymbolAtLocation(
        ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name
      );
      if (symbol) found.push(symbol);
    }
    ts.forEachChild(node, visit);
  };
  visit(surface);
  return found;
}

/**
 * The report records what is WRITTEN, so it refuses a seam-reachable surface
 * where the type a caller sees is not written down. An inferred member type
 * would print as a bare `value;` and hide a retype, and a module-valued type
 * (`typeof import("x")`, `typeof ns`) names a whole module the traversal does
 * not follow. Each would pass the signature test while the surface moved.
 * Returns one line per problem, naming the declaration and its file:line.
 */
function unseeable(checker: ts.TypeChecker, decl: Declaration, surface: ts.Node): string[] {
  const problems: string[] = [];
  const where = (node: ts.Node) => {
    const original = ts.getOriginalNode(node);
    const at = original.pos >= 0 ? original : decl;
    const source = decl.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(at.getStart(source));
    return `${relative(ROOT, source.fileName)}:${line + 1}`;
  };
  const name = decl.name!.getText();
  const refuse = (node: ts.Node, what: string) =>
    problems.push(`${where(node)} ${name}: ${what}`);

  const visit = (node: ts.Node): void => {
    // A type node the checker printed for an inferred return type has no
    // source text; it is followed through its type instead (publicSurface).
    if (node.pos < 0 && ts.getOriginalNode(node) === node && node !== surface) return;
    if (ts.isParameter(node) && !node.type) {
      refuse(node, `parameter \`${node.name.getText()}\` has no type annotation`);
    } else if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isGetAccessorDeclaration(node)) &&
      !node.type
    ) {
      refuse(node, `\`${node.name?.getText() ?? "function"}\` has no return type annotation`);
    } else if (ts.isPropertyDeclaration(node) && !node.type) {
      refuse(node, `property \`${node.name.getText()}\` has no type annotation`);
    } else if (ts.isImportTypeNode(node) && !node.qualifier) {
      refuse(node, `\`${node.getText()}\` is a whole module; name the export it uses instead`);
    } else if (ts.isTypeQueryNode(node)) {
      let symbol = checker.getSymbolAtLocation(
        ts.isQualifiedName(node.exprName) ? node.exprName.right : node.exprName
      );
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      // A value that also merges with a namespace (`typeof fetch`) is a
      // value query, not a module one.
      if (symbol && symbol.flags & ts.SymbolFlags.Module && !(symbol.flags & ts.SymbolFlags.Value & ~ts.SymbolFlags.ValueModule)) {
        refuse(node, `\`typeof ${node.exprName.getText()}\` is a whole module; name the export it uses instead`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(surface);
  return problems;
}

/**
 * The repo's own named declarations an inferred type reaches: through alias
 * and type arguments, unions and intersections, and the members of anonymous
 * object types. A named type declared outside the repo (a zod schema class,
 * `Promise`) is followed only through its type arguments.
 */
function ownNamedTypesIn(checker: ts.TypeChecker, type: ts.Type, within: string): Declaration[] {
  const found = new Set<Declaration>();
  const visited = new Set<ts.Type>();
  const isOwn = (d: ts.Declaration) =>
    d.getSourceFile().fileName.startsWith(within + "/") &&
    !d.getSourceFile().fileName.includes("/node_modules/");
  const visit = (t: ts.Type): void => {
    if (visited.has(t)) return;
    visited.add(t);
    let named = false;
    for (const symbol of [t.aliasSymbol, t.getSymbol()]) {
      for (const d of symbol?.declarations ?? []) {
        if (isRecordable(d) && isOwn(d)) found.add(d);
        if (isRecordable(d)) named = true;
      }
    }
    t.aliasTypeArguments?.forEach(visit);
    if (t.isUnionOrIntersection()) t.types.forEach(visit);
    if (t.flags & ts.TypeFlags.Object) {
      const object = t as ts.ObjectType;
      if (object.objectFlags & ts.ObjectFlags.Reference) {
        checker.getTypeArguments(t as ts.TypeReference).forEach(visit);
      }
      if (!named) {
        for (const prop of checker.getPropertiesOfType(t)) visit(checker.getTypeOfSymbol(prop));
        for (const info of checker.getIndexInfosOfType(t)) visit(info.type);
        for (const sig of [...t.getCallSignatures(), ...t.getConstructSignatures()]) {
          for (const param of sig.getParameters()) visit(checker.getTypeOfSymbol(param));
          visit(sig.getReturnType());
        }
      }
    }
  };
  visit(type);
  return [...found];
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** The declaration as a signature: its public surface, comments dropped and
 * formatting normalized. */
function printSignature(checker: ts.TypeChecker, decl: Declaration): string {
  const source = decl.getSourceFile();
  const { node } = publicSurface(checker, decl);
  const printed = printer.printNode(ts.EmitHint.Unspecified, node, source);
  return ts.isVariableDeclaration(decl) ? `const ${decl.name.getText(source)}: ${printed};` : printed;
}

/** The npm package an export resolves to, when it is declared only there. */
function externalPackageOf(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
  let resolved = symbol;
  if (resolved.flags & ts.SymbolFlags.Alias) resolved = checker.getAliasedSymbol(resolved);
  const files = (resolved.declarations ?? []).map((d) => d.getSourceFile().fileName);
  if (files.length === 0 || !files.every((f) => f.includes("/node_modules/"))) return undefined;
  const match = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(files[0]);
  return match?.[1];
}

/**
 * Where a declaration is already recorded: the report of the package that
 * declares it and exports it from a public entry point, when that is not the
 * report being built. Such a declaration is referenced, not printed again, so
 * each public declaration has exactly one owning report.
 */
type RecordedElsewhere = (decl: Declaration) => string | undefined;

/** The signature lines of one package's public exports and everything they
 * are made of, sorted by name so a moved declaration does not reorder the
 * report. */
function signatureLines(
  checker: ts.TypeChecker,
  program: ts.Program,
  seeds: { file: string; names: string[] }[],
  within: string,
  elsewhere: RecordedElsewhere = () => undefined
): string[] {
  const seen = new Set<Declaration>();
  const queue: Declaration[] = [];
  const references = new Map<string, string[]>();
  const enqueue = (decls: Declaration[]) => {
    for (const decl of decls) {
      if (seen.has(decl) || elsewhere(decl)) continue;
      seen.add(decl);
      queue.push(decl);
    }
  };

  for (const { file, names } of seeds) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`program did not load ${file}`);
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
    for (const name of names) {
      const symbol = exports.find((s) => s.getName() === name);
      if (!symbol) throw new Error(`${relative(ROOT, file)} does not export ${name}`);
      const decls = ownDeclarations(checker, symbol, within);
      const external = decls.length === 0 ? externalPackageOf(checker, symbol) : undefined;
      if (external) {
        // A third-party re-export: its shape is that dependency's, versioned
        // by the dependency range. Recording where it comes from still shows
        // a re-export that switches source.
        references.set(`${name} ${external}`, [`  ${name} re-exported from ${external}`]);
        continue;
      }
      if (decls.length === 0) {
        throw new Error(
          `${name} (exported by ${relative(ROOT, file)}) has no declaration the report can ` +
            `print under ${relative(ROOT, within)}; export a named, annotated declaration instead`
        );
      }
      for (const decl of decls) {
        const declName = decl.name!.getText();
        const declFile = relative(ROOT, decl.getSourceFile().fileName);
        if (declName !== name) {
          // `export { x as y }`, `export default x`: the block below is
          // printed under the declaration's name, so say which one it is.
          references.set(`${name} ${declFile}`, [`  ${name} (${declFile}) exported name of ${declName}`]);
        }
        const owner = elsewhere(decl);
        if (!owner) continue;
        // A re-export of another package's public declaration: name where it
        // is recorded, so a re-export that switches its source still shows.
        references.set(`${declName} ${declFile}`, [`  ${declName} (${declFile}) recorded in api-report/${owner}.txt`]);
      }
      enqueue(decls);
    }
  }
  const problems: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const decl = queue[i];
    const { node, walk, inferred } = publicSurface(checker, decl);
    // An inferred type prints in full, which would hide a retype of a
    // declaration of this repo that it names: printed by name, its own shape
    // is not in the line. Follow those declarations so their own blocks are
    // recorded, as a written reference would be.
    for (const type of inferred) enqueue(ownNamedTypesIn(checker, type, within));
    if (!walk) continue;
    problems.push(...unseeable(checker, decl, node));
    for (const symbol of referencedSymbols(checker, node)) {
      enqueue(ownDeclarations(checker, symbol, within));
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "api-report cannot record these public-reachable types, so a change to them " +
        "would pass unseen. Write the type down:\n  " +
        problems.join("\n  ")
    );
  }

  const blocks = [...seen].map((decl) => {
    const file = relative(ROOT, decl.getSourceFile().fileName);
    return {
      key: `${decl.name!.getText()} ${file}`,
      lines: [`  ${decl.name!.getText()} (${file})`,
        ...printSignature(checker, decl).split("\n").map((l) => `    ${l}`)],
    };
  });
  for (const [key, lines] of references) {
    if (!blocks.some((b) => b.key === key)) blocks.push({ key, lines });
  }
  blocks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return blocks.flatMap((b) => b.lines);
}

/** The signature section for seeds in arbitrary source files, counting only
 * declarations under `within` as this repo's own. For tests of the traversal
 * itself; the reports go through `generateReports`. */
export function seamSignatures(
  seeds: { file: string; names: string[] }[],
  within: string
): string[] {
  const program = ts.createProgram(
    seeds.map((s) => s.file),
    compilerOptions()
  );
  return signatureLines(program.getTypeChecker(), program, seeds, within);
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

  // Every public entry point's exported names, and the package whose report
  // owns each declaration: the package that declares it, when it exports it
  // from a public entry point. Another report that reaches it references it.
  const publicSeeds = new Map<string, { file: string; names: string[] }[]>();
  const owners = new Map<Declaration, string>();
  for (const { dir } of packages) {
    const seeds: { file: string; names: string[] }[] = [];
    for (const entry of allEntries.get(dir)!) {
      if (!entry.file || isInternalSubpath(entry.subpath)) continue;
      const source = program.getSourceFile(entry.file);
      if (!source) throw new Error(`program did not load ${entry.file}`);
      const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
      seeds.push({ file: entry.file, names: exports.map((s) => s.getName()).sort() });
      for (const symbol of exports) {
        for (const decl of ownDeclarations(checker, symbol, PACKAGES_DIR)) {
          const declDir = relative(PACKAGES_DIR, decl.getSourceFile().fileName).split("/")[0];
          if (declDir === dir) owners.set(decl, dir);
        }
      }
    }
    publicSeeds.set(dir, seeds);
  }

  const failures: string[] = [];
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
    const seeds = publicSeeds.get(dir)!;
    for (const [subpath, names] of Object.entries(SEAMS[dir] ?? {})) {
      const entry = allEntries.get(dir)!.find((e) => e.subpath === subpath);
      if (!entry?.file || isInternalSubpath(subpath)) {
        throw new Error(`SEAMS names export "${subpath}" of packages/${dir}, which is not a public source entry`);
      }
      const seed = seeds.find((s) => s.file === entry.file)!;
      for (const name of names) {
        if (!seed.names.includes(name)) throw new Error(`SEAMS names ${name}, which ${entry.target} does not export`);
      }
    }
    if (seeds.some((seed) => seed.names.length > 0)) {
      let signatures: string[];
      try {
        signatures = signatureLines(checker, program, seeds, PACKAGES_DIR, (decl) => {
          const owner = owners.get(decl);
          return owner && owner !== dir ? owner : undefined;
        });
      } catch (error) {
        failures.push(`packages/${dir}: ${(error as Error).message}`);
        signatures = [];
      }
      lines.push("", SIGNATURES_HEADING, ...signatures);
    }
    reports.set(`${dir}.txt`, lines.join("\n") + "\n");
  }
  if (failures.length > 0) throw new Error(failures.join("\n\n"));
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
