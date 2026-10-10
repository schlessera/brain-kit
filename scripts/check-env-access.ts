// Refuses ambient `process.env` access outside each package's chokepoint.
//
// Why: ui-server grew 31 distinct env reads across 59 sites while its factory
// options listed 5 fields — the only complete list of its configuration lived
// in a DOWNSTREAM repo's .env.example. A published library whose config
// contract is discoverable only by grepping its source drifts by construction.
// Three rules, checked over packages/*/src/**:
//
//   1. `process.env` may appear in a package only in `src/config/env.ts` — the
//      chokepoint that exports a typed descriptor of every variable the
//      package reads. Everywhere else, config arrives as a value.
//   2. No module-scope `const`/`let`/`var` initialised from `process.env`,
//      even inside the chokepoint: a top-level read freezes the value at
//      import time, so it cannot be varied per instance or per test.
//   3. No writes, anywhere: `process.env.X = …`, `process.env[k] = …` and
//      `delete process.env.X` mutate global state for every other consumer in
//      the process — the Gemini providers did exactly this across an `await`.
//   4. No `import.meta.env`, anywhere. It is the browser-side version of the
//      same mistake and it has no chokepoint that could contain it: the value
//      is injected by whichever bundler the CONSUMER runs, so a library that
//      reads it silently supports exactly one bundler. ui-react read
//      `VITE_BACKEND_URL` this way, which left a webpack or Next.js consumer
//      with no way to reach a split-topology backend at all. Browser packages
//      take configuration through their own boot call (`configureBrainUi`).
//
// Detection is AST-based (the TypeScript compiler API), so comments and string
// literals mentioning process.env do not trip it.

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import ts from "typescript";

// `env.ts` is the per-package chokepoint; `env-core.ts` is the shared core
// they are built on (@schlessera/brain-common), whose `readEnvVar` defaults
// its parameter to `process.env`. Both are deliberate chokepoint files;
// nothing else in a package may touch the environment.
const CHOKEPOINT = /^packages\/(?:[^/]+\/src\/config\/env|common\/src\/env-core)\.ts$/;

interface Finding {
  file: string;
  line: number;
  column: number;
  rule: 1 | 2 | 3 | 4;
  message: string;
}

/** True for `process.env` written as a property or element access. */
function isProcessEnv(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.expression) && node.expression.text === "process" &&
      node.name.text === "env";
  }
  if (ts.isElementAccessExpression(node)) {
    return ts.isIdentifier(node.expression) && node.expression.text === "process" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "env";
  }
  return false;
}

/**
 * True for `import.meta.env`, however it is spelled — including the cast form
 * `(import.meta as { env?: … }).env` that a library uses to read it
 * defensively outside a bundler.
 */
function isImportMetaEnv(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "env") return false;
  let target: ts.Node = node.expression;
  // Unwrap parentheses and `as`/`satisfies` casts around `import.meta`.
  for (;;) {
    if (ts.isParenthesizedExpression(target)) target = target.expression;
    else if (ts.isAsExpression(target) || ts.isSatisfiesExpression(target)) target = target.expression;
    else break;
  }
  return ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword;
}

/** The assignment / delete construct this access participates in, if any. */
function writeKind(node: ts.Node): string | null {
  // `process.env.X = …` / `process.env[k] = …`: the access is the object of
  // one more access level, which is the LHS of an assignment.
  let target: ts.Node = node;
  if (
    node.parent &&
    (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
    (node.parent as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression === node
  ) {
    target = node.parent;
  }
  const parent = target.parent;
  if (!parent) return null;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return "assignment to process.env";
  }
  if (ts.isDeleteExpression(parent)) return "delete of a process.env entry";
  // `Object.assign(process.env, …)` hands the object out for mutation.
  if (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === target &&
    parent.expression.getText() === "Object.assign"
  ) {
    return "Object.assign into process.env";
  }
  return null;
}

/** True if the access sits inside a module-scope variable initializer. */
function isModuleScopeFreeze(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    // Once we hit any function-like boundary, the read happens at call time,
    // which is exactly what the rule wants to allow.
    if (ts.isFunctionLike(current)) return false;
    if (ts.isVariableStatement(current)) {
      return ts.isSourceFile(current.parent);
    }
  }
  return false;
}

export function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const record = (node: ts.Node, rule: 1 | 2 | 3 | 4, message: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: line + 1, column: character + 1, rule, message });
  };

  const visit = (node: ts.Node) => {
    if (isProcessEnv(node)) {
      const write = writeKind(node);
      if (write) {
        record(node, 3, `${write} — process.env is process-global state; never mutate it`);
      }
      if (!CHOKEPOINT.test(file)) {
        record(
          node,
          1,
          "process.env outside the chokepoint — read it in this package's " +
            "src/config/env.ts and pass the value in"
        );
      }
      if (isModuleScopeFreeze(node)) {
        record(
          node,
          2,
          "module-scope binding initialised from process.env — this freezes " +
            "config at import time; resolve it inside a function instead"
        );
      }
    }
    if (isImportMetaEnv(node)) {
      record(
        node,
        4,
        "import.meta.env in a published package — that binds the library to one " +
          "bundler; take the value through the package's boot configuration instead"
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function scanPackages(root: string): Finding[] {
  const glob = new Bun.Glob("packages/*/src/**/*.{ts,tsx}");
  const files = [...glob.scanSync({ cwd: root })].sort();
  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...scanSource(file, readFileSync(resolve(root, file), "utf8")));
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = scanPackages(root);
  if (findings.length === 0) {
    console.log(
      "All process.env access goes through the per-package chokepoints, and no " +
        "package reads import.meta.env."
    );
    process.exit(0);
  }

  console.error("Ambient environment access found:");
  for (const f of findings) {
    console.error(`  ${relative(root, resolve(root, f.file))}:${f.line}:${f.column}: [rule ${f.rule}] ${f.message}`);
  }
  const byRule = [1, 2, 3, 4].map(
    (r) => `rule ${r}: ${findings.filter((f) => f.rule === r).length}`
  );
  console.error(
    `\n${findings.length} finding(s) (${byRule.join(", ")}). Each package reads its ` +
      "environment in exactly one file, src/config/env.ts, which exports a typed " +
      "descriptor of every variable."
  );
  process.exit(1);
}
