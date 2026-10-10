import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../src");
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(join(dir, entry.name)) : /\.(?:tsx?|css)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
const files = sources(root);
// Empty by design: every ui-react viewport overlay belongs to the kit.
const exceptions: string[] = [];
function classStrings(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap(span => [span.literal.text, ...classStrings(span.expression)])];
  const found: string[] = [];
  ts.forEachChild(node, child => { found.push(...classStrings(child)); });
  return found;
}
/** Tailwind variants can contain colons inside arbitrary brackets. */
function utility(token: string): string {
  let depth = 0, start = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}
function viewport(tokens: string[]): boolean {
  return tokens.includes("inset-0")
    || ["inset-x-0", "inset-y-0"].every(token => tokens.includes(token))
    || ["top-0", "right-0", "bottom-0", "left-0"].every(token => tokens.includes(token));
}
function classes() {
  return files.filter(file => !file.endsWith(".css")).flatMap(file => {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found: { site: string; tokens: string[] }[] = [];
    function visit(node: ts.Node) {
      // Scan literals as well as whole className expressions, so a cn("fixed",
      // "inset-0") or template split cannot evade the viewport/layer rule.
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
        || (ts.isCallExpression(node) && node.expression.getText(ast) === "cn")
        || (ts.isJsxAttribute(node) && node.name.getText(ast) === "className")) {
        found.push({ site: `${relative(root, file)}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`,
          tokens: classStrings(node).join(" ").split(/\s+/).map(utility) });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return found;
  });
}

test("ui-react viewport overlays use Overlay, with no exceptions", () => {
  // Mutation: restore fixed inset-0 z-40 in GraphControls.
  expect(files.length, "the gate reads the whole source tree").toBeGreaterThan(100);
  expect(exceptions).toEqual([]);
  expect(classes().filter(({ tokens }) => tokens.includes("fixed") && viewport(tokens))
    .map(({ site }) => site), "no hand-rolled viewport overlays").toEqual([]);
});

test("fixed ui-react layers use only named layer tokens", () => {
  // Mutation: change the tab bar's z-nav to z-50.
  expect(classes().filter(({ tokens }) => tokens.includes("fixed") && tokens.some(token =>
    token.startsWith("z-") && !/^z-(raised|popover|nav|panel|banner|modal)$/.test(token)))
    .map(({ site }) => site), "no numeric or arbitrary fixed layers").toEqual([]);
});

test("inline fixed ui-react styles use named layers and cannot cover the viewport", () => {
  const found: string[] = [];
  for (const file of files.filter(file => !file.endsWith(".css"))) {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isJsxAttribute(node) && node.name.getText(ast) === "style") {
        function inspect(object: ts.Node) {
          if (ts.isObjectLiteralExpression(object)) {
            const properties = new Map(object.properties.filter(ts.isPropertyAssignment).map(p =>
              [p.name.getText(ast).replace(/["']/g, ""), p.initializer.getText(ast)]));
            if (/^["']fixed["']$/.test(properties.get("position") ?? "")) {
              const layer = properties.get("zIndex");
              const covers = properties.get("inset") === "0"
                || ["top", "right", "bottom", "left"].every(key => properties.get(key) === "0");
              if (covers || (layer && !/^z\.(raised|popover|nav|panel|banner|modal)$/.test(layer))) {
                found.push(`${relative(root, file)}:${ast.getLineAndCharacterOfPosition(object.getStart(ast)).line + 1}`);
              }
            }
          }
          ts.forEachChild(object, inspect);
        }
        inspect(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  expect(found, "no inline viewport overlays or unrecorded fixed layers").toEqual([]);
});

test("ui-react CSS fixed layers use named tokens and cannot cover the viewport", () => {
  const violations: string[] = [];
  const css = files.filter(file => file.endsWith(".css"));
  expect(css.length, "CSS is scanned").toBeGreaterThan(0);
  for (const file of css) {
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = new Map([...block[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map(m => [m[1]!, m[2]!.trim().replace(/\s*!important$/, "")]));
      if (declarations.get("position") !== "fixed") continue;
      const layer = declarations.get("z-index");
      const covers = declarations.get("inset") === "0"
        || ["top", "right", "bottom", "left"].every(key => declarations.get(key) === "0");
      if (covers || (layer && !/^var\(--bk-z-(raised|popover|nav|panel|banner|modal)\)$/.test(layer))) violations.push(`${relative(root, file)}: ${block[1]!.trim()}`);
    }
  }
  expect(violations, "no CSS viewport overlays or unrecorded fixed layers").toEqual([]);
});

// #1418 removes both temporary kit adapter exceptions. ui-react has none.
const kitRoot = resolve(import.meta.dir, "../../ui-kit/src");
const kitFixedOwners = ["chrome/ModelPicker.tsx", "chrome/Overlay.tsx", "internal/sheet-dialog.tsx"];
test("kit fixed positioning stays in Overlay and the two recorded sheet adapters", () => {
  // Mutation: add inline position: "fixed" to chrome/BottomSheet.tsx.
  const owners = sources(kitRoot).filter(file => !file.endsWith(".css")).filter(file => {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let fixed = false;
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(ast).replace(/["']/g, "") === "position"
        && ts.isStringLiteral(node.initializer) && node.initializer.text === "fixed") fixed = true;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return fixed;
  }).map(file => relative(kitRoot, file)).sort();
  // Overlay uses CSS for its fixed geometry; only the legacy inline owners remain.
  expect(owners.filter(file => !kitFixedOwners.includes(file)), "no unrecorded kit fixed positioning").toEqual([]);
  expect(owners.filter(file => file !== "chrome/Overlay.tsx"), "both temporary owners are still scanned").toEqual(["chrome/ModelPicker.tsx", "internal/sheet-dialog.tsx"]);
});
