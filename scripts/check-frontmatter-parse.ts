// Refuses frontmatter parsing that can reach gray-matter's global cache (#142).
//
// Why: `matter(input)` without options caches every input string for the
// life of the process and answers byte-identical input from that cache with a
// shallow copy. Two identical documents then share one nested `data` object,
// so a writer mutating one changes what the other reads; a parse that threw is
// answered from the cache as an empty success; and the cache never evicts.
// Passing any options object skips the cache. Rather than make every call site
// remember that, parsing goes through `parseFrontmatter`
// (`packages/*/src/lib/frontmatter-parse.ts`), which always passes one. The
// decision record is docs/decisions/frontmatter-parsing.md.
//
// Two rules, over every package's src/tests/scripts and the root scripts/ and
// tests/:
//
//   1. gray-matter may be loaded only by the files in ALLOWED below, each with
//      its reason. Everything else imports `parseFrontmatter`. Every way of
//      loading a module counts: `import`, `import type`, `export … from`,
//      `import x = require()`, `require()` and `import()`.
//   2. Inside an allowed file, the gray-matter binding may only be called with
//      an object literal where gray-matter takes its options (`matter(s, {…})`,
//      `matter.stringify(s, d, {…})`), or named in a type. An options argument
//      that is a variable can be undefined at run time, which re-enters the
//      cache; handing the binding to anything else (an alias, a re-export,
//      `matter.read`, `matter.cache`) is a way around the rule, so it is
//      refused too. A `cache-probe` file is the exception: it is the test that
//      proves the helper ignores the cache, and must seed and read it.
//
// Detection is AST-based (the TypeScript compiler API), so comments and string
// literals mentioning gray-matter do not trip it.

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import ts from "typescript";

type Role = "helper" | "serializer" | "cache-probe";

/** The only files that may load gray-matter, and why each one may. */
export const ALLOWED: ReadonlyArray<{ pattern: RegExp; role: Role; reason: string }> = [
  {
    pattern: /^packages\/[^/]+\/src\/lib\/frontmatter-parse\.ts$/,
    role: "helper",
    reason:
      "the cache-free parse helper; its copies are held byte-identical by tests/frontmatter-parse-sync.test.ts",
  },
  {
    pattern: /^packages\/core\/src\/lib\/frontmatter\.ts$/,
    role: "serializer",
    reason:
      "stringifyDocument's matter.stringify; it parses its content argument only with the options it is given, which are always a literal",
  },
  {
    pattern: /^packages\/core\/tests\/frontmatter-parse\.test\.ts$/,
    role: "cache-probe",
    reason: "seeds and reads gray-matter's cache to prove parseFrontmatter neither reads nor grows it",
  },
];

const SCANNED = [
  "packages/*/src/**/*.{ts,tsx,js,mjs,cjs}",
  "packages/*/tests/**/*.{ts,tsx,js,mjs,cjs}",
  "packages/*/scripts/**/*.{ts,tsx,js,mjs,cjs}",
  "scripts/**/*.{ts,tsx,js,mjs,cjs}",
  "tests/**/*.{ts,tsx,js,mjs,cjs}",
];

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: 1 | 2;
  message: string;
}

const isGrayMatter = (specifier: string) => specifier === "gray-matter" || specifier.startsWith("gray-matter/");

/** Strip parentheses and `as`/`satisfies`/`!` wrappers from an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
    else return node;
  }
}

/** The specifier a node loads, if it loads a module by a literal name. */
function loadedModule(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteralLike(node.moduleReference.expression)) return node.moduleReference.expression.text;
  if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) return node.arguments[0].text;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    return node.argument.literal.text;
  }
  return undefined;
}

export function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const allowed = ALLOWED.find((entry) => entry.pattern.test(file));
  const findings: Finding[] = [];
  const record = (node: ts.Node, rule: 1 | 2, message: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: line + 1, column: character + 1, rule, message });
  };

  // Rule 1, and the local names an allowed file binds gray-matter's default to.
  const bindings = new Set<string>();
  const visitLoads = (node: ts.Node) => {
    const specifier = loadedModule(node);
    if (specifier !== undefined && isGrayMatter(specifier)) {
      if (!allowed) {
        record(node, 1, "gray-matter loaded outside its designated files — parse with parseFrontmatter " +
          "from this package's src/lib/frontmatter-parse.ts, which keeps every parse out of the global cache");
      } else if (ts.isImportDeclaration(node) && specifier === "gray-matter") {
        const clause = node.importClause;
        if (clause?.name) bindings.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text);
        if (named && ts.isNamedImports(named) && allowed.role !== "cache-probe") {
          record(node, 2, "named import from gray-matter — use its default export, called with a literal options object");
        }
      } else if (allowed.role !== "cache-probe") {
        record(node, 2, "gray-matter loaded other than by a default import — the binding cannot be checked");
      }
    }
    ts.forEachChild(node, visitLoads);
  };
  visitLoads(source);
  if (!allowed || allowed.role === "cache-probe" || bindings.size === 0) return findings;

  // Rule 2: every reference to the binding is a literal-options call or a type.
  const hasLiteral = (args: ts.NodeArray<ts.Expression>, index: number) =>
    args.length > index && ts.isObjectLiteralExpression(unwrap(args[index]));
  const visitUses = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && bindings.has(node.text)) {
      const parent = node.parent;
      // `matter.X` in `interface I extends matter.X<…>` parses as an expression, but names a type.
      const isHeritageType = ts.isPropertyAccessExpression(parent) && parent.expression === node &&
        ts.isExpressionWithTypeArguments(parent.parent) && ts.isHeritageClause(parent.parent.parent) &&
        ts.isInterfaceDeclaration(parent.parent.parent.parent);
      const isType = ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) ||
        isHeritageType;
      // A property name (`x.matter`) or object key that happens to share the name is not the binding.
      const notTheBinding = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      const call = ts.isCallExpression(parent) && parent.expression === node ? parent : undefined;
      const stringify = ts.isPropertyAccessExpression(parent) && parent.expression === node &&
        parent.name.text === "stringify" && ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent ? parent.parent : undefined;
      if (isType || notTheBinding) {
        // fine
      } else if (call) {
        if (!hasLiteral(call.arguments, 1)) {
          record(call, 2, "gray-matter called without a literal options object — without options it reads " +
            "and fills the global cache; pass `{ ...options }`");
        }
      } else if (stringify) {
        if (!hasLiteral(stringify.arguments, 2)) {
          record(stringify, 2, "matter.stringify without a literal options object — it parses its content " +
            "argument through the cache when options are absent");
        }
      } else {
        record(node, 2, "gray-matter's binding used other than as a literal-options call — an alias, " +
          "re-export or other member (read, cache, test) would bypass the rule");
      }
    }
    ts.forEachChild(node, visitUses);
  };
  visitUses(source);
  return findings;
}

export function scanTree(root: string): Finding[] {
  const files = new Set<string>();
  for (const pattern of SCANNED) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      if (!/(^|\/)(node_modules|dist)\//.test(file)) files.add(file);
    }
  }
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    findings.push(...scanSource(file, readFileSync(resolve(root, file), "utf8")));
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = scanTree(root);
  if (findings.length === 0) {
    console.log("All frontmatter parsing goes through parseFrontmatter; gray-matter is loaded only by its designated files.");
    process.exit(0);
  }
  console.error("Frontmatter parsing that can reach gray-matter's global cache:");
  for (const f of findings) {
    console.error(`  ${relative(root, resolve(root, f.file))}:${f.line}:${f.column}: [rule ${f.rule}] ${f.message}`);
  }
  console.error(
    `\n${findings.length} finding(s). Parse with parseFrontmatter (src/lib/frontmatter-parse.ts in the ` +
      "package); see docs/decisions/frontmatter-parsing.md."
  );
  process.exit(1);
}
