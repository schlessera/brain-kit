/**
 * CLI commands hold no SQL (#1353, epic #1341): no file under
 * `src/cli/commands/` calls `.prepare(`, `.query(`, `.run(` or `.exec(` on a
 * bun:sqlite database or statement. Index reads and writes live in named
 * functions under `src/lib/` (or `src/queries/`), which the commands call.
 *
 * Detection is type-aware (the TypeScript compiler API): a call counts when the
 * method it resolves to is declared by bun:sqlite, so a command's own `.run(`
 * (`CoreCommand.run`) is not one, and a database reached through an alias or a
 * helper's return value still is. A `.prepare(` or `.query(` whose method the
 * checker cannot resolve (an `any` handle) counts too.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve, sep } from "path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../../..");
const COMMANDS = resolve(import.meta.dir, "../src/cli/commands");
const SQL_METHODS = new Set(["prepare", "query", "run", "exec"]);
const UNTYPED_SQL_METHODS = new Set(["prepare", "query"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => join(dir, f))
    .sort();
}

/** Whether `declaration` is inside bun:sqlite's `declare module "bun:sqlite"`. */
function fromBunSqlite(declaration: ts.Declaration): boolean {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === "bun:sqlite") return true;
  }
  return false;
}

/** Every `file:line: receiver.method(` call on a bun:sqlite handle in `files`. */
export function findDatabaseCalls(files: string[]): string[] {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, join(ROOT, "tsconfig.json"));
  const program = ts.createProgram(files, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const found: string[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`not in the program: ${file}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (SQL_METHODS.has(method)) {
          const declarations = checker.getSymbolAtLocation(node.expression.name)?.declarations ?? [];
          const sql = declarations.length === 0 ? UNTYPED_SQL_METHODS.has(method) : declarations.some(fromBunSqlite);
          if (sql) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            found.push(`${relative(ROOT, file).split(sep).join("/")}:${line + 1}: ${node.expression.getText(source).replace(/\s+/g, " ")}(`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("CLI commands hold no SQL", () => {
  test("no file under src/cli/commands/ prepares, queries or runs a statement on a database", () => {
    const files = sourceFiles(COMMANDS);
    expect(files.length).toBeGreaterThan(0);
    expect(findDatabaseCalls(files)).toEqual([]);
  });

  test("the detector finds database calls and leaves other .run( calls alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-no-sql-"));
    try {
      const probe = join(dir, "probe.ts");
      writeFileSync(
        probe,
        [
          'import { Database } from "bun:sqlite";',
          'const db = new Database(":memory:");',
          'db.prepare("SELECT 1").get();',
          'db.query("SELECT 2").all();',
          'db.run("SELECT 3");',
          'const alias = db;',
          'const statement = alias.prepare("SELECT 4");',
          "statement.run();",
          "const command = { run(args: string[]) { return args; } };",
          'command.run(["x"]);',
          "const loose: any = db;",
          'loose.query("SELECT 5");',
          "loose.run();",
          "",
        ].join("\n")
      );
      expect(findDatabaseCalls([probe]).map((hit) => hit.slice(hit.indexOf(":") + 1))).toEqual([
        '3: db.prepare(',
        '4: db.query(',
        '5: db.run(',
        '7: alias.prepare(',
        '8: statement.run(',
        '12: loose.query(',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
