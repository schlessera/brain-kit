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
// A second pass finds code that only tests reach (#4677). The graph is
// propagated again with every test file (`isTestFile`) removed from the
// importing side, and a value declaration (a function, class, enum or
// variable) is reported as `test-only` when it was used in the first pass, has
// no use in the second, and its own file never references it: no production
// path can execute it. `evals/` counts as a test file here, so an eval's import
// is not a use. Type-only declarations, re-exports and `export { a }` names
// not declared in their own file are not reported by this pass; a declaration
// its own file also uses is production code with an extra test importer.
//
// Anything else that must stay exported needs an ALLOWLIST entry below with a
// one-line reason. A stale entry fails the gate, so the list cannot outlive the
// export it excuses. An entry excuses one finding kind: a `test-only` entry
// does not excuse the same name once it loses its last test importer, it goes
// stale instead. An entry that waits for another issue to delete or wire its
// name records that issue as its `owner`.
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

export interface AllowlistEntry {
  file: string;
  name: string;
  reason: string;
  /** The finding kind the entry excuses: absent for a plain unused export. */
  kind?: "test-only";
  /** The issue whose change deletes or wires the name, which deletes the entry. */
  owner?: string;
}

/**
 * Whether a file is a test, fixture, story or eval, whose import of a name is
 * not a production use. `evals/` counts: an eval harness is not production.
 */
export function isTestFile(file: string): boolean {
  return /^(?:tests|experiments|evals)\//.test(file) ||
    /^packages\/[^/]+\/(?:tests|stories|fixtures|evals|\.storybook)\//.test(file) ||
    /^scripts\/(?:skill-tests|fixtures)\//.test(file) ||
    TEST_FILE.test(file);
}

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
  { file: "packages/ui-react/src/stores/markup-state.ts", name: "MarkupState", reason: INFERRED("useMarkupStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/principal-state.ts", name: "PrincipalState", reason: INFERRED("usePrincipalStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/session-list-state.ts", name: "SessionListState", reason: INFERRED("createBrainStores") },
  { file: "packages/ui-react/src/stores/share-state.ts", name: "ShareIntakeState", reason: INFERRED("useShareStore and createBrainStores") },
  { file: "packages/ui-react/src/stores/tracker-state.ts", name: "TrackerStoreState", reason: INFERRED("createBrainStores") },
  { file: "packages/ui-server/src/inbox/cleanup.ts", name: "CleanupReport", reason: INFERRED("createInboxRuntime") },
  { file: "packages/ui-server/src/inbox/cleanup.ts", name: "CleanupRequest", reason: INFERRED("createInboxRuntime") },
  // Only tests (or evals) import these (`kind: "test-only"`). Entries are
  // grouped by owner, so each owning issue deletes one contiguous block.

  // Deliberate test seams and requalification inputs: no owner.
  { file: "packages/ui-server/src/middleware/auth.ts", name: "resetVerificationReservations", kind: "test-only", reason: "test seam: resets the module-level verification reservations between tests" },
  { file: "packages/ui-react/src/lib/client-environment.ts", name: "resetClientEnvironmentCache", kind: "test-only", reason: "test seam: clears the cached client environment between tests" },
  { file: "packages/ui-server/src/governance/extraction-classifier.ts", name: "policyFor", kind: "test-only", reason: "read by the extraction-classifier requalification eval under evals/" },
  { file: "packages/ui-server/src/governance/extraction-classifier.ts", name: "decide", kind: "test-only", reason: "read by the extraction-classifier requalification eval under evals/" },

  // Staged for the in-process schedule runner (#915), which wires them.
  { file: "packages/ui-server/src/schedules/admission.ts", name: "createScheduleAdmission", kind: "test-only", owner: "#915", reason: "staged for the schedule runner; #915 wires it into production" },
  { file: "packages/ui-server/src/schedules/time.ts", name: "cronInstantsBetween", kind: "test-only", owner: "#915", reason: "staged for the schedule runner; #915 wires it into production" },

  // #2524 removes the unrendered timeline.
  { file: "packages/ui-react/src/components/chat/tool-call-timeline.tsx", name: "ToolCallTimeline", kind: "test-only", owner: "#2524", reason: "production never renders it; #2524 removes or wires it" },

  // #2525 removes ui-react helpers only tests call.
  { file: "packages/ui-react/src/components/graph/graph-form.tsx", name: "SwitchRow", kind: "test-only", owner: "#2525", reason: "only tests call it; #2525 removes it" },
  { file: "packages/ui-react/src/lib/answer-delivery/tabs.ts", name: "createTabHub", kind: "test-only", owner: "#2525", reason: "only tests call it; #2525 removes it" },
  { file: "packages/ui-react/src/lib/graph-helpers.ts", name: "nodeSize", kind: "test-only", owner: "#2525", reason: "only tests call it; #2525 removes it" },
  { file: "packages/ui-react/src/lib/mermaid.ts", name: "inlineRenderedFences", kind: "test-only", owner: "#2525", reason: "only tests call it; #2525 removes it" },
  { file: "packages/ui-react/src/lib/trackers.ts", name: "trackerWords", kind: "test-only", owner: "#2525", reason: "only tests call it; #2525 removes it" },
  { file: "packages/ui-react/src/stores/graph-store.ts", name: "clearGraphSceneCache", kind: "test-only", owner: "#2525", reason: "only tests call it; #2525 removes it" },

  // #4682 wires or removes safety-detail pruning.
  { file: "packages/ui-server/src/governance/safety-store.ts", name: "pruneSafetyDetail", kind: "test-only", owner: "#4682", reason: "nothing in production prunes safety detail; #4682 wires or removes it" },

  // #4678 removes ui-server exports only tests reach.
  { file: "packages/ui-server/src/activity/ingestion-taint.ts", name: "outputTaintSource", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
  { file: "packages/ui-server/src/activity/ingestion-taint.ts", name: "INGESTION_DETECTOR_MANIFEST", kind: "test-only", owner: "#4678", reason: "only tests read it; #4678 removes it" },
  { file: "packages/ui-server/src/brain/journal-steering.ts", name: "journalSteeringInputs", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
  { file: "packages/ui-server/src/brain/maintenance-git-publication.ts", name: "gitPublicationAllowed", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
  { file: "packages/ui-server/src/brain/origin-trust.ts", name: "originTrustMatch", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
  { file: "packages/ui-server/src/classification/confidence-store.ts", name: "confidenceDistribution", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
  { file: "packages/ui-server/src/governance/events.ts", name: "GOVERNANCE_EVENT_KINDS", kind: "test-only", owner: "#4678", reason: "only tests read it; #4678 removes it" },
  { file: "packages/ui-server/src/middleware/tailscale.ts", name: "tailscaleGuard", kind: "test-only", owner: "#4678", reason: "only tests mount it; #4678 removes it" },
  { file: "packages/ui-server/src/share/staging.ts", name: "shareStagingRoot", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
  { file: "packages/ui-server/src/voice/conversation-history.ts", name: "conversationHistory", kind: "test-only", owner: "#4678", reason: "only tests call it; #4678 removes it" },
];

export interface Finding { file: string; line: number; name: string; kind: "declaration" | "re-export" | "test-only" }

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
  /** Exported local names declared as values (function, class, enum, variable). */
  values: Set<string>;
  /** Identifier texts the file references outside declaration and export names. */
  references: Set<string>;
  /** Exported name -> the file and name it forwards (`export { a as b } from`). */
  forwards: Map<string, { file: string; name: string; line: number }>;
  /** `export * from` targets. */
  stars: string[];
}

interface Graph {
  modules: Map<string, ModuleInfo>;
  /** Importing file -> (imported file -> names it imports from that file directly). */
  uses: Map<string, Map<string, Set<string>>>;
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

/** Resolves a relative or workspace-package specifier to a repository-relative file. */
export function makeResolver(files: Set<string>, entries: Map<string, string>) {
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

/**
 * Whether an identifier reads a binding: not a declaration's own name, an
 * import or export specifier, a property name after `.`, or a member or
 * property key. A shorthand `{ name }` reads the binding and counts.
 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) ||
    ts.isEnumMember(parent) || ts.isJsxAttribute(parent)) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isEnumDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isModuleDeclaration(parent) ||
    ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

function buildGraph(root: string, files: string[], entries: Map<string, string>): Graph {
  const fileSet = new Set(files);
  const resolveSpecifier = makeResolver(fileSet, entries);
  const modules = new Map<string, ModuleInfo>();
  const uses = new Map<string, Map<string, Set<string>>>();

  for (const file of files) {
    const fileUses = new Map<string, Set<string>>();
    uses.set(file, fileUses);
    const use = (target: string | undefined, name: string) => {
      if (!target) return;
      let set = fileUses.get(target);
      if (!set) fileUses.set(target, set = new Set());
      set.add(name);
    };
    const text = readFileSync(join(root, file), "utf8");
    const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, kind);
    const info: ModuleInfo = { local: new Map(), values: new Set(), references: new Set(), forwards: new Map(), stars: [] };
    // Top-level value declarations by name, so `export { a }` can be classified.
    const declaredValues = new Set<string>();
    const exportedList: string[] = [];
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
        } else if (clause && ts.isNamedExports(clause) && !statement.isTypeOnly) {
          for (const element of clause.elements) {
            info.local.set(element.name.text, lineOf(element));
            if (!element.isTypeOnly && !element.propertyName) exportedList.push(element.name.text);
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
          for (const name of names) { info.local.set(name, line); info.values.add(name); }
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
          statement.name && ts.isIdentifier(statement.name)) {
          info.local.set(statement.name.text, line);
          if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
            info.values.add(statement.name.text);
          }
        }
      }
      if (!exported(statement)) {
        if (ts.isVariableStatement(statement)) {
          const names: string[] = [];
          for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
          for (const name of names) declaredValues.add(name);
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
          statement.name) {
          declaredValues.add(statement.name.text);
        }
      }
    }
    for (const name of exportedList) if (declaredValues.has(name)) info.values.add(name);

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
      if (ts.isIdentifier(node) && isReference(node)) info.references.add(node.text);
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

/**
 * Every (file, name) pair some other file reaches, following re-export chains.
 * `counts` limits which files' imports and re-exports take part.
 */
function propagate(graph: Graph, publicFiles: Iterable<string>, counts: (file: string) => boolean = () => true): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  const queue: Array<[string, string]> = [];
  const mark = (file: string, name: string) => {
    let set = used.get(file);
    if (!set) used.set(file, set = new Set());
    if (set.has(name) || set.has(ALL)) return;
    set.add(name);
    queue.push([file, name]);
  };
  for (const [importer, targets] of graph.uses) {
    if (!counts(importer)) continue;
    for (const [file, names] of targets) for (const name of names) mark(file, name);
  }
  for (const file of publicFiles) mark(file, ALL);
  while (queue.length > 0) {
    const [file, name] = queue.pop()!;
    const info = graph.modules.get(file);
    if (!info || !counts(file)) continue;
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
  const usedOutsideTests = propagate(graph, entryFiles, file => !isTestFile(file));
  const allowed = new Map(allowlist.map(entry => [`${entry.kind ?? ""}\0${entry.file}\0${entry.name}`, entry]));
  const excuse = (kind: Finding["kind"], file: string, name: string) =>
    allowed.get(`${kind === "test-only" ? "test-only" : ""}\0${file}\0${name}`);
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
      const reachedOutsideTests = usedOutsideTests.get(file) ?? new Set<string>();
      const exports: Array<[string, number, Finding["kind"]]> = [
        ...[...info.local].map(([name, line]) => [name, line, "declaration"] as [string, number, Finding["kind"]]),
        ...[...info.forwards].map(([name, f]) => [name, f.line, "re-export"] as [string, number, Finding["kind"]]),
      ];
      for (const [name, line, declared] of exports) {
        if (signatures.has(`${file}\0${name}`)) continue;
        let kind: Finding["kind"] = declared;
        if (reached.has(ALL) || reached.has(name)) {
          // Used. Report it only if no production path can reach it.
          if (declared !== "declaration" || !info.values.has(name) || info.references.has(name) ||
            reachedOutsideTests.has(ALL) || reachedOutsideTests.has(name)) continue;
          kind = "test-only";
        }
        const entry = excuse(kind, file, name);
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
      if (f.kind === "test-only") {
        console.error(`${f.file}:${f.line}: \`${f.name}\` is imported only by tests and its own file never uses it, so no production path runs it — delete it with its tests, wire it, or allowlist it with \`kind: "test-only"\` and a reason in scripts/check-unused-exports.ts`);
      } else {
        console.error(`${f.file}:${f.line}: \`${f.name}\` is exported but no other file imports it — drop the export, delete it, or allowlist it with a reason in scripts/check-unused-exports.ts`);
      }
    }
    for (const entry of report.staleAllowlist) {
      const what = entry.kind === "test-only" ? "a production file uses it, its last test importer is gone, or it is gone" : "it is imported, recorded, or gone";
      console.error(`scripts/check-unused-exports.ts: stale ${entry.kind ?? ""}${entry.kind ? " " : ""}allowlist entry ${entry.file} \`${entry.name}\` — ${what}; remove the entry`);
    }
    if (!failed) {
      console.log(`unused exports: ${report.scannedFiles} files in ${report.packages.join(", ")} clean (${report.allowlisted.length} allowlisted)`);
    }
  }
  process.exit(failed ? 1 : 0);
}
