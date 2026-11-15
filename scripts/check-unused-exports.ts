// Reports an exported declaration in a scanned package's `src/` that no other
// file in the repository imports (#2536).
//
// Why a gate: the api-report (tests/api-surface.test.ts) governs only names a
// package entry point reaches. A module-level `export` that no entry re-exports
// and no other file imports passed every gate, and a 2026-10-22 review found
// more than 200 of them in the three ui packages. A hand clean-up regrows.
//
// What counts as a use is read from the import graph, not from a name grep: the
// TypeScript compiler API parses every tracked source file in the repository,
// and each import, re-export, `import("…")` type and dynamic import is resolved
// to the file it names. A name is used when another file imports it from the
// declaring file directly, or through any chain of re-exports. A namespace
// import, `export *` from an entry, a dynamic `import()` or a `require()` of a
// file marks every export of that file used, because which names it reads is
// not visible syntactically. So does loading a file by path (`new URL(…,
// import.meta.url)`, `Bun.resolveSync`, `import.meta.resolve`), and so does a
// file that publishes its own `const url = import.meta.url` for a loader.
//
// What is never reported, by rule rather than by allowlist entry:
//
//   - a package entry point's own exports (the package.json `exports` targets):
//     tests/api-surface.test.ts governs those, and their re-exports count as
//     uses of the declarations they forward;
//   - a declaration the package's `api-report/<package>.txt` records in its
//     signatures section: a type reachable from a public signature is public
//     with it (docs/decisions/public-export-boundary.md, "Public");
//   - test, spec and story files under `src/`, whose exports a runner reads.
//
// Anything else that must stay exported needs an ALLOWLIST entry below with a
// one-line reason. A stale entry fails the gate, so the list cannot outlive the
// export it excuses.
//
// The scanned package list is explicit. Other workspace packages are not
// scanned: adding one is a reviewed change to SCANNED_PACKAGES.
//
//   bun scripts/check-unused-exports.ts [root] [--json]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

/** The packages (directory names under packages/) whose `src/` is scanned. */
export const SCANNED_PACKAGES = ["ui-server", "ui-kit", "ui-react"] as const;

export interface AllowlistEntry { file: string; name: string; reason: string }

// The import graph cannot see one kind of use: another file's exported
// declaration whose type is *inferred* through this name. No file imports the
// name, yet dropping its export makes that file's declaration emit fail with
// TS4023/TS4058 ("has or is using name … but cannot be named"), the same
// failure #2534 found for ui-sdk's internal entry. Each entry below names the
// declaration whose emit needs it; the package's tsconfig.build.json proves it.
const INFERRED = (by: string) => `inferred into the emitted declaration of ${by}; dropping the export fails declaration emit (TS4023/TS4058)`;

/** Exports that stay although no other file imports them, each with its reason. */
export const ALLOWLIST: AllowlistEntry[] = [
  { file: "packages/ui-react/src/stores/follow-up-state.ts", name: "FollowUpState", reason: INFERRED("useFollowUpStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/graph-state.ts", name: "GraphState", reason: INFERRED("useGraphStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/handoff-state.ts", name: "HandoffState", reason: INFERRED("useHandoffStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/inbox-state.ts", name: "InboxState", reason: INFERRED("useInboxStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/mask-state.ts", name: "MaskState", reason: INFERRED("useMaskStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/principal-state.ts", name: "PrincipalState", reason: INFERRED("usePrincipalStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/session-list-state.ts", name: "SessionListState", reason: INFERRED("createBrainStores") },
  { file: "packages/ui-react/src/stores/share-state.ts", name: "ShareIntakeState", reason: INFERRED("useShareStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/tracker-state.ts", name: "TrackerStoreState", reason: INFERRED("createBrainStores") },
  { file: "packages/ui-server/src/inbox/cleanup.ts", name: "CleanupReport", reason: INFERRED("createInboxRuntime") },
  { file: "packages/ui-server/src/inbox/cleanup.ts", name: "CleanupRequest", reason: INFERRED("createInboxRuntime") },
  // Readers of source text rather than importers.
  { file: "packages/ui-server/src/bin/brain-ui-cron.ts", name: "USAGE", reason: "tests/release-manifest.test.ts reads the subcommand list from the `export const USAGE` source text" },
  ...["listSpecFromInput", "formSpecFromInput", "rankSpecFromInput"].map(name => ({
    file: "packages/ui-react/src/hooks/websocket-handlers/chat.ts", name,
    reason: "scripts/source-browser-dispatch.ts pins this file's sha256; an edit needs a reviewed re-pin there",
  })),
];

export interface Finding { file: string; line: number; name: string; kind: "declaration" | "re-export" }

export interface Report {
  schemaVersion: 1;
  packages: string[];
  scannedFiles: number;
  findings: Finding[];
  allowlisted: AllowlistEntry[];
  staleAllowlist: AllowlistEntry[];
}

const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/;
const ALL = "*";

/** One file's exports, in the shape the usage propagation needs. */
interface ModuleInfo {
  /** Exported name -> line, for declarations and local export lists. */
  local: Map<string, number>;
  /** Exported name -> the file and name it forwards (`export { a as b } from`). */
  forwards: Map<string, { file: string; name: string; line: number }>;
  /** `export * from` targets. */
  stars: string[];
}

interface Graph {
  modules: Map<string, ModuleInfo>;
  /** File -> names other files import from it directly. */
  uses: Map<string, Set<string>>;
}

/** Every tracked or untracked-but-not-ignored file, repository-relative. */
function listFiles(root: string): string[] {
  const run = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (run.exitCode !== 0) throw new Error(`git ls-files failed: ${run.stderr.toString()}`);
  return run.stdout.toString().split("\0").filter(file => file && existsSync(join(root, file)));
}

/** `@schlessera/brain-<name>[/sub]` -> repository-relative source file. */
function packageEntries(root: string, files: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const manifest of files.filter(file => /^packages\/[^/]+\/package\.json$/.test(file))) {
    const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    const dir = dirname(manifest);
    for (const [subpath, target] of Object.entries<unknown>(pkg.exports ?? {})) {
      const file = typeof target === "string" ? target : (target as Record<string, unknown>)?.bun;
      if (typeof file !== "string" || !SOURCE.test(file) || subpath.includes("*")) continue;
      entries.set(subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`, join(dir, file));
    }
  }
  return entries;
}

function makeResolver(files: Set<string>, entries: Map<string, string>) {
  const candidates = (base: string) => {
    const stripped = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    return [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".jsx"].map(ext => stripped + ext),
      ...["ts", "tsx", "js"].map(ext => `${base}/index.${ext}`)];
  };
  return (from: string, specifier: string): string | undefined => {
    if (entries.has(specifier)) return entries.get(specifier);
    if (!specifier.startsWith(".")) return undefined;
    const base = join(dirname(from), specifier);
    return candidates(base).find(file => files.has(file));
  };
}

const exported = (node: ts.Node) => ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node) => ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.DefaultKeyword);

function bindingNames(name: ts.BindingName, out: string[]) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
}

function buildGraph(root: string, files: string[], entries: Map<string, string>): Graph {
  const fileSet = new Set(files);
  const resolveSpecifier = makeResolver(fileSet, entries);
  const modules = new Map<string, ModuleInfo>();
  const uses = new Map<string, Set<string>>();
  const use = (file: string | undefined, name: string) => {
    if (!file) return;
    let set = uses.get(file);
    if (!set) uses.set(file, set = new Set());
    set.add(name);
  };

  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, kind);
    const info: ModuleInfo = { local: new Map(), forwards: new Map(), stars: [] };
    modules.set(file, info);
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const target = (specifier: ts.Expression | undefined) =>
      specifier && ts.isStringLiteralLike(specifier) ? resolveSpecifier(file, specifier.text) : undefined;

    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const from = target(statement.moduleSpecifier);
        const clause = statement.importClause;
        if (!from || !clause) continue;
        if (clause.name) use(from, "default");
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) use(from, ALL);
        else if (bindings) for (const element of bindings.elements) use(from, (element.propertyName ?? element.name).text);
      } else if (ts.isExportDeclaration(statement)) {
        const from = target(statement.moduleSpecifier);
        const clause = statement.exportClause;
        if (statement.moduleSpecifier) {
          if (!from) continue;
          if (!clause) info.stars.push(from);
          else if (ts.isNamespaceExport(clause)) info.forwards.set(clause.name.text, { file: from, name: ALL, line: lineOf(statement) });
          else for (const element of clause.elements) {
            info.forwards.set(element.name.text, { file: from, name: (element.propertyName ?? element.name).text, line: lineOf(element) });
          }
        } else if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) info.local.set(element.name.text, lineOf(element));
        }
      } else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        declaration.initializer && ts.isPropertyAccessExpression(declaration.initializer) &&
        ts.isMetaProperty(declaration.initializer.expression) && declaration.initializer.name.text === "url")) {
        // `const url = import.meta.url`: the module publishes its own URL so a
        // loader can import it by path (the ui-server write-procedure modules,
        // whose `setup` the write worker reads). Every export is reachable.
        use(file, ALL);
        if (exported(statement)) for (const declaration of statement.declarationList.declarations) {
          const names: string[] = [];
          bindingNames(declaration.name, names);
          for (const name of names) info.local.set(name, lineOf(statement));
        }
      } else if (ts.isExportAssignment(statement)) {
        info.local.set("default", lineOf(statement));
      } else if (exported(statement)) {
        const line = lineOf(statement);
        if (isDefault(statement)) info.local.set("default", line);
        else if (ts.isVariableStatement(statement)) {
          const names: string[] = [];
          for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
          for (const name of names) info.local.set(name, line);
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
          statement.name && ts.isIdentifier(statement.name)) {
          info.local.set(statement.name.text, line);
        }
      }
    }

    // Uses that are not top-level statements: `import("…")`, `require("…")`
    // and `import("…").Name` types, and a module loaded by path —
    // `new URL("./x", import.meta.url)`, `Bun.resolveSync("./x", …)` or
    // `import.meta.resolve("./x")` — whose exports a worker, a loader or
    // generated source reads. A template path counts up to its first `${`.
    const loadedByPath = (argument: ts.Expression | undefined) => {
      const text = argument && (ts.isStringLiteralLike(argument) ? argument.text : ts.isTemplateExpression(argument) ? argument.head.text : undefined);
      if (text) use(resolveSpecifier(file, text), ALL);
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.length > 0 &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        use(target(node.arguments[0]), ALL);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ((node.expression.name.text === "resolveSync" && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Bun") ||
         (node.expression.name.text === "resolve" && ts.isMetaProperty(node.expression.expression)))) {
        loadedByPath(node.arguments[0]);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" &&
        node.arguments?.[1] && ts.isPropertyAccessExpression(node.arguments[1]) && ts.isMetaProperty(node.arguments[1].expression)) {
        loadedByPath(node.arguments[0]);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        const from = target(node.argument.literal as ts.Expression);
        const qualifier = node.qualifier;
        if (!qualifier) use(from, ALL);
        else {
          let first: ts.EntityName = qualifier;
          while (ts.isQualifiedName(first)) first = first.left;
          use(from, first.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { modules, uses };
}

/** Every (file, name) pair some other file reaches, following re-export chains. */
function propagate(graph: Graph, publicFiles: Iterable<string>): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  const queue: Array<[string, string]> = [];
  const mark = (file: string, name: string) => {
    let set = used.get(file);
    if (!set) used.set(file, set = new Set());
    if (set.has(name) || set.has(ALL)) return;
    set.add(name);
    queue.push([file, name]);
  };
  for (const [file, names] of graph.uses) for (const name of names) mark(file, name);
  for (const file of publicFiles) mark(file, ALL);
  while (queue.length > 0) {
    const [file, name] = queue.pop()!;
    const info = graph.modules.get(file);
    if (!info) continue;
    if (name === ALL) {
      for (const forward of info.forwards.values()) mark(forward.file, forward.name);
      for (const star of info.stars) mark(star, ALL);
      continue;
    }
    const forward = info.forwards.get(name);
    if (forward) mark(forward.file, forward.name);
    else if (!info.local.has(name)) for (const star of info.stars) mark(star, name);
  }
  return used;
}

/** (file, name) pairs the api-report signatures section records. */
function reportedSignatures(root: string, pkg: string): Set<string> {
  const path = join(root, "api-report", `${pkg}.txt`);
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  let inSignatures = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (/^signatures\b/.test(line)) { inSignatures = true; continue; }
    if (/^\S/.test(line)) inSignatures = false;
    const match = inSignatures && line.match(/^ {2}([A-Za-z_$][\w$]*) \(([^)]+)\)$/);
    if (match) out.add(`${match[2]}\0${match[1]}`);
  }
  return out;
}

export interface CheckOptions {
  packages?: readonly string[];
  allowlist?: AllowlistEntry[];
  /** Repository-relative files to read instead of `git ls-files` (tests). */
  files?: string[];
}

export function check(root: string, options: CheckOptions = {}): Report {
  const packages = options.packages ?? SCANNED_PACKAGES;
  const allowlist = options.allowlist ?? ALLOWLIST;
  const listed = options.files ?? listFiles(root);
  const files = listed.filter(file => SOURCE.test(file) && !file.endsWith(".d.ts"));
  const entries = packageEntries(root, listed);
  const graph = buildGraph(root, files, entries);
  const entryFiles = new Set(entries.values());
  const used = propagate(graph, entryFiles);
  const allowed = new Map(allowlist.map(entry => [`${entry.file}\0${entry.name}`, entry]));
  const findings: Finding[] = [];
  const allowlisted: AllowlistEntry[] = [];
  let scannedFiles = 0;

  for (const pkg of packages) {
    const signatures = reportedSignatures(root, pkg);
    const prefix = `packages/${pkg}/src/`;
    for (const file of files) {
      if (!file.startsWith(prefix) || TEST_FILE.test(file) || entryFiles.has(file)) continue;
      scannedFiles++;
      const info = graph.modules.get(file)!;
      const reached = used.get(file) ?? new Set<string>();
      if (reached.has(ALL)) continue;
      const exports: Array<[string, number, Finding["kind"]]> = [
        ...[...info.local].map(([name, line]) => [name, line, "declaration"] as [string, number, Finding["kind"]]),
        ...[...info.forwards].map(([name, f]) => [name, f.line, "re-export"] as [string, number, Finding["kind"]]),
      ];
      for (const [name, line, kind] of exports) {
        if (reached.has(name) || signatures.has(`${file}\0${name}`)) continue;
        const entry = allowed.get(`${file}\0${name}`);
        if (entry) { allowlisted.push(entry); continue; }
        findings.push({ file, line, name, kind });
      }
    }
  }
  const hit = new Set(allowlisted);
  const staleAllowlist = allowlist.filter(entry => !hit.has(entry));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { schemaVersion: 1, packages: [...packages], scannedFiles, findings, allowlisted, staleAllowlist };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const root = resolve(args.find(arg => !arg.startsWith("--")) ?? join(import.meta.dir, ".."));
  const report = check(root);
  const failed = report.findings.length > 0 || report.staleAllowlist.length > 0;
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const f of report.findings) {
      console.error(`${f.file}:${f.line}: \`${f.name}\` is exported but no other file imports it — drop the export, delete it, or allowlist it with a reason in scripts/check-unused-exports.ts`);
    }
    for (const entry of report.staleAllowlist) {
      console.error(`scripts/check-unused-exports.ts: stale allowlist entry ${entry.file} \`${entry.name}\` — it is imported, recorded, or gone; remove the entry`);
    }
    if (!failed) {
      console.log(`unused exports: ${report.scannedFiles} files in ${report.packages.join(", ")} clean (${report.allowlisted.length} allowlisted)`);
    }
  }
  process.exit(failed ? 1 : 0);
}
