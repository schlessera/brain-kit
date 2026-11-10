/**
 * Static smell signals for one test file, read from its syntax tree.
 *
 * A signal is a lead for the auditing agent, never a finding: `toBeDefined()`
 * is sometimes exactly the claim, and a `setTimeout` can be a failure cap
 * (docs/process/test-waits.md). The scanner's jobs are to rank files for the
 * selector, to point the agent at lines, and to let the batch gate refuse a
 * change that adds a skip, a retry or a longer budget.
 *
 * Results are cached by blob id, so a file is parsed once per content and
 * every checkout of the repository on a machine shares the work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { smellById } from "./catalog";

/** Bump when the scanner's output for unchanged source would change. */
export const SCAN_VERSION = 2;

export interface Signal { smell: string; line: number; detail?: string; weight?: number }
export interface FileSignals {
  version: number; lines: number; tests: number; matchers: number; signals: Signal[];
  /** Every test declaration as `describe > title`, in source order; the unit the batch gate accounts for. */
  titles: string[];
}

const TEST_ROOTS = new Set(["test", "it"]);
const SKIP = new Set(["skip", "todo", "failing"]);
const CONDITIONAL = new Set(["skipIf", "runIf", "if", "todoIf"]);
const TABLE = new Set(["each", "for"]);
const WEAK = new Set(["toBeTruthy", "toBeDefined", "toBeFalsy"]);
const WEAK_NEGATED = new Set(["toBeNull", "toBeUndefined"]);
const BOOLEAN_CALLS = new Set(["includes", "startsWith", "endsWith", "some", "every", "has", "test", "isArray"]);
const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken]);
const GLOBAL_ROOTS = new Set(["globalThis", "window", "navigator", "document"]);
const VAGUE_TITLE = /^(works?|tests?|should work|it works|basic|ok|todo|(?:case|test) \d+)$/i;
const SPAWN = /(?:^|\.)(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)$/;
const RESOURCE = /(?:^|\.)(?:mkdtemp|mkdtempSync|createServer|listen)$|^Bun\.serve$/;
const DOUBLES = new Set(["mock", "spyOn", "mock.module", "vi.fn", "vi.mock", "vi.spyOn", "jest.fn", "jest.mock", "jest.spyOn"]);
const LONG_BUDGET_MS = 60_000;
const REAL_TIME_MS = 1_000;
const GIANT_LINES = 150;
const GIANT_MATCHERS = 40;

interface Matcher { name: string; negated: boolean; inLoop: boolean }
interface TestInfo { line: number; matchers: Matcher[]; delegated: number; helpers: number }
interface Context { test: TestInfo | null; branch: boolean; unguardedCatch: boolean; loop: boolean; wraps: number; describe: string }

/** The leftmost identifier of a call chain and the property names after it. */
function chainOf(expression: ts.Expression): { root: string; names: string[]; subject?: ts.Expression } {
  const names: string[] = [];
  let subject: ts.Expression | undefined;
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) { names.unshift(current.name.text); current = current.expression; }
    else if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression) && current.expression.text === "expect") subject = current.arguments[0];
      current = current.expression;
    } else if (ts.isTaggedTemplateExpression(current)) current = current.tag;
    else if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) current = current.expression;
    else if (ts.isIdentifier(current)) return { root: current.text, names, subject };
    else return { root: "", names, subject };
  }
}

const numeric = (node: ts.Node | undefined): number | null =>
  node && ts.isNumericLiteral(node) ? Number(node.text.replaceAll("_", "")) : null;
const isLiteral = (node: ts.Node): boolean => ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
  [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
const isFunction = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

export function scanSource(file: string, source: string): FileSignals {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const signals: Signal[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (smell: string, node: ts.Node, detail?: string, weight?: number) => {
    signals.push({ smell, line: lineOf(node), ...(detail ? { detail } : {}), ...(weight === undefined ? {} : { weight }) });
  };
  const titles = new Map<string, number>();
  const declared: string[] = [];
  /** A literal title as written; any other title as its source text, which survives a line shift. */
  const labelOf = (node: ts.Node | undefined, fallback: string): string =>
    !node || isFunction(node) ? fallback : ts.isStringLiteralLike(node) ? node.text : node.getText(sf).replace(/\s+/g, " ").slice(0, 120);
  const qualify = (path: string, label: string): string => path ? `${path} > ${label}` : label;
  let tests = 0, matchers = 0, spawns = 0, doubles = 0, resources = 0;
  let cleanup = false, beforeAll: ts.Node | null = null, afterAll = false;
  let firstSpawn: ts.Node | null = null, firstDouble: ts.Node | null = null, firstResource: ts.Node | null = null;

  const closeTest = (node: ts.CallExpression, info: TestInfo, body: ts.Node | undefined) => {
    const count = info.matchers.length + info.delegated;
    if (body && count === 0) {
      add("no-assertion", node, info.helpers ? `no direct assertion; ${info.helpers} helper call(s) may assert` : undefined, info.helpers ? 0.5 : undefined);
    }
    if (info.matchers.length && !info.delegated) {
      if (info.matchers.every(m => m.negated && m.name === "toThrow")) add("not-throw-only", node);
      if (info.matchers.every(m => m.name.startsWith("toHaveBeenCalled"))) add("asserts-the-double", node);
      if (info.matchers.every(m => m.inLoop)) add("conditional-assertion", node, "every assertion is inside a loop");
    }
    if (body) {
      const lines = sf.getLineAndCharacterOfPosition(body.getEnd()).line + 1 - lineOf(body);
      if (lines > GIANT_LINES || info.matchers.length > GIANT_MATCHERS) add("giant-test", node, `${lines} lines, ${info.matchers.length} assertions`);
    }
  };

  const visitTest = (node: ts.CallExpression, names: string[], context: Context) => {
    tests++;
    declared.push(qualify(context.describe, labelOf(node.arguments[0], "(untitled)")));
    if (names.some(name => SKIP.has(name))) add("skipped", node, names.find(name => SKIP.has(name)));
    if (names.some(name => CONDITIONAL.has(name))) add("conditional-skip", node, names.find(name => CONDITIONAL.has(name)));
    if (names.includes("only")) add("only", node);
    if ((names.some(name => TABLE.has(name)) && context.wraps >= 1) || context.wraps >= 2) add("matrix-multiplier", node, `${context.wraps} enclosing loop(s) or table(s)`);
    const [title, ...rest] = node.arguments;
    if (title && ts.isStringLiteralLike(title)) {
      const key = `${context.describe}\n${title.text}`;
      if (titles.has(key)) add("duplicate-case", node, `same title as line ${titles.get(key)}`);
      else titles.set(key, lineOf(node));
      if (title.text.trim().length < 5 || VAGUE_TITLE.test(title.text.trim())) add("unclear-name", node, title.text);
    }
    for (const argument of rest) {
      const budget = numeric(argument);
      if (budget !== null && budget >= LONG_BUDGET_MS) add("long-timeout", node, `${budget} ms`);
      if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          if (property.name.text === "retry") add("retry", node);
          const value = numeric(property.initializer);
          if (property.name.text === "timeout" && value !== null && value >= LONG_BUDGET_MS) add("long-timeout", node, `${value} ms`);
        }
      }
    }
    const body = rest.find(isFunction);
    const info: TestInfo = { line: lineOf(node), matchers: [], delegated: 0, helpers: 0 };
    if (body) visit(body.body, { ...context, test: info, branch: false, unguardedCatch: false, loop: false });
    closeTest(node, info, body);
  };

  const visitCall = (node: ts.CallExpression, context: Context): boolean => {
    const { root, names, subject } = chainOf(node.expression);
    const callee = ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression) ? node.expression.getText(sf) : "";

    if (TEST_ROOTS.has(root) && !context.test && node.arguments.length && !ts.isCallExpression(node.parent)) {
      visitTest(node, names, context);
      return true;
    }
    if (root === "describe" && !context.test) {
      if (names.some(name => SKIP.has(name))) add("skipped", node, "describe");
      if (names.some(name => CONDITIONAL.has(name))) add("conditional-skip", node, "describe");
      if (names.includes("only")) add("only", node, "describe");
      const [title, body] = [node.arguments[0], node.arguments.find(isFunction)];
      if (body) {
        visit(body.body, { ...context, describe: qualify(context.describe, labelOf(title, "(describe)")), wraps: context.wraps + (names.some(name => TABLE.has(name)) ? 1 : 0) });
        return true;
      }
    }
    if (root === "beforeAll") beforeAll ??= node;
    if (root === "afterAll") afterAll = true;
    if (root === "afterEach" || root === "afterAll") cleanup = true;

    if (root === "expect" && subject !== undefined && names.length) {
      const name = names[names.length - 1]!;
      const negated = names.includes("not");
      matchers++;
      if (context.test) context.test.matchers.push({ name, negated, inLoop: context.loop });
      if ((!negated && WEAK.has(name)) || (negated && WEAK_NEGATED.has(name))) add("weak-matcher", node, `${negated ? "not." : ""}${name}`);
      const argument = node.arguments[0];
      if (argument && node.arguments.length === 1 && (subject.getText(sf) === argument.getText(sf) || (isLiteral(subject) && isLiteral(argument)))) {
        add("self-comparison", node);
      }
      if (context.branch) add("conditional-assertion", node, "inside a branch");
      if (context.unguardedCatch) add("conditional-assertion", node, "inside catch, and the try block cannot fail the test");
      if (argument && (name === "toBe" || name === "toEqual") && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(argument.kind)) {
        const inner = ts.isParenthesizedExpression(subject) ? subject.expression : subject;
        const comparison = ts.isBinaryExpression(inner) && COMPARISONS.has(inner.operatorToken.kind);
        const predicate = ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && BOOLEAN_CALLS.has(inner.expression.name.text);
        if (comparison || predicate) add("opaque-failure", node, "a boolean hides the compared values");
      }
      if ((names.includes("resolves") || names.includes("rejects")) && ts.isExpressionStatement(node.parent)) add("unawaited-async", node);
    } else if (root === "expect" || root === "assert" || /^(?:expect|assert)[A-Z_]/.test(root)) {
      if (context.test && (root !== "expect" || names.length)) context.test.delegated++;
    } else if (context.test && ts.isIdentifier(node.expression)) context.test.helpers++;

    if (/(?:^|\.)setTimeout$/.test(callee) || /^Bun\.sleep(?:Sync)?$/.test(callee) || /(?:^|\.)(?:waitForTimeout|sleep)$/.test(callee)) {
      const ms = numeric(callee.endsWith("setTimeout") ? node.arguments[1] : node.arguments[0]);
      add("settling-sleep", node, ms === null ? "computed delay" : `${ms} ms`);
      if (ms !== null && ms >= REAL_TIME_MS) add("real-time-wait", node, `${ms} ms`);
    }
    if (callee === "Date.now" || callee === "performance.now") add("wall-clock", node, callee);
    if (callee === "Math.random") add("unseeded-random", node);
    if (SPAWN.test(callee)) { spawns++; firstSpawn ??= node; }
    if (DOUBLES.has(callee)) { doubles++; firstDouble ??= node; }
    if (RESOURCE.test(callee)) {
      resources++; firstResource ??= node;
      const port = callee.endsWith("listen") ? numeric(node.arguments[0]) : null;
      if (port !== null && port >= 1024) add("fixed-resource", node, `port ${port}`);
    }
    if (callee === "Object.defineProperty" && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && GLOBAL_ROOTS.has(node.arguments[0].text)) {
      add("unrestored-global", node, `defineProperty on ${node.arguments[0].text}`);
    }
    if (root === "beforeEach") {
      const body = node.arguments.find(isFunction);
      if (body && /\b(?:spawn|spawnSync|execSync|mkdtemp|mkdtempSync|createServer)\b|Bun\.serve/.test(body.getText(sf))) add("per-test-setup", node);
    }
    return false;
  };

  function visit(node: ts.Node, context: Context): void {
    if (ts.isCallExpression(node) && visitCall(node, context)) return;
    // `const live = LIVE ? test : test.skip` skips just as well as `test.skipIf(!LIVE)`.
    if (ts.isPropertyAccessExpression(node) && SKIP.has(node.name.text) && ts.isIdentifier(node.expression)
      && (TEST_ROOTS.has(node.expression.text) || node.expression.text === "describe")
      && !ts.isPropertyAccessExpression(node.parent) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      add("conditional-skip", node, `${node.expression.text}.${node.name.text} used as a value`);
    }
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "$") { spawns++; firstSpawn ??= node; }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && !node.arguments?.length) add("wall-clock", node, "new Date()");
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "port") {
      const port = numeric(node.initializer);
      if (port !== null && port >= 1024) add("fixed-resource", node, `port ${port}`);
    }
    if (ts.isStringLiteralLike(node) && node.text.startsWith("/tmp/")) add("fixed-resource", node, node.text.slice(0, 40));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left.getText(sf);
      if (GLOBAL_ROOTS.has(chainOf(node.left).root) || target.startsWith("process.env.") || target.startsWith("process.env[")) add("unrestored-global", node, target.slice(0, 60));
    }
    if (ts.isDeleteExpression(node) && node.expression.getText(sf).startsWith("process.env")) add("unrestored-global", node, "delete process.env");
    if (ts.isTryStatement(node)) {
      if (node.finallyBlock) cleanup = true;
      visit(node.tryBlock, context);
      // A catch-only assertion is sound when the try block itself fails the test on success.
      const guarded = /\bexpect\.unreachable\(|\bthrow\b|\bfail\(/.test(node.tryBlock.getText(sf));
      if (node.catchClause) visit(node.catchClause, { ...context, unguardedCatch: context.unguardedCatch || !guarded });
      if (node.finallyBlock) visit(node.finallyBlock, context);
      return;
    }
    if (ts.isIfStatement(node)) {
      visit(node.expression, context);
      visit(node.thenStatement, { ...context, branch: true });
      if (node.elseStatement) visit(node.elseStatement, { ...context, branch: true });
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, context);
      visit(node.whenTrue, { ...context, branch: true });
      visit(node.whenFalse, { ...context, branch: true });
      return;
    }
    if (ts.isIterationStatement(node, false)) {
      ts.forEachChild(node, child => visit(child, { ...context, loop: true, wraps: context.wraps + 1 }));
      return;
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using)) cleanup = true;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "forEach") {
      ts.forEachChild(node, child => visit(child, { ...context, loop: true, wraps: context.wraps + 1 }));
      return;
    }
    ts.forEachChild(node, child => visit(child, context));
  }

  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using))) {
      add("shared-state", statement, statement.declarationList.declarations.map(declaration => declaration.name.getText(sf)).join(", ").slice(0, 60));
    }
  }
  visit(sf, { test: null, branch: false, unguardedCatch: false, loop: false, wraps: 0, describe: "" });

  if (beforeAll && !afterAll) add("shared-state", beforeAll, "beforeAll without afterAll");
  if (spawns >= 5 && firstSpawn) add("spawn-per-assertion", firstSpawn, `${spawns} spawn sites`);
  if (doubles >= 5 && doubles > matchers && firstDouble) add("over-mocked", firstDouble, `${doubles} doubles, ${matchers} assertions`);
  if (resources > 0 && !cleanup && firstResource) add("leaked-resource", firstResource, "no afterEach, afterAll, finally or using in the file");

  signals.sort((a, b) => a.line - b.line || (a.smell < b.smell ? -1 : a.smell > b.smell ? 1 : 0));
  return { version: SCAN_VERSION, lines: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1, tests, matchers, signals, titles: declared };
}

/** Counts per smell, for trends and for the batch gate's before/after comparison. */
export function countSignals(signals: readonly Signal[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signal of signals) counts[signal.smell] = (counts[signal.smell] ?? 0) + 1;
  return counts;
}

/** The selector's ranking input: catalogue weights, with a signal's own weight when it carries one. */
export function signalWeight(signals: readonly Signal[]): number {
  return signals.reduce((sum, signal) => sum + (signal.weight ?? smellById(signal.smell)?.weight ?? 0), 0);
}

export function scanFiles(root: string, files: ReadonlyArray<{ file: string; blob: string }>, cacheDir?: string): Map<string, FileSignals> {
  const dir = cacheDir ? join(cacheDir, `signals-v${SCAN_VERSION}`) : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const out = new Map<string, FileSignals>();
  for (const { file, blob } of files) {
    const path = dir ? join(dir, `${blob}.json`) : null;
    if (path && existsSync(path)) { out.set(file, JSON.parse(readFileSync(path, "utf8")) as FileSignals); continue; }
    const scanned = scanSource(file, readFileSync(join(root, file), "utf8"));
    if (path) writeFileSync(path, JSON.stringify(scanned));
    out.set(file, scanned);
  }
  return out;
}
