import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { FIRST_PARTY_FAILURE_CLASSES } from "@schlessera/brain-ui-sdk/protocol";

const ROOT = resolve(import.meta.dir, "..");
const known = new Set<string>(Object.values(FIRST_PARTY_FAILURE_CLASSES));

/** Inventory literals assigned to errorClass and shared-registry references. */
function emittedClasses(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const classes: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
      && node.name.getText(ast).replace(/^["']|["']$/g, "") === "errorClass"
      && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      classes.push(node.initializer.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "errorClass"
      && ts.isStringLiteralLike(node.right)) classes.push(node.right.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "FIRST_PARTY_FAILURE_CLASSES") classes.push(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return classes;
}

describe("first-party failure-class inventory", () => {
  test("every errorClass literal emitted by first-party packages is registered", () => {
    let count = 0;
    for (const file of new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scanSync({ cwd: ROOT })) {
      if (file.includes(".test.")) continue;
      for (const errorClass of emittedClasses(file, readFileSync(join(ROOT, file), "utf8"))) {
        count++;
        expect(known.has(errorClass), `${file} emits unregistered errorClass: ${errorClass}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(10);
  });

  test("the inventory finds literal fields, assignments and registry references", () => {
    expect(emittedClasses("fixture.ts", `const a = { errorClass: "new_class" };
      class Refusal { readonly errorClass = 'early_class'; }
      a.errorClass = "assigned_class";
      const b = FIRST_PARTY_FAILURE_CLASSES.worker_host_unsupported;`))
      .toEqual(["new_class", "early_class", "assigned_class", "worker_host_unsupported"]);
  });

  test("all installed Claude SDK classes forwarded by the adapter are registered", () => {
    const sdkDir = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", ROOT));
    const ast = ts.createSourceFile("sdk.d.ts", readFileSync(join(sdkDir, "sdk.d.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.find((node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "SDKAssistantMessageError");
    expect(declaration).toBeDefined();
    if (!declaration || !ts.isUnionTypeNode(declaration.type)) throw new Error("SDK error vocabulary must be inventoried");
    for (const type of declaration.type.types) {
      if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) throw new Error("SDK error class is not a string literal");
      expect(known.has(type.literal.text), `Claude SDK emits unregistered errorClass: ${type.literal.text}`).toBe(true);
    }
  });

  test("the registry is immutable and each emitter key is its report value", () => {
    expect(Object.isFrozen(FIRST_PARTY_FAILURE_CLASSES)).toBe(true);
    for (const [key, value] of Object.entries(FIRST_PARTY_FAILURE_CLASSES)) expect(key).toBe(value);
  });
});
