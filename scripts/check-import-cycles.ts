// Refuses a runtime import cycle between the source files of a package (#4816).
//
// A module in a cycle that reads a partner's binding in a top-level statement
// throws `Cannot access … before initialization`, and only for the entry order
// that loads it first (#2148 was that failure in ui-sdk). Two processes that
// load the same files from different entry points — the ui-server host loads a
// store first, its write worker the store's write module — can disagree.
//
// The gate builds the static value-import graph of every file under
// `packages/*/src` and enumerates its strongly connected components (Tarjan),
// so a chain A ↔ B ↔ C is one component of three files, not two back edges.
// Every component of two or more files must match an ALLOWLIST entry with
// exactly its file set; an entry with no such component fails as stale.
//
// What is an edge: an `import` (including a side-effect `import "./x"`), an
// `export … from` and an `import x = require(…)` whose specifier resolves to
// another file of the same package (the unused-export gate's resolver). Not an
// edge: `import type`, an import or re-export whose specifiers are all `type`,
// and a dynamic `import()`, which does not run at module load. Test, spec and
// story files are not scanned. Cross-package edges belong to
// tests/dependency-edges.test.ts.
//
// oxlint's `import/no-cycle` was not used: the repository runs oxlint's
// correctness category only (.oxlintrc.json), and the rule reports each file
// in a cycle without an exact-component allowlist that goes stale.
//
//   bun scripts/check-import-cycles.ts [root] [--json]

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { parse } from "./lib/source";
import { isTestFile, makeResolver } from "./check-unused-exports.ts";

export interface CycleAllowlistEntry { files: string[]; reason: string }

/** Cycles that exist today, each with its exact file set and why it stays. */
export const ALLOWLIST: CycleAllowlistEntry[] = [
  // Mutual recursion by design: each partner is read only inside a function body.
  { files: ["packages/module-diagrams/src/axis-layout.ts", "packages/module-diagrams/src/geometry.ts"],
    reason: "permanent: mutual recursion by design; each module reads the other only inside function bodies" },
  { files: ["packages/ui-react/src/components/chat/brain-markdown.tsx", "packages/ui-react/src/components/chat/share-block.tsx"],
    reason: "permanent: mutual recursion by design; a share block renders markdown and markdown renders share blocks, inside components" },

  // #4818 cuts the store ↔ write-procedure cycles in ui-server.
  { files: ["packages/ui-server/src/activity/store-writes.ts", "packages/ui-server/src/activity/store.ts", "packages/ui-server/src/activity/turn-lifecycle.ts"],
    reason: "store and its write-procedure module import each other; #4818 cuts the store-to-writes edge" },
  { files: ["packages/ui-server/src/brain/governed-turn-writes.ts", "packages/ui-server/src/brain/provider-exposure.ts"],
    reason: "store and its write-procedure module import each other; #4818 cuts the store-to-writes edge" },
  { files: ["packages/ui-server/src/drafts/store.ts", "packages/ui-server/src/drafts/writes.ts"],
    reason: "store and its write-procedure module import each other; #4818 cuts the store-to-writes edge" },
  { files: ["packages/ui-server/src/inbox/resolve-writes.ts", "packages/ui-server/src/inbox/resolve.ts"],
    reason: "store and its write-procedure module import each other; #4818 cuts the store-to-writes edge" },
  { files: ["packages/ui-server/src/storage/maintenance-writes.ts", "packages/ui-server/src/storage/maintenance.ts"],
    reason: "store and its write-procedure module import each other; #4818 cuts the store-to-writes edge" },

  // #4819 cuts the voice tray cycle in ui-react.
  { files: ["packages/ui-react/src/components/voice/associate-recordings.tsx", "packages/ui-react/src/components/voice/recordings-tray.tsx"],
    reason: "the tray and the associate dialog import each other for two label helpers; #4819 cuts it" },

  // #2530 cuts the worker-runtime cycle in ui-sdk.
  { files: [
    "packages/ui-sdk/src/server/maintenance-worker.ts", "packages/ui-sdk/src/server/worker-launcher.ts",
    "packages/ui-sdk/src/server/worker-output.ts", "packages/ui-sdk/src/server/worker-protection.ts",
    "packages/ui-sdk/src/server/worker-sandbox.ts", "packages/ui-sdk/src/server/worker-turn-temp.ts",
  ], reason: "the worker launcher and its helpers import each other; #2530 cuts it" },
];

export interface CycleReport {
  schemaVersion: 1;
  scannedFiles: number;
  /** Every component of two or more files, each sorted, in file order. */
  components: string[][];
  /** Components no allowlist entry matches exactly. */
  findings: string[][];
  allowlisted: CycleAllowlistEntry[];
  staleAllowlist: CycleAllowlistEntry[];
}

export interface CycleCheckOptions {
  allowlist?: CycleAllowlistEntry[];
  /** Repository-relative files to read instead of `git ls-files` (tests). */
  files?: string[];
}

const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const PACKAGE_SRC = /^packages\/([^/]+)\/src\//;

function listFiles(root: string): string[] {
  const run = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (run.exitCode !== 0) throw new Error(`git ls-files failed: ${run.stderr.toString()}`);
  return run.stdout.toString().split("\0").filter(file => file && existsSync(join(root, file)));
}

/** The specifiers of `file`'s static value imports and re-exports. */
export function valueImports(text: string, file: string): string[] {
  const source = parse(file, text);
  const out: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      const allTypes = clause && !clause.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
      if (!allTypes) out.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      const allTypes = clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
      if (!allTypes) out.push(statement.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) {
      out.push(statement.moduleReference.expression.text);
    }
  }
  return out;
}

/** Strongly connected components of two or more nodes (iterative Tarjan). */
export function stronglyConnected(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; edge: number }> = [{ node: start, edge: 0 }];
    index.set(start, next); low.set(start, next); next++;
    stack.push(start); onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const edges = graph.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const to = edges[frame.edge++]!;
        if (!index.has(to)) {
          index.set(to, next); low.set(to, next); next++;
          stack.push(to); onStack.add(to);
          work.push({ node: to, edge: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== frame.node);
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export function checkImportCycles(root: string, options: CycleCheckOptions = {}): CycleReport {
  const allowlist = options.allowlist ?? ALLOWLIST;
  const listed = options.files ?? listFiles(root);
  const files = listed.filter(file => PACKAGE_SRC.test(file) && SOURCE.test(file) && !file.endsWith(".d.ts") && !isTestFile(file));
  // Relative specifiers only: a workspace specifier crosses a package.
  const resolveSpecifier = makeResolver(new Set(files), new Map());
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const pkg = file.match(PACKAGE_SRC)![1];
    const targets = valueImports(readFileSync(join(root, file), "utf8"), file)
      .map(specifier => resolveSpecifier(file, specifier))
      .filter((target): target is string => target !== undefined && target !== file && target.match(PACKAGE_SRC)?.[1] === pkg);
    graph.set(file, [...new Set(targets)]);
  }
  const components = stronglyConnected(graph);
  const key = (set: string[]) => [...set].sort().join("\0");
  const allowed = new Map(allowlist.map(entry => [key(entry.files), entry]));
  const findings: string[][] = [];
  const allowlisted: CycleAllowlistEntry[] = [];
  for (const component of components) {
    const entry = allowed.get(key(component));
    if (entry) allowlisted.push(entry);
    else findings.push(component);
  }
  const hit = new Set(allowlisted);
  return {
    schemaVersion: 1, scannedFiles: files.length, components, findings, allowlisted,
    staleAllowlist: allowlist.filter(entry => !hit.has(entry)),
  };
}

/** The gate as `bun run lint` runs it: prints its findings, returns its exit code. */
export function lintGate(root: string): number {
  const report = checkImportCycles(root);
  const empty = report.scannedFiles === 0;
  const failed = empty || report.findings.length > 0 || report.staleAllowlist.length > 0;
  // A scan that matches nothing would pass forever.
  if (empty) console.error("import-cycles: no source files under packages/*/src; the gate checked nothing");
  for (const component of report.findings) {
    console.error(`import-cycles: these files import each other at runtime — cut the cycle (move the shared code into a leaf module, or make one edge \`import type\`):\n  ${component.join("\n  ")}`);
  }
  for (const entry of report.staleAllowlist) {
    console.error(`scripts/check-import-cycles.ts: stale allowlist entry — no cycle has exactly these files; remove or correct the entry:\n  ${entry.files.join("\n  ")}`);
  }
  if (!failed) {
    console.log(`import-cycles: ${report.scannedFiles} files in packages/*/src, ${report.components.length} cycles, all allowlisted`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const root = resolve(args.find(arg => !arg.startsWith("--")) ?? join(import.meta.dir, ".."));
  if (json) {
    const report = checkImportCycles(root);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.scannedFiles === 0 || report.findings.length > 0 || report.staleAllowlist.length > 0 ? 1 : 0);
  }
  process.exit(lintGate(root));
}
