/** Discovered product proof ownership, with source assertion/scenario locations. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { FAST_TESTS } from "./ci-plan";
import { discoverTests } from "./test-shards";
import { browserInventory, type Spec } from "./proof-inputs";
import { readBrowserCosts } from "./browser-shards";

export type Domain = "fast" | "unit" | "browser" | "layout" | "endurance";
const fast = new Set(Object.values(FAST_TESTS).flat());
export function browserDomain(spec: Spec): Domain {
  if (spec.project === "ui-react-endurance") return "endurance";
  if (spec.project === "ui-react-layout") return "layout";
  return "browser";
}
export function assertInventory(specs: readonly Spec[], leaves: readonly string[]): void {
  const keys = specs.map(spec => `${spec.project}::${spec.file}`);
  if (keys.length !== new Set(keys).size) throw new Error("Duplicate proof scenario ownership");
  for (const file of leaves) if (!specs.some(spec => spec.file === file)) throw new Error(`Undiscovered browser scenario: ${file}`);
  for (const spec of specs) {
    if (spec.file.endsWith(".endurance.tsx") !== (browserDomain(spec) === "endurance")) throw new Error(`Wrong endurance ownership: ${spec.project}::${spec.file}`);
  }
}

/** Locations are declarations, not a fabricated expansion of runtime parameter tables.
 * The project/file plus source location identifies each default execution instance.
 * Shared helper assertions stay explicit instead of being attributed to one caller. */
export function sourceAssertions(source: string, file: string): { scenarios: { line: number; declaration: string }[]; assertions: number[] } {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scenarios: { line: number; declaration: string }[] = [];
  const assertions: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      if (/^(test|it)(?:\.(?:each|for|skip|todo|only|concurrent|sequential|fails|skipIf|runIf))*$/.test(callee) && node.arguments.length) {
        scenarios.push({ line, declaration: node.arguments[0]!.getText(ast) });
      }
      if (/^(?:expect|assert)(?:\.|$)/.test(callee) || /^(?:expect|assert)\(/.test(callee)) assertions.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { scenarios, assertions: [...new Set(assertions)].sort((a, b) => a - b) };
}

export async function proofInventory(root: string) {
  const specs = await browserInventory(root);
  const leaves = [...new Bun.Glob("packages/**/*.{layout,offline,endurance,visual,pointer}.tsx").scanSync({ cwd: root })].sort();
  assertInventory(specs, leaves);
  // A side-effect import would execute a moved scenario in two projects.
  for (const spec of specs) {
    const source = readFileSync(join(root, spec.file), "utf8");
    if (/from\s*["'][^"']*\.endurance|import\s*["'][^"']*\.endurance/.test(source)) throw new Error(`Imported endurance scenario: ${spec.file}`);
  }
  const costs = readBrowserCosts(join(root, "scripts/browser-shard-costs.json"));
  const rows = [
    ...discoverTests(root, ["packages", "tests"]).map(file => ({ key: `bun::${file}`, file, domain: fast.has(file) ? "fast" as const : "unit" as const })),
    ...specs.map(spec => ({ key: `${spec.project}::${spec.file}`, file: spec.file, domain: browserDomain(spec) })),
  ].map(row => ({ ...row, ...sourceAssertions(readFileSync(join(root, row.file), "utf8"), row.file),
    measuredSeconds: costs.seconds[row.key] ?? null }));
  if (rows.length !== new Set(rows.map(row => row.key)).size) throw new Error("Duplicate proof inventory key");
  return { version: 1, rows, unmeasuredBrowserSpecs: rows.filter(row => ["browser", "layout", "endurance"].includes(row.domain) && row.measuredSeconds === null).map(row => row.key) };
}
if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const inventory = await proofInventory(root);
    await Bun.write(join(root, "tmp/proof-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
    console.log(`Discovered ${inventory.rows.length} product execution instances; ${inventory.unmeasuredBrowserSpecs.length} browser costs remain explicitly unmeasured (never excluded). See tmp/proof-inventory.json.`);
  } catch (error) { console.error(error); process.exit(1); }
}
