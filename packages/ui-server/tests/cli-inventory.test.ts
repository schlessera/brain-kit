import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";
import { MIN_BRAIN_CLI_VERSION, STORAGE_PACK_CLI_VERSION } from "../src/brain/client";

// Release evidence: baseline argv is present in the 0.33.0 core tag (including
// the -- separator). Newer capabilities are recorded in core/CHANGELOG.md:
// d350daa8 (0.38.0), 3bcb1307 (0.39.0), 878e6cfa/c8e81adc/45035912 (0.40.0), and
// 8e5c9e8c/d57dc62b/d4eff9fc/e632b50b (0.41.0). These are availability
// floors, not claims that every baseline command first shipped in 0.33.0.
// Add a command AND each flag with release evidence when adding an invocation.
const available: Record<string, string> = {
  search: "0.33.0", briefing: "0.33.0", stats: "0.33.0", list: "0.33.0",
  read: "0.33.0", sync: "0.33.0", add: "0.33.0", index: "0.33.0", validate: "0.33.0",
  "storage pack": "0.44.0", // #2011: separately probed optional maintenance capability.
  "skills sync": "0.33.0", "scratch prune": "0.38.0", "module list": "0.33.0",
  "module enable": "0.40.0", "module disable": "0.40.0", "module settings": "0.40.0",
  "hygiene list": "0.39.0", "hygiene next": "0.41.0", "hygiene resolve": "0.41.0",
  "hygiene check": "0.41.0", "hygiene undo": "0.41.0", "hygiene dismiss": "0.41.0", "hygiene snooze": "0.41.0",
};
// Dynamic branches may overapproximate a command's flags. Record availability
// within its namespace; this inventory enforces versions, not valid usage.
const commandFlags: Record<string, Record<string, string>> = {
  search: { "--type": "0.33.0", "--tag": "0.33.0", "--limit": "0.33.0", "--mode": "0.33.0" },
  scratch: { "--pins-file": "0.42.0" }, // #1656, additive input for retained-answer pins.
  stats: { "--history": "0.40.0" },
  list: { "--type": "0.33.0", "--tag": "0.33.0", "--status": "0.33.0", "--relevance": "0.33.0", "--limit": "0.33.0" },
  sync: { "--human": "0.33.0" },
  add: { "--type": "0.33.0", "--title": "0.33.0", "--tags": "0.33.0" },
  index: { "--force": "0.33.0" },
  module: { "--stdin": "0.40.0", "--preview": "0.40.0", "--migrate": "0.40.0", "--revision": "0.40.0", "--action": "0.40.0" },
  hygiene: { "--finding": "0.41.0", "--dry-run": "0.41.0", "--handler": "0.41.0", "--input": "0.41.0", "--expect-fingerprint": "0.41.0", "--expect-preview": "0.41.0", "--reason": "0.41.0", "--until": "0.41.0" },
};
const globalFlags: Record<string, string> = { "--": "0.33.0", "--json": "0.33.0", "--version": "0.33.0" };
const root = resolve(import.meta.dir, "../../..");

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}
function scope(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (parent && !ts.isFunctionLike(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
  if (!parent) throw new Error("Missing argv scope");
  return parent;
}

// Scan the real invocations, not a list of exercised fixture methods. Follow
// local argv declarations, conditionals and pushes. The type checker expands
// narrowed command unions (module lifecycle and hygiene dispositions); an
// unbounded command or dynamic option name fails closed and needs an explicit
// scanner implementation. User positionals/option values are not CLI features.
function inventory() {
  const paths = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: resolve(root, "packages/ui-server/src") }))
    .map(path => resolve(root, "packages/ui-server/src", path));
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(paths, parsed.options);
  const checker = program.getTypeChecker();
  const found = new Map<string, Set<string>>();
  const sites = new Set<string>();
  let selections = 0;
  let probes = 0;
  function strings(node: ts.Expression): string[] {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue), ...strings(node.whenFalse)];
    const type = checker.getTypeAtLocation(node);
    const types = type.isUnion() ? type.types : [type];
    if (types.every(t => t.isStringLiteral())) return types.map(t => (t as ts.StringLiteralType).value);
    throw new Error(`Unbounded CLI command/flag: ${node.getText()}`);
  }
  function initializer(node: ts.Identifier): ts.Expression {
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer)
      throw new Error(`Unresolved argv: ${node.getText()}`);
    return declaration.initializer;
  }
  function arrays(node: ts.Expression): ts.ArrayLiteralExpression[] {
    if (ts.isIdentifier(node)) return arrays(initializer(node));
    if (ts.isConditionalExpression(node)) return [...arrays(node.whenTrue), ...arrays(node.whenFalse)];
    if (ts.isArrayLiteralExpression(node)) return [node];
    throw new Error(`Unsupported argv construction: ${node.getText()}`);
  }
  function inspect(arg: ts.Expression, prefix = "") {
    for (const array of arrays(arg)) {
      const elements = array.elements;
      const first = elements[0];
      if (!first || !ts.isExpression(first)) throw new Error("Missing CLI command");
      const commands = strings(first).flatMap(command => {
        if (["module", "skills", "scratch", "storage"].includes(command)) {
          const sub = elements[1];
          if (!sub || !ts.isExpression(sub)) throw new Error(`Missing ${command} subcommand`);
          return strings(sub).map(value => `${command} ${value}`);
        }
        return [prefix + command];
      });
      const flags = new Set<string>();
      walk(array, node => {
        if (!ts.isExpression(node)) return;
        const type = checker.getTypeAtLocation(node);
        for (const value of type.isUnion() ? type.types : [type]) {
          if (value.isStringLiteral() && value.value.startsWith("--")) flags.add(value.value);
        }
      });
      // Local args.push calls add options after the initializer.
      if (ts.isIdentifier(arg)) walk(scope(arg), node => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "push" || node.expression.expression.getText() !== arg.text) return;
        const flag = node.arguments[0];
        if (!flag) throw new Error("Empty argv push");
        for (const value of strings(flag)) {
          if (!value.startsWith("--")) throw new Error(`Unsupported argv push: ${value}`);
          flags.add(value);
        }
      });
      for (const command of commands) {
        const options = found.get(command) ?? new Set<string>();
        for (const flag of flags) options.add(flag);
        found.set(command, options);
      }
    }
  }
  for (const path of paths) {
    const file = program.getSourceFile(path)!;
    walk(file, node => {
      if (!ts.isCallExpression(node)) return;
      const call = node.expression.getText();
      if (node.arguments[0] && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "spawn") {
        walk(node.arguments[0]!, value => {
          if (ts.isArrayLiteralExpression(value) && ts.isStringLiteralLike(value.elements[0]!) && value.elements[0].text === "brain") {
            inspect(ts.factory.updateArrayLiteralExpression(value, value.elements.slice(1)));
          }
        });
      }
      if (call === "execBrain" || call === "cli") {
        sites.add(path.slice(root.length + 1));
        const arg = node.arguments[0];
        if (!arg) throw new Error("Missing CLI argv");
        if (call === "execBrain" && ts.isArrayLiteralExpression(arg) && arg.elements.some(ts.isSpreadElement)) {
          // This one forwarding entry point is checked separately below.
          expect(arg.getText()).toBe('["hygiene", "--json", ...args]');
          return;
        }
        if (call === "execBrain" && arg.getText() === '["storage", "pack", "--json"]') {
          const options = node.arguments[4];
          if (!options || !ts.isObjectLiteralExpression(options)) throw Error("Storage packing needs its explicit capability floor");
          const floor = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText() === "minimumVersion");
          expect(floor && ts.isPropertyAssignment(floor) && floor.initializer.getText()).toBe("STORAGE_PACK_CLI_VERSION");
        }
        inspect(arg, call === "cli" ? "hygiene " : "");
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "hygiene") {
        // All dynamic hygiene argv must pass through the scanned cli wrapper.
        expect(path).toBe(resolve(root, "packages/ui-server/src/inbox/hygiene-review.ts"));
        expect(scope(node).getText()).toContain("async function cli(args: string[])");
        expect(node.arguments[0]?.getText()).toBe("args");
      }
      if (call === "probeVersionCommand") {
        const arg = node.arguments[0];
        if (!arg || !ts.isArrayLiteralExpression(arg)) throw new Error("Unsupported CLI probe argv");
        expect(arg.elements[0]?.getText()).toBe("...command");
        inspect(ts.factory.updateArrayLiteralExpression(arg, arg.elements.slice(1)));
        probes++;
      }
      if (call === "brainCliCommand" || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "cliCommand")) {
        selections++;
        expect(["brain/client.ts", "routes/brain.ts"].some(suffix => path.endsWith(suffix))).toBe(true);
      }
    });
  }
  // The independent streaming spawn and version probe are also argv producers.
  const route = program.getSourceFile(resolve(root, "packages/ui-server/src/routes/brain.ts"))!;
  let streams = 0;
  walk(route, node => {
    if (ts.isArrayLiteralExpression(node) && node.elements.some(e => ts.isSpreadElement(e) && e.expression.getText() === "cliArgs")) {
      const offset = node.elements.findIndex(e => ts.isSpreadElement(e) && e.expression.getText() === "cliArgs") + 1;
      inspect(ts.factory.updateArrayLiteralExpression(node, node.elements.slice(offset)));
      streams++;
    }
  });
  expect(streams).toBe(1);
  expect(selections).toBe(4);
  expect(probes).toBe(1);
  expect([...sites].sort()).toEqual(["packages/ui-server/src/brain/client.ts", "packages/ui-server/src/inbox/hygiene-review.ts"]);
  // hygiene's forwarding wrapper adds --json to every subcommand.
  for (const [command, flags] of found) if (command.startsWith("hygiene ")) flags.add("--json");
  return found;
}

test("every server CLI command and flag is available at its enforced baseline or feature floor", () => {
  const found = inventory();
  expect([...found.keys()].filter(command => command !== "--version").sort()).toEqual(Object.keys(available).sort());
  const tooNew: string[] = [];
  for (const [command, flags] of found) {
    const floor = command === "storage pack" ? STORAGE_PACK_CLI_VERSION : MIN_BRAIN_CLI_VERSION;
    const commandVersion = command === "--version" ? globalFlags[command]! : available[command];
    expect(commandVersion, `Record release evidence for brain ${command}`).toBeDefined();
    if (Bun.semver.order(commandVersion!, floor) > 0) tooNew.push(`${command} requires ${commandVersion}`);
    for (const flag of flags) {
      const version = globalFlags[flag] ?? commandFlags[command.split(" ")[0]!]?.[flag];
      expect(version, `Record release evidence for brain ${command} ${flag}`).toBeDefined();
      if (Bun.semver.order(version!, floor) > 0) tooNew.push(`${command} ${flag} requires ${version}`);
    }
  }
  expect(tooNew, `MIN_BRAIN_CLI_VERSION ${MIN_BRAIN_CLI_VERSION} is below invoked capabilities`).toEqual([]);
}, 30_000);
