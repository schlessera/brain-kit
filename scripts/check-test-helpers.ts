// Refuses a local copy of a test need that has a shared owner (#4835, #4838, #4840, #4837).
//
// Why: a test that waits for a condition, runs Git or boots an app writes the
// same few lines as the next file, and the copies drift apart (bounds,
// environments, flags). A fix to one copy then misses the others. Each rule in
// RULES names one such need, the shape of a local copy and the shared owner a
// test imports instead.
//
// Files that still hold a copy are listed in scripts/test-helper-baseline.json
// with their rule, their exact number of sites and a one-line reason (a
// follow-up slice, or why the copy stays). A file with more sites than its
// entry fails, so a new copy in a listed file is still refused; an entry whose
// file now has fewer sites fails as stale, so the baseline only shrinks.
//
// The scan is textual except for one structural match: a loop that sleeps
// and compares a clock reading with a bound (#5045), which the polling-helper
// rule reads on the parsed tree. It reads tracked-style `.ts` and `.tsx` files
// under `packages/*/tests` and `tests` below the root it is given.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";
import { parse, treeFiles } from "./lib/source";

export interface Site {
  rule: string;
  file: string;
  line: number;
  name: string;
}

export interface Rule {
  id: string;
  /** What a site is, for the report. */
  refused: string;
  /** Where the shared owner lives, for the report. */
  instead: string;
  /** Files that are the shared owner (or deliberately another one). */
  allowed: readonly string[];
  sites(text: string, file: string): Array<{ line: number; name: string }>;
}

export interface BaselineEntry {
  rule: string;
  file: string;
  count: number;
  reason: string;
}

const SCANNED = ["packages/*/tests/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"];
export const BASELINE = "scripts/test-helper-baseline.json";

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * The text of a declaration starting at `start`: up to the bracket that
 * closes its body, or the `;` that ends it, skipping strings and comments.
 */
function declarationText(text: string, start: number, maxLines = 80): string {
  let depth = 0, lines = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n" && ++lines > maxLines) return text.slice(start, i);
    if (c === "/" && text[i + 1] === "/") { const end = text.indexOf("\n", i); i = (end < 0 ? text.length : end) - 1; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === "}") return text.slice(start, i + 1);
    } else if (c === ";" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const POLL_NAMES = "until|waitFor|waitUntil|eventually|poll";
// A function declaration, or a `const` whose value is a function. A deadline
// such as `const until = Date.now() + 5000` is not a helper.
const POLL_HEAD = new RegExp(
  String.raw`^[ \t]*(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*(${POLL_NAMES})\b|const\s+(${POLL_NAMES})\s*(?::[^=\n]+)?=\s*(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>))`,
  "gm",
);
const SLEEPS = /\bsetTimeout\b|\bsetImmediate\b|\bsleep\s*\(/;
const CLOCK_TEXT = /\b(?:Date|performance)\.now\s*\(/;
const COMPARES = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);

const some = (node: ts.Node, test: (node: ts.Node) => boolean): boolean => test(node) || ts.forEachChild(node, (child) => some(child, test) || undefined) === true;
/** `Date.now()` or `performance.now()`. */
const isClock = (node: ts.Node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "now" &&
  ts.isIdentifier(node.expression.expression) && (node.expression.expression.text === "Date" || node.expression.expression.text === "performance");
const isWatchdog = (node: ts.Node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "watchdogMs";

/** The name of the function a loop sits in, or the loop itself when it sits in no named function. */
function enclosingName(node: ts.Node): string {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue;
    if ("name" in scope && scope.name && ts.isIdentifier(scope.name)) return scope.name.text;
    if (ts.isVariableDeclaration(scope.parent) && ts.isIdentifier(scope.parent.name)) return scope.parent.name.text;
    return "deadline loop";
  }
  return "deadline loop";
}

const binds = (name: ts.BindingName, text: string): boolean => ts.isIdentifier(name)
  ? name.text === text
  : name.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name, text));

/** The declaration of `name` that `scope` itself holds: a parameter, a loop or catch binding, or a statement of a block. */
function declaredIn(scope: ts.Node, name: string): ts.Node | undefined {
  const inList = (list: ts.VariableDeclarationList) => list.declarations.find((declaration) => binds(declaration.name, name));
  if (ts.isFunctionLike(scope)) return scope.parameters.find((parameter) => binds(parameter.name, name));
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    return scope.initializer && ts.isVariableDeclarationList(scope.initializer) ? inList(scope.initializer) : undefined;
  }
  if (ts.isCatchClause(scope)) return scope.variableDeclaration && binds(scope.variableDeclaration.name, name) ? scope.variableDeclaration : undefined;
  const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? scope.statements
    : ts.isCaseBlock(scope) ? scope.clauses.flatMap((clause) => [...clause.statements]) : [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      const found = inList(statement.declarationList);
      if (found) return found;
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return statement;
  }
  return undefined;
}

/** The declaration a name reads: the nearest enclosing scope that declares it, so an inner one shadows an outer one. */
function declarationOf(name: ts.Identifier): ts.Node | undefined {
  for (let scope = name.parent; scope; scope = scope.parent) {
    const found = declaredIn(scope, name.text);
    if (found) return found;
  }
  return undefined;
}

/** Names a node reads, leaving out property names such as `deadline` in `state.deadline`. */
function readsIn(node: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const walk = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) out.push(child);
    ts.forEachChild(child, walk);
  };
  walk(node);
  return out;
}

const initializerOf = (name: ts.Identifier) => {
  const declaration = declarationOf(name);
  return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
};

/**
 * Loops that sleep and compare `Date.now()` or `performance.now()` with a
 * bound (#5045): a deadline loop, inline or in a helper of any name. A bound
 * through `watchdogMs`, in the comparison or in the initializer of the
 * declaration a name in it reads (#5054), is a scaled watchdog and passes. A
 * comparison inside a nested function or loop belongs to that one, so a site
 * is the innermost such loop.
 */
function deadlineLoops(file: string, text: string): Array<{ index: number; line: number; name: string }> {
  if (!SLEEPS.test(text) || !CLOCK_TEXT.test(text)) return [];
  const source = parse(file, text);
  const found: Array<{ index: number; line: number; name: string }> = [];
  const scaledName = (name: ts.Identifier) => {
    const initializer = initializerOf(name);
    return initializer !== undefined && some(initializer, isWatchdog);
  };
  const unscaled = (comparison: ts.Node) => !some(comparison, isWatchdog) && !readsIn(comparison).some(scaledName);
  const clockComparisons = (loop: ts.IterationStatement) => {
    const out: ts.BinaryExpression[] = [];
    const walk = (node: ts.Node): void => {
      if (node !== loop && (ts.isFunctionLike(node) || ts.isIterationStatement(node, false))) return;
      if (ts.isBinaryExpression(node) && COMPARES.has(node.operatorToken.kind) && some(node, isClock)) out.push(node);
      ts.forEachChild(node, walk);
    };
    walk(loop);
    return out;
  };
  const loops = (node: ts.Node): void => {
    if (ts.isIterationStatement(node, false) && SLEEPS.test(node.getText(source)) && clockComparisons(node).some(unscaled)) {
      const index = node.getStart(source);
      found.push({ index, line: lineAt(text, index), name: enclosingName(node) });
    }
    ts.forEachChild(node, loops);
  };
  loops(source);
  return found;
}

// `resolveServerConfig({ … })` with both keys a test app boots with.
const BOOT_CONFIG = /\bresolveServerConfig\s*\(\s*\{/g;
// A path built under the shared temp root. Only `mkdtemp` makes one that is
// unpredictable; anything else needs a `// tmp-path: <reason>` marker.
const TMP_PATH = /\b(?:join|resolve)\(\s*(?:os\.)?tmpdir\(\)\s*,/g;
const MKDTEMP_ARGUMENT = /\bmkdtemp(?:Sync)?\(\s*$/;
const TMP_PATH_MARKER = /\/\/\s*tmp-path:\s*\S/;
// A Git runner named `git`: a function declaration or a `const` binding.
const GIT_RUNNER = /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+git\s*\(|const\s+git\s*(?::[^=\n]+)?=(?!=))/gm;
const configKeys = (literal: string) => new Set([...literal.matchAll(/\b([A-Z][A-Z0-9_]{3,})\s*:/g)].map((match) => match[1]!));

export const RULES: readonly Rule[] = [
  {
    id: "polling-helper",
    refused: "a local polling helper that sleeps in its loop",
    instead: "wait with `until` from tests/helpers/until.ts, whose bound is a watchdog the load gate scales",
    allowed: ["tests/helpers/until.ts", "tests/helpers/planning-control.ts"],
    sites(text, file) {
      const found: Array<{ line: number; name: string }> = [];
      const helpers: Array<[number, number]> = [];
      for (const match of text.matchAll(POLL_HEAD)) {
        const declaration = declarationText(text, match.index!);
        if (!SLEEPS.test(declaration)) continue;
        found.push({ line: lineAt(text, match.index!), name: match[1] ?? match[2]! });
        helpers.push([match.index!, match.index! + declaration.length]);
      }
      // A deadline loop under any name; one inside a helper found above is that helper's site.
      for (const loop of deadlineLoops(file, text)) {
        if (!helpers.some(([start, end]) => loop.index >= start && loop.index < end)) found.push({ line: loop.line, name: loop.name });
      }
      return found.sort((a, b) => a.line - b.line);
    },
  },
  {
    id: "boot-config",
    refused: "a hand-written boot config literal (`resolveServerConfig({ AUTH_MODE, HOST, … })`)",
    instead: "build it with `testServerConfig` from packages/ui-server/tests/helpers/test-config.ts, which turns every vendor discovery off",
    allowed: ["packages/ui-server/tests/helpers/test-config.ts"],
    sites(text) {
      const found: Array<{ line: number; name: string }> = [];
      for (const match of text.matchAll(BOOT_CONFIG)) {
        const keys = configKeys(declarationText(text, match.index! + match[0].length - 1));
        if (keys.has("AUTH_MODE") && keys.has("HOST")) found.push({ line: lineAt(text, match.index!), name: "resolveServerConfig" });
      }
      return found;
    },
  },
  {
    id: "git-runner",
    refused: "a local Git runner (`function git(` or `const git =`)",
    instead: "run Git with `git` or `gitResult` from packages/core/tests/git-fixture.ts, which ignores the host's system and global Git configuration",
    allowed: ["packages/core/tests/git-fixture.ts"],
    sites(text) {
      return [...text.matchAll(GIT_RUNNER)].map((match) => ({ line: lineAt(text, match.index!), name: "git" }));
    },
  },
  {
    id: "tmp-path",
    refused: "a path under tmpdir() that mkdtemp did not make",
    instead: "make the directory with `tempDirs` from tests/helpers/temp.ts, or mark a path that must stay with `// tmp-path: <reason>` on the line or the line above",
    allowed: ["tests/helpers/temp.ts"],
    sites(text) {
      const lines = text.split("\n");
      const found: Array<{ line: number; name: string }> = [];
      for (const match of text.matchAll(TMP_PATH)) {
        const line = lineAt(text, match.index!);
        const before = text.slice(text.lastIndexOf("\n", match.index!) + 1, match.index!);
        if (MKDTEMP_ARGUMENT.test(before) || TMP_PATH_MARKER.test(lines[line - 1]!) || (line > 1 && TMP_PATH_MARKER.test(lines[line - 2]!))) continue;
        found.push({ line, name: match[0].replace(/\s+/g, "").replace(/,$/, "") });
      }
      return found;
    },
  },
];

export function scanSource(file: string, text: string, rules: readonly Rule[] = RULES): Site[] {
  return rules.flatMap((rule) => rule.allowed.includes(file) ? [] : rule.sites(text, file).map((site) => ({ rule: rule.id, file, ...site })));
}

function testFiles(root: string): string[] {
  return treeFiles(root, SCANNED).filter((file) => !/(^|\/)(node_modules|dist)\//.test(file));
}

/** Shape problems in a baseline: an unknown rule, a missing reason, a duplicate, the wrong order. */
export function baselineProblems(entries: readonly BaselineEntry[], rules: readonly Rule[] = RULES): string[] {
  const problems: string[] = [];
  const ids = new Set(rules.map((rule) => rule.id));
  const key = (entry: BaselineEntry) => `${entry.rule}\u0000${entry.file}`;
  entries.forEach((entry, index) => {
    const where = `${BASELINE} entry ${index + 1} (${entry.rule} ${entry.file})`;
    if (!ids.has(entry.rule)) problems.push(`${where}: no rule is named ${JSON.stringify(entry.rule)}`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) problems.push(`${where}: needs a one-line reason`);
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) problems.push(`${where}: count must be a positive whole number`);
    const previous = entries[index - 1];
    if (previous && key(previous) >= key(entry)) problems.push(`${where}: entries are sorted by rule, then file, with no duplicates`);
  });
  return problems;
}

export interface Report {
  /** Sites in files with no baseline entry, or in a file over its entry. */
  findings: Site[];
  /** Baseline entries whose file holds a different number of sites. */
  miscounted: Array<{ rule: string; file: string; expected: number; actual: number }>;
  problems: string[];
}

export function readBaseline(root: string): BaselineEntry[] {
  const path = resolve(root, BASELINE);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as BaselineEntry[] : [];
}

export function scanTree(root: string, baseline: readonly BaselineEntry[] = readBaseline(root), rules: readonly Rule[] = RULES): Report {
  const sites = testFiles(root).flatMap((file) => scanSource(file, readFileSync(resolve(root, file), "utf8"), rules));
  const listed = new Map(baseline.map((entry) => [`${entry.rule}\u0000${entry.file}`, entry]));
  const byEntry = new Map<string, Site[]>();
  for (const site of sites) {
    const key = `${site.rule}\u0000${site.file}`;
    byEntry.set(key, [...byEntry.get(key) ?? [], site]);
  }
  const findings: Site[] = [], miscounted: Report["miscounted"] = [];
  for (const [key, found] of byEntry) {
    const entry = listed.get(key);
    if (!entry || found.length > entry.count) findings.push(...found);
  }
  for (const entry of baseline) {
    const actual = byEntry.get(`${entry.rule}\u0000${entry.file}`)?.length ?? 0;
    if (actual < entry.count) miscounted.push({ rule: entry.rule, file: entry.file, expected: entry.count, actual });
  }
  return { findings, miscounted, problems: baselineProblems(baseline, rules) };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { findings, miscounted, problems } = scanTree(root);
  if (findings.length === 0 && miscounted.length === 0 && problems.length === 0) {
    console.log("No test file holds a new local copy of a shared test helper.");
    process.exit(0);
  }
  for (const rule of RULES) {
    const mine = findings.filter((site) => site.rule === rule.id);
    if (mine.length === 0) continue;
    console.error(`${rule.refused} (${rule.id}); ${rule.instead}:`);
    for (const site of mine) console.error(`  ${site.file}:${site.line}: ${site.name}`);
  }
  for (const entry of miscounted) {
    console.error(`  ${entry.file}: ${BASELINE} records ${entry.expected} ${entry.rule} site(s), found ${entry.actual}; ` +
      "the entry is stale: lower its count, or remove it when none is left");
  }
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\n${findings.length + miscounted.length + problems.length} finding(s). A copy that must stay local goes in ${BASELINE} with its reason.`);
  process.exit(1);
}
