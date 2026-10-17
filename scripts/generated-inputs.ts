/** Audited ephemeral producers. A producer receipt alone never resolves a consumer root. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
export interface GeneratedProducer {
  owner: string; root: string; expression: string;
}
export interface ProducerReceipt {
  owner: string; root: string; relativePath: string; contentDigest: string;
  producerDigest: string; consumerBound: false;
}
/** Only fixed literal bytes in a newly owned temp root; external/parameter roots do not qualify. */
export function inspectGeneratedProducer(root: string, binding: GeneratedProducer): ProducerReceipt {
  if (binding.owner.includes("..") || binding.owner.startsWith("/") || !/^[A-Za-z_$][\w$]*$/.test(binding.root)) throw Error("Invalid generated producer identity");
  const path = resolve(root, binding.owner);
  if (!/\.[cm]?[jt]sx?$/.test(binding.owner) || realpathSync(path) !== path) throw Error("Unsupported generated producer source");
  const source = readFileSync(path, "utf8"), ast = ts.createSourceFile(binding.owner, source, ts.ScriptTarget.Latest, true);
  if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw Error("Invalid generated producer source");
  const imports = new Map<string, string>(), declarations: ts.VariableDeclaration[] = [], calls: ts.CallExpression[] = [];
  for (const statement of ast.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const module = statement.moduleSpecifier.text.replace(/^node:/, ""), names = statement.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const element of names.elements) imports.set(element.name.text, `${module}:${element.propertyName?.text ?? element.name.text}`);
  }
  const walk = (node: ts.Node) => { if (ts.isVariableDeclaration(node)) declarations.push(node); if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, walk); };
  walk(ast);
  const named = (node: ts.Node | undefined, name: string) => Boolean(node && ts.isIdentifier(node) && node.text === name);
  const imported = (node: ts.Node | undefined, identity: string) => Boolean(node && ts.isIdentifier(node) && imports.get(node.text) === identity);
  const rootDeclarations = declarations.filter(node => named(node.name, binding.root));
  const rootDeclaration = rootDeclarations[0], initializer = rootDeclaration?.initializer;
  if (rootDeclarations.length !== 1 || !initializer || !ts.isCallExpression(initializer) || !imported(initializer.expression, "fs:mkdtempSync") || initializer.arguments.length !== 1) throw Error("Generated producer requires one owned mkdtemp root");
  if (!(rootDeclaration.parent.flags & ts.NodeFlags.Const)) throw Error("Generated root must be immutable");
  const temp = initializer.arguments[0];
  if (!temp || !ts.isCallExpression(temp) || !imported(temp.expression, "path:join") || temp.arguments.length !== 2 || !ts.isCallExpression(temp.arguments[0]!) || !imported(temp.arguments[0]!.expression, "os:tmpdir") || !ts.isStringLiteral(temp.arguments[1]!) || !/^[A-Za-z0-9-]+$/.test(temp.arguments[1]!.text)) throw Error("Generated root is not a bounded fresh temporary directory");
  const matching = calls.filter(node => node.getText(ast) === binding.expression);
  if (matching.length !== 1) throw Error("Missing or ambiguous generated producer call");
  const call = matching[0]!;
  const functionOwner = (node: ts.Node) => { for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) return parent; };
  if (functionOwner(call) !== functionOwner(rootDeclaration)) throw Error("Generated producer call has another root scope");
  if (!ts.isIdentifier(call.expression) || call.arguments.length !== 2 || !ts.isStringLiteral(call.arguments[0]!) || !ts.isStringLiteral(call.arguments[1]!)) throw Error("Generated producer must write literal path and bytes");
  const relativePath = call.arguments[0]!.text, content = call.arguments[1]!.text;
  if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some(part => !part || part === "." || part === "..") || /[\\\r\n\0]/.test(relativePath)) throw Error("Generated path escapes its owned root");
  const writers = declarations.filter(node => named(node.name, call.expression.getText(ast)));
  const writer = writers[0]?.initializer;
  if (writers.length !== 1 || !writer || !ts.isArrowFunction(writer) || writer.parameters.length !== 2 || !ts.isIdentifier(writer.parameters[0]!.name) || !ts.isIdentifier(writer.parameters[1]!.name)) throw Error("Unsupported generated writer binding");
  if (writers[0]!.parent.parent.parent !== rootDeclaration.parent.parent.parent || !(writers[0]!.parent.flags & ts.NodeFlags.Const)) throw Error("Generated writer and root have different lexical owners");
  if (writer.parameters.some(parameter => named(parameter.name, binding.root))) throw Error("Generated writer shadows its owned root");
  const writes: ts.CallExpression[] = [];
  const collect = (node: ts.Node) => { if (ts.isCallExpression(node) && imported(node.expression, "fs:writeFileSync")) writes.push(node); ts.forEachChild(node, collect); };
  collect(writer.body);
  const write = writes[0], target = write?.arguments[0];
  if (writes.length !== 1 || !write || write.arguments.length !== 2 || !named(write.arguments[1], writer.parameters[1]!.name.text) || !target || !ts.isCallExpression(target) || !imported(target.expression, "path:join") || target.arguments.length !== 2 || !named(target.arguments[0], binding.root) || !named(target.arguments[1], writer.parameters[0]!.name.text)) throw Error("Generated writer does not preserve its root/path/bytes binding");
  return { owner: binding.owner, root: binding.root, relativePath,
    contentDigest: createHash("sha256").update(content).digest("hex"),
    producerDigest: createHash("sha256").update(source).digest("hex"), consumerBound: false };
}
