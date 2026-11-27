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
// file and matches that argument. SQL text is a string or template literal, a
// conditional or `+` concatenation with one, or a name that says `sql` (a
// constant such as `UPSERT_SESSION_SQL`, a `sql.replace(…)` call). Other
// objects' `prepare` methods (`boundary.prepare()`, `operation.prepare()`,
// `privateIndexes.prepare({…})`) take no SQL and are not flagged. Detection is
// AST-based (the TypeScript compiler API), so comments and strings that mention
// `prepare(` do not trip it. Every ALLOWED entry must match exactly one site,
// so a stale entry fails as well.

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import ts from "typescript";

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

/** Whether an expression is SQL text: a literal, a combination of one, or a name that says so. */
export function isSqlText(node: ts.Expression): boolean {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isConditionalExpression(node)) return isSqlText(node.whenTrue) || isSqlText(node.whenFalse);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isSqlText(node.left) || isSqlText(node.right);
  }
  if (ts.isIdentifier(node)) return SQL_NAME.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return SQL_NAME.test(node.name.text);
  // `sql.replace(…)`, `SQL.trim()`: a string method called on SQL text.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) return isSqlText(node.expression.expression);
  return false;
}

/** Every `.prepare(<SQL text>, …)` call in one source file. */
export function sqlPrepareSites(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
  for (const file of new Bun.Glob(SCOPE).scanSync({ cwd: root })) files.set(file, readFileSync(resolve(root, file), "utf8"));
  const result = check(files);
  // An entry whose file is gone is stale too.
  for (const entry of ALLOWED) if (!files.has(entry.file)) result.unmatched.push(entry);
  return result;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { findings, allowed, unmatched } = scanTree(root);
  const where = (site: Site) => `${relative(root, resolve(root, site.file))}:${site.line}:${site.column}`;
  if (findings.length === 0 && unmatched.length === 0) {
    console.log("ui-server takes fixed-text SQLite statements from db.query(); the prepare() sites that stay:");
    for (const site of allowed) console.log(`  ${where(site)}: ${site.reason}`);
    process.exit(0);
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
  process.exit(1);
}
