import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { ROOT } from "../scripts/check-citations.ts";

function runChecker(directory: string) {
  return Bun.spawnSync([process.execPath, "scripts/check-citations.ts"], {
    cwd: directory, stdout: "pipe", stderr: "pipe",
  });
}

function fixture(run: (directory: string, source: string, command: () => ReturnType<typeof runChecker>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "docs-citation-proof-"));
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "docs", "decisions"), { recursive: true });
    mkdirSync(join(directory, "src"));
    const checker = readFileSync(join(ROOT, "scripts/check-citations.ts"), "utf8");
    const parsed = ts.createSourceFile("check-citations.ts", checker, ts.ScriptTarget.Latest, true);
    const declaration = parsed.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    ).find((node) => ts.isIdentifier(node.name) && node.name.text === "CITATION_EXCEPTIONS");
    expect(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer)).toBe(true);
    const ledger = declaration!.initializer!;
    // This tiny repository has no historical exceptions. Copy executable code
    // unchanged, replacing only the real repository's static exception data.
    writeFileSync(join(directory, "scripts/check-citations.ts"),
      checker.slice(0, ledger.getStart(parsed)) + "{}" + checker.slice(ledger.getEnd()));
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: directory });
    expect(init.exitCode).toBe(0);
    const source = "src/hooks.ts";
    writeFileSync(join(directory, source), "// fixture source\nexport const citationProof = true;\n");
    const command = () => runChecker(directory);
    run(directory, source, command);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the command discovers nested guides, plans and investigations outside decisions", () => {
  fixture((directory, source, command) => {
    const before = command();
    const count = (output: string) => Number(output.match(/(\d+) citation\(s\):/)?.[1]);
    const baseline = count(before.stdout.toString());
    expect(Number.isFinite(baseline)).toBe(true);
    for (const subject of ["guides", "plans", "investigations"]) {
      const folder = join(directory, "docs", subject);
      mkdirSync(folder);
      const file = join(folder, "README.md");
      writeFileSync(file, "(`citationProof`, `" + source + ":2`)\n");
    }
    const result = command();
    // Exactly three independently supplied citations must be discovered.
    expect(count(result.stdout.toString()) - baseline).toBe(3);
    expect(before.exitCode).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});

test("the command exits unsuccessfully for drift in a non-decision document", () => {
  fixture((directory, source, command) => {
    const file = join(directory, "docs", "guide.md");
    writeFileSync(file, "(`citationProof`, `" + source + ":3`)\n");
    const result = command();
    expect(result.stdout.toString()).toContain(`${relative(directory, file)}:1`);
    expect(result.stdout.toString()).toContain("does not start on `citationProof`");
    expect(result.exitCode).toBe(1);
  });
});
