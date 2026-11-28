// Refuses `db.prepare(sql)` in ui-server source where `db.query(sql)` is meant (#4808).
//
// Why: `bun:sqlite` has two ways to get a statement. `db.query(sql)` compiles
// once per distinct SQL string and keeps the statement on the `Database`;
// `db.prepare(sql)` compiles a new statement on every call. A `prepare` inside
// a function therefore recompiles its SQL on every request, and on the write
// worker's connection the fresh statement is wrapped again as well. ui-server
// takes fixed-text statements from `db.query`.
//
// `prepare` stays right in three cases, and each such site is in ALLOWED with
// its reason:
//   - a statement created once and kept for its owner's lifetime;
//   - SQL whose text varies per call (a per-table name, an `IN (…)` list sized
//     per call): `db.query` would keep one cached statement per distinct text
//     for the life of the connection;
//   - a statement that must have a cursor of its own: a cached statement is
//     shared, so running the same SQL again while an `.iterate()` over it is
//     open invalidates that iterator.
//
// The rule: under packages/ui-server/src, a call `<anything>.prepare(<first>)`
// whose first argument is SQL text is refused unless an ALLOWED entry names the
// file and matches that argument. SQL text is a string, template or tagged
// template literal, a conditional or `+` concatenation with one, a name that
// says `sql` (a constant such as `UPSERT_SESSION_SQL`, a `sql.replace(…)`
// call), or a name whose `const` in its own scope is SQL text (#4997, #5008):
// the nearest enclosing block, function or file that declares the name (a
// `var` declares it for its whole function or file, from any nested block or
// `for` header, #5048), so a short name such as `stmt` reused across
// functions resolves in each. Any other declaration of the name there
// resolves to nothing. Other
// objects' `prepare` methods (`boundary.prepare()`, `operation.prepare()`,
// `privateIndexes.prepare({…})`) take no SQL and are not flagged. Detection is
// AST-based (the TypeScript compiler API), so comments and strings that mention
// `prepare(` do not trip it. Every ALLOWED entry must match exactly one site,
// so a stale entry fails as well.

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import ts from "typescript";
import { parse, treeFiles } from "./lib/source";

export interface Allowed { file: string; match: RegExp; reason: string }

/** The `prepare` sites that stay on `prepare`, each matched by its SQL argument's text. */
export const ALLOWED: readonly Allowed[] = [
  {
    file: "packages/ui-server/src/drafts/store.ts",
    match: /^"SELECT draft_id, session_id, revision, text, attachment_ids, file_ids, outgoing_snapshots, updated_at, deleted_at FROM session_drafts WHERE draft_id = \?"$/,
    reason: "selectDraft: created once per draft store and kept for its lifetime",
  },
  {
    file: "packages/ui-server/src/drafts/store.ts",
    match: /^"SELECT attachment_id, mime, name, bytes, size_bytes, attached FROM session_draft_attachments WHERE draft_id = \?"$/,
    reason: "selectAttachments: created once per draft store and kept for its lifetime",
  },
  {
    file: "packages/ui-server/src/drafts/store.ts",
    match: /^"SELECT attachment_id, size_bytes, attached FROM session_draft_attachments WHERE draft_id = \?"$/,
    reason: "selectAttachmentSizes: created once per draft store and kept for its lifetime",
  },
  {
    file: "packages/ui-server/src/inbox/snapshot.ts",
    match: /^`INSERT INTO "\$\{row\.name\}" VALUES/,
    reason: "SQL built per table name and column count, on a throwaway copy database closed after the export",
  },
  {
    file: "packages/ui-server/src/db/client.ts",
    match: /^journal \? `INSERT INTO \$\{JOURNAL_MIGRATIONS_TABLE\}/,
    reason: "the migration receipt insert: runs once per migration file while the database opens, never again on that connection",
  },
  {
    file: "packages/ui-server/src/ws/chat-store-cleanup.ts",
    match: /^sql\.replace\("\(\?\)", `\(\$\{marks\(values\)\}\)`\)$/,
    reason: "the IN (…) list is sized per call, so the SQL text varies with the input",
  },
  {
    file: "packages/ui-server/src/ws/local-exchanges.ts",
    match: /^`UPDATE local_exchanges SET delivered_at = \?[\s\S]*\$\{exchangeIds\.map/,
    reason: "the IN (…) list is sized per call, so the SQL text varies with the input",
  },
];

const SCOPE = "packages/ui-server/src/**/*.{ts,tsx}";

export interface Site { file: string; line: number; column: number; sql: string }
export interface Finding extends Site { message: string }

/** Strip parentheses and `as`/`satisfies`/`!` wrappers from an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
    else return node;
  }
}

const SQL_NAME = /sql/i;

/** Whether a binding name (an identifier or a destructuring pattern) binds `name`. */
function binds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name, name));
}

/**
 * Whether a `var` anywhere in a function's or file's own body declares `name`,
 * in a nested block or a `for` header too, but not inside a nested function:
 * a `var` is function-scoped wherever it sits (#5048).
 */
function declaresVar(scope: ts.Node, name: string): boolean {
  const walk = (node: ts.Node): boolean => {
    if (node !== scope && ts.isFunctionLike(node)) return false;
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped) &&
      node.declarations.some((declaration) => binds(declaration.name, name))) return true;
    return ts.forEachChild(node, walk) === true;
  };
  return walk(scope);
}

/**
 * What `name` is in one scope node: the initializer of a plain `const` that
 * declares it there, `null` when something else declares it there (a `let`,
 * a `var`, a parameter, a destructuring, a function or class), or `undefined`
 * when this scope does not declare it. A function or the file also declares
 * every `var` in its body, however deeply nested.
 */
function declaredIn(scope: ts.Node, name: string): ts.Expression | null | undefined {
  if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => binds(parameter.name, name))) return null;
  if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(scope.variableDeclaration.name, name)) return null;
  const lists: ts.VariableDeclarationList[] = [];
  let statements: readonly ts.Statement[] = [];
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    statements = scope.statements;
  } else if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    lists.push(scope.initializer);
  }
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) lists.push(statement.declarationList);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return null;
  }
  for (const list of lists) {
    for (const declaration of list.declarations) {
      if (!binds(declaration.name, name)) continue;
      const plainConst = list.flags & ts.NodeFlags.Const && ts.isIdentifier(declaration.name) && declaration.initializer;
      return plainConst ? declaration.initializer! : null;
    }
  }
  if ((ts.isFunctionLike(scope) || ts.isSourceFile(scope)) && declaresVar(scope, name)) return null;
  return undefined;
}

/**
 * The `const` initializer a name refers to where it is used: the nearest
 * enclosing block, function or file that declares it (#5008). A `let`, `var`
 * or parameter of the same name shadows it and resolves to nothing.
 */
function constInitializer(use: ts.Identifier): ts.Expression | null {
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    const found = declaredIn(scope, use.text);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * Whether an expression is SQL text: a literal, a combination of one, a name
 * that says so, or a name whose `const` initializer in its own scope is SQL text.
 */
function isSqlText(node: ts.Expression, seen = new Set<ts.Expression>()): boolean {
  const sql = (next: ts.Expression) => isSqlText(next, seen);
  node = unwrap(node);
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isTaggedTemplateExpression(node)) return true;
  if (ts.isConditionalExpression(node)) return sql(node.whenTrue) || sql(node.whenFalse);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return sql(node.left) || sql(node.right);
  }
  if (ts.isIdentifier(node)) {
    if (SQL_NAME.test(node.text)) return true;
    const initializer = constInitializer(node);
    // The cycle guard: a name met again on one resolution path is not SQL text.
    if (!initializer || seen.has(initializer)) return false;
    seen.add(initializer);
    return sql(initializer);
  }
  if (ts.isPropertyAccessExpression(node)) return SQL_NAME.test(node.name.text);
  // `sql.replace(…)`, `SQL.trim()`: a string method called on SQL text.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) return sql(node.expression.expression);
  return false;
}

/** Every `.prepare(<SQL text>, …)` call in one source file. */
function sqlPrepareSites(file: string, text: string): Site[] {
  const source = parse(file, text);
  const sites: Site[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "prepare" && node.arguments.length > 0 && isSqlText(node.arguments[0]!)) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.expression.name.getStart(source));
      sites.push({ file, line: line + 1, column: character + 1, sql: node.arguments[0]!.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

export interface Result { findings: Finding[]; allowed: (Site & { reason: string })[]; unmatched: Allowed[] }

/** Checks `files` (path → text) against `allow`. */
export function check(files: ReadonlyMap<string, string>, allow: readonly Allowed[] = ALLOWED): Result {
  const findings: Finding[] = [], allowed: Result["allowed"] = [];
  const matched = new Map<Allowed, number>();
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    for (const site of sqlPrepareSites(file, text)) {
      const entry = allow.find((candidate) => candidate.file === file && candidate.match.test(site.sql));
      if (entry) {
        matched.set(entry, (matched.get(entry) ?? 0) + 1);
        allowed.push({ ...site, reason: entry.reason });
      } else {
        findings.push({ ...site, message: "db.prepare() compiles its SQL on every call — use db.query(), which " +
          "compiles a fixed SQL string once per connection, or add the site to ALLOWED with its reason" });
      }
    }
  }
  // An entry must match exactly one site: a stale or over-broad entry is a hole in the gate.
  const unmatched = allow.filter((entry) => matched.get(entry) !== 1 && files.has(entry.file));
  return { findings, allowed, unmatched };
}

export function scanTree(root: string): Result {
  const files = new Map<string, string>();
  for (const file of treeFiles(root, SCOPE)) files.set(file, readFileSync(resolve(root, file), "utf8"));
  const result = check(files);
  // An entry whose file is gone is stale too.
  for (const entry of ALLOWED) if (!files.has(entry.file)) result.unmatched.push(entry);
  return result;
}

/** The gate as `bun run lint` runs it: prints its findings, returns its exit code. */
export function lintGate(root: string): number {
  const { findings, allowed, unmatched } = scanTree(root);
  const where = (site: Site) => `${relative(root, resolve(root, site.file))}:${site.line}:${site.column}`;
  if (findings.length === 0 && unmatched.length === 0) {
    console.log("ui-server takes fixed-text SQLite statements from db.query(); the prepare() sites that stay:");
    for (const site of allowed) console.log(`  ${where(site)}: ${site.reason}`);
    return 0;
  }
  if (findings.length) {
    console.error("db.prepare() with SQL text in ui-server source, where db.query() is meant:");
    for (const f of findings) console.error(`  ${where(f)}: ${f.message}`);
  }
  if (unmatched.length) {
    console.error("ALLOWED entries in scripts/check-sqlite-prepare.ts that do not match exactly one site:");
    for (const entry of unmatched) console.error(`  ${entry.file} ${entry.match}: ${entry.reason}`);
  }
  console.error(`\n${findings.length + unmatched.length} finding(s); see scripts/check-sqlite-prepare.ts.`);
  return 1;
}

if (import.meta.main) process.exit(lintGate(resolve(process.argv[2] ?? process.cwd())));
