/**
 * Which other tests are about the same thing as a seed test.
 *
 * Two signals, both cheap and deterministic. Shared imports: tests that load
 * the same source module exercise the same code. Shared names: a runtime or
 * browser test usually drives the application instead of importing the module,
 * so `draft-runtime.test.ts` and `draft-client.test.ts` meet through `draft`.
 * Both are weighted by rarity, so a helper every test imports and a word every
 * file carries count for almost nothing.
 *
 * A neighbour in the same tier is horizontal overlap; one in another tier is
 * vertical. The auditing agent decides whether the overlap is real.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { TIER_LEVEL, type Row } from "./inventory";

/** Bump when resolution would change for unchanged source. */
export const IMPORT_VERSION = 1;

const STOP = new Set(["test", "spec", "tests", "runtime", "layout", "offline", "pointer", "visual", "stories", "endurance",
  "native", "tsx", "the", "and", "for", "with"]);
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"];

/** Import specifiers of a module, static and literal-dynamic. */
export function importSpecifiers(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
}

/** Repository-relative targets: relative imports that resolve to a file, and
 * `pkg:<dir>` for an import of a workspace package by name. */
export function localTargets(root: string, file: string, specifiers: readonly string[], packageDirs: ReadonlyMap<string, string>): string[] {
  const targets = new Set<string>();
  for (const specifier of specifiers) {
    if (specifier.startsWith(".")) {
      const base = normalize(join(dirname(file), specifier)).replaceAll("\\", "/");
      const stem = base.replace(/\.(?:js|mjs|jsx)$/, "");
      for (const candidate of [base, ...EXTENSIONS.map(extension => stem + extension)]) {
        const path = join(root, candidate);
        if (existsSync(path) && statSync(path).isFile()) { targets.add(candidate); break; }
      }
      continue;
    }
    for (const [name, dir] of packageDirs) {
      if (specifier === name || specifier.startsWith(`${name}/`)) { targets.add(`pkg:${dir}`); break; }
    }
  }
  return [...targets].sort();
}

export type ImportIndex = Map<string, string[]>;

export function buildImportIndex(root: string, rows: ReadonlyArray<Pick<Row, "file" | "blob">>, packageDirs: ReadonlyMap<string, string>, cacheDir?: string): ImportIndex {
  const dir = cacheDir ? join(cacheDir, `imports-v${IMPORT_VERSION}`) : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const index: ImportIndex = new Map();
  for (const { file, blob } of rows) {
    // A blob does not know its path, and a relative import resolves from it.
    const path = dir ? join(dir, `${blob}-${Bun.hash(file).toString(16)}.json`) : null;
    if (path && existsSync(path)) { index.set(file, JSON.parse(readFileSync(path, "utf8")) as string[]); continue; }
    const targets = localTargets(root, file, importSpecifiers(file, readFileSync(join(root, file), "utf8")), packageDirs);
    if (path) writeFileSync(path, JSON.stringify(targets));
    index.set(file, targets);
  }
  return index;
}

export function nameTokens(file: string): string[] {
  const base = file.split("/").pop()!.replace(/\.[cm]?[jt]sx?$/, "");
  return [...new Set(base.split(/[^a-zA-Z0-9]+/).map(token => token.toLowerCase()).filter(token => token.length >= 3 && !STOP.has(token)))];
}

export interface Neighbour { file: string; score: number; relation: "horizontal" | "vertical"; shared: string[] }

/** Weights precomputed once per inventory: how rare each import target and name token is. */
export interface Affinity { rows: readonly Row[]; index: ImportIndex; targetWeight: Map<string, number>; tokenWeight: Map<string, number>; tokens: Map<string, string[]> }

export function buildAffinity(rows: readonly Row[], index: ImportIndex): Affinity {
  const count = (lists: Iterable<readonly string[]>) => {
    const counts = new Map<string, number>();
    for (const list of lists) for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
    return counts;
  };
  const tokens = new Map(rows.map(row => [row.file, nameTokens(row.file)]));
  const rarity = (counts: Map<string, number>) => new Map([...counts].map(([key, n]) => [key, 1 / Math.log2(1 + n)]));
  const targetWeight = rarity(count(rows.map(row => index.get(row.file) ?? [])));
  // Test support code and whole-package imports say less than a shared source module.
  for (const [target, weight] of targetWeight) {
    if (target.startsWith("pkg:")) targetWeight.set(target, weight * 0.1);
    else if (/(?:^|\/)(?:tests|test|fixtures|helpers|stories)\//.test(target)) targetWeight.set(target, weight * 0.25);
  }
  return { rows, index, targetWeight, tokenWeight: rarity(count(tokens.values())), tokens };
}

export function neighboursOf(seed: Row, affinity: Affinity, limit = 12): Neighbour[] {
  const seedTargets = new Set(affinity.index.get(seed.file) ?? []);
  const seedTokens = new Set(affinity.tokens.get(seed.file) ?? []);
  const found: Neighbour[] = [];
  for (const row of affinity.rows) {
    if (row.file === seed.file) continue;
    const targets = (affinity.index.get(row.file) ?? []).filter(target => seedTargets.has(target));
    const tokens = (affinity.tokens.get(row.file) ?? []).filter(token => seedTokens.has(token));
    const score = targets.reduce((sum, target) => sum + (affinity.targetWeight.get(target) ?? 0), 0)
      + 0.5 * tokens.reduce((sum, token) => sum + (affinity.tokenWeight.get(token) ?? 0), 0);
    // Below this a pair shares only something nearly every test shares.
    if (score < 0.2) continue;
    found.push({ file: row.file, score: Math.round(score * 1000) / 1000,
      relation: TIER_LEVEL[row.tier] === TIER_LEVEL[seed.tier] ? "horizontal" : "vertical",
      shared: [...targets.filter(target => !target.startsWith("pkg:")), ...tokens.map(token => `name:${token}`)] });
  }
  return found.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1)).slice(0, limit);
}
