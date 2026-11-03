/**
 * The `media` lists of `brain.config`, read and edited as syntax only (#2781,
 * epic #1777, design rev 4 §7). The config is parsed with the TypeScript
 * parser and never evaluated: only string literals in literal arrays of a
 * literal `media` object, in a directly exported object literal, are read or
 * changed. Anything else refuses with `config-not-literal`, so the owner
 * edits it by hand. An edit is a minimal splice; every other byte is kept.
 */
import ts from "typescript";

/** Why the config's `media` lists cannot be read or edited as literals. */
export class MediaConfigNotLiteral extends Error {
  readonly code = "config-not-literal";
}

export interface MediaPolicyLists {
  track: string[];
  ignore: string[];
}

/** One approved change: add an exact `media.track` entry, and remove an exact `media.ignore` entry with it. */
export interface MediaPolicyEdit {
  addTrack?: string;
  removeIgnore?: string;
}

function refuse(reason: string): never {
  throw new MediaConfigNotLiteral(reason);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  return node;
}

function literalObject(node: ts.Expression, what: string): ts.ObjectLiteralExpression {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) refuse(`${what} is not an object literal`);
  return value;
}

function properties(node: ts.ObjectLiteralExpression, what: string): Map<string, ts.PropertyAssignment> {
  const found = new Map<string, ts.PropertyAssignment>();
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) {
      refuse(`${what} uses a spread, computed key, method or shorthand`);
    }
    if (found.has(p.name.text)) refuse(`${what} has a duplicate ${JSON.stringify(p.name.text)}`);
    found.set(p.name.text, p);
  }
  return found;
}

function stringArray(node: ts.Expression, what: string): ts.ArrayLiteralExpression {
  const value = unwrap(node);
  if (!ts.isArrayLiteralExpression(value) || value.elements.some((e) => !ts.isStringLiteralLike(e))) {
    refuse(`${what} is not an array of string literals`);
  }
  return value;
}

interface Parsed {
  file: ts.SourceFile;
  prefix: string;
  input: string;
  root: ts.ObjectLiteralExpression;
  media: ts.ObjectLiteralExpression | null;
  track: ts.ArrayLiteralExpression | null;
  ignore: ts.ArrayLiteralExpression | null;
}

function parse(source: string, format: "ts" | "json"): Parsed {
  if (format === "json") {
    try {
      JSON.parse(source);
    } catch {
      refuse("brain.config.json is not valid JSON");
    }
  }
  const prefix = format === "json" ? "export default " : "";
  const input = prefix + source;
  const file = ts.createSourceFile("brain.config.ts", input, ts.ScriptTarget.Latest, true);
  const diagnostics = ts.transpileModule(input, { reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) refuse("the config has a syntax error");
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) refuse("the config has no direct default-exported literal");
  let expression = unwrap(exports[0]!.expression);
  if (ts.isCallExpression(expression)) {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "defineConfig" || expression.arguments.length !== 1) {
      refuse("the default export is not a direct defineConfig literal");
    }
    expression = expression.arguments[0]!;
  }
  const root = literalObject(expression, "the config");
  const mediaProp = properties(root, "the config").get("media");
  if (!mediaProp) return { file, prefix, input, root, media: null, track: null, ignore: null };
  const media = literalObject(mediaProp.initializer, "media");
  const lists = properties(media, "media");
  const track = lists.get("track");
  const ignore = lists.get("ignore");
  return {
    file, prefix, input, root, media,
    track: track ? stringArray(track.initializer, "media.track") : null,
    ignore: ignore ? stringArray(ignore.initializer, "media.ignore") : null,
  };
}

const values = (array: ts.ArrayLiteralExpression | null) => (array ? array.elements.map((e) => (e as ts.StringLiteralLike).text) : []);

/** The literal `media.track` and `media.ignore` lists; absent lists are empty. */
export function readMediaPolicyLists(source: string, format: "ts" | "json"): MediaPolicyLists {
  const parsed = parse(source, format);
  return { track: values(parsed.track), ignore: values(parsed.ignore) };
}

/** Insert `text` as a new last property of `node`. */
function appendProperty(input: string, node: ts.ObjectLiteralExpression, file: ts.SourceFile, text: string): { at: number; insert: string } {
  const last = node.properties.at(-1);
  if (!last) {
    const open = node.getStart(file) + 1;
    return { at: open, insert: ` ${text} ` };
  }
  // A trailing comma stays where it is: the new property follows it.
  const comma = input.slice(last.end).match(/^\s*,/);
  return comma ? { at: last.end + comma[0].length, insert: ` ${text},` } : { at: last.end, insert: `, ${text}` };
}

/**
 * The config text with `edit` applied, and the lists it leaves. Adding a
 * pattern already listed changes nothing; removing one not listed refuses.
 * Both edits are planned against the original text and spliced from the end,
 * so neither moves the other.
 */
export function planMediaPolicyEdit(source: string, format: "ts" | "json", edit: MediaPolicyEdit): { text: string; lists: MediaPolicyLists } {
  const parsed = parse(source, format);
  const { file, input } = parsed;
  const splices: Array<{ start: number; end: number; text: string }> = [];
  const track = values(parsed.track), ignore = values(parsed.ignore);
  if (edit.addTrack !== undefined && !track.includes(edit.addTrack)) {
    const literal = JSON.stringify(edit.addTrack);
    if (parsed.track) {
      const last = parsed.track.elements.at(-1);
      if (last) splices.push({ start: last.end, end: last.end, text: `, ${literal}` });
      else splices.push({ start: parsed.track.getStart(file), end: parsed.track.end, text: `[${literal}]` });
    } else if (parsed.media) {
      const { at, insert } = appendProperty(input, parsed.media, file, `"track": [${literal}]`);
      splices.push({ start: at, end: at, text: insert });
    } else {
      const { at, insert } = appendProperty(input, parsed.root, file, `"media": { "track": [${literal}] }`);
      splices.push({ start: at, end: at, text: insert });
    }
    track.push(edit.addTrack);
  }
  if (edit.removeIgnore !== undefined) {
    const elements = parsed.ignore?.elements ?? ([] as unknown as ts.NodeArray<ts.Expression>);
    const i = elements.findIndex((e) => (e as ts.StringLiteralLike).text === edit.removeIgnore);
    if (i < 0) refuse(`media.ignore does not list ${JSON.stringify(edit.removeIgnore)}`);
    const el = elements[i]!;
    if (elements.length === 1) splices.push({ start: parsed.ignore!.getStart(file), end: parsed.ignore!.end, text: "[]" });
    else if (i < elements.length - 1) splices.push({ start: el.getStart(file), end: elements[i + 1]!.getStart(file), text: "" });
    else splices.push({ start: elements[i - 1]!.end, end: el.end, text: "" });
    ignore.splice(ignore.indexOf(edit.removeIgnore), 1);
  }
  let text = input;
  for (const s of splices.sort((a, b) => b.start - a.start)) text = text.slice(0, s.start) + s.text + text.slice(s.end);
  text = text.slice(parsed.prefix.length);
  // The result must read back as exactly the intended lists.
  const after = readMediaPolicyLists(text, format);
  if (JSON.stringify(after) !== JSON.stringify({ track, ignore })) refuse("the edited config does not read back as the intended lists");
  return { text, lists: after };
}
