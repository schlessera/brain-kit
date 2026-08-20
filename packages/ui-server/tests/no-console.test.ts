/**
 * This package reports through its observability layer, not through `console`.
 *
 * Not style. A `console.warn` cannot be filtered by severity, cannot be
 * asserted on by a test, cannot carry structured attributes, and cannot be
 * routed anywhere else later — which is why 31 of them accumulated here while
 * the only aggregate surface, `/api/status`, knew nothing about any of it. The
 * rule is what stops the next one appearing.
 *
 * `src/observability/loggers.ts` is the one exemption, because it IS the
 * console consumer: something has to call console eventually.
 *
 * AST-based, so the shell command inside an auth error message — which
 * contains the text `console.log` as a literal — does not trip it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, relative, resolve } from "path";
import ts from "typescript";

const SRC = resolve(import.meta.dir, "../src");
const EXEMPT = ["observability/loggers.ts"];

/** True for a call whose callee is `console.<anything>`. */
function isConsoleCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "console"
  );
}

function consoleCallsIn(file: string): number[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (isConsoleCall(node)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("console discipline", () => {
  test("the detector sees a real call and ignores the same text in a string", () => {
    // A gate is worth what it catches, so prove it both ways before trusting
    // that the tree happens to pass.
    const fixture = `
      const advice = "run: console.log(await Bun.password.hash(x))";
      console.warn("real call");
      logger.emit({ body: advice });
    `;
    const source = ts.createSourceFile("f.ts", fixture, ts.ScriptTarget.ESNext, true);
    let found = 0;
    const visit = (n: ts.Node) => {
      if (isConsoleCall(n)) found++;
      ts.forEachChild(n, visit);
    };
    visit(source);
    expect(found).toBe(1);
  });

  test("no module outside the console consumer calls console", () => {
    const glob = new Bun.Glob("**/*.ts");
    const offenders: string[] = [];

    for (const rel of [...glob.scanSync({ cwd: SRC })].sort()) {
      if (EXEMPT.includes(rel)) continue;
      for (const line of consoleCallsIn(join(SRC, rel))) {
        offenders.push(`src/${rel}:${line}`);
      }
    }

    expect(
      offenders,
      "report through the injected Observability (logger.emit / counter.add) " +
        "instead of console — see src/observability/index.ts"
    ).toEqual([]);
  });

  test("the exemption still exists, so the list cannot rot silently", () => {
    for (const rel of EXEMPT) {
      expect(consoleCallsIn(join(SRC, rel)).length).toBeGreaterThan(0);
      void relative(SRC, join(SRC, rel));
    }
  });
});
