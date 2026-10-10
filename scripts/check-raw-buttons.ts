// Native buttons in ui-react need a kit control or an intentional-raw reason
// (D55, #1379). Use the AST so documentation and strings are not JSX sites.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const SOURCES = "packages/ui-react/src/**/*.tsx";
const CODES = ["row", "select", "surface", "canvas", "kit", "api", "dev"];
const VALID_MARKER = /^raw-button:\s*(row|select|surface|canvas|kit|api|dev)\s*[—-]\s*\S.{11,}/;
const MISSING = "raw <button> — use Button, IconButton or TextButton from " +
  "@schlessera/brain-ui-kit, or mark it: // raw-button: <code> — <why>";

export interface Finding {
  file: string;
  line: number;
  column: number;
  kind: "missing-marker" | "unknown-code" | "orphan-marker";
  message: string;
}

export function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const buttons: { start: number; end: number; position: number }[] = [];
  const comments = new Map<number, ts.CommentRange>();
  const literals: ts.TextRange[] = [];
  const findings: Finding[] = [];
  const record = (position: number, kind: Finding["kind"], message: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(position);
    findings.push({ file, line: line + 1, column: character + 1, kind, message });
  };
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) && node.tagName.text === "button") {
      buttons.push({ start: node.tagName.end, end: node.end, position: node.getStart(source) });
    }
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      literals.push({ pos: node.getStart(source), end: node.end });
    }
    // Token boundaries expose all trivia, including comments between JSX
    // attributes and in empty JSX expressions. A plain scanner cannot tell
    // JSX text, regex literals and template text from JavaScript comments.
    const children = node.getChildren(source);
    if (children.length === 0) {
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
      ]) comments.set(range.pos, range);
    } else {
      for (const child of children) visit(child);
    }
  };
  visit(source);

  const markers: { position: number; end: number; text: string }[] = [];
  for (const comment of comments.values()) {
    if (literals.some(literal => comment.pos >= literal.pos && comment.pos < literal.end)) continue;
    // Neither the closing */ nor an attribute after it counts towards the
    // reason's twelve characters.
    const body = text.slice(comment.pos + 2,
      comment.kind === ts.SyntaxKind.MultiLineCommentTrivia ? comment.end - 2 : comment.end);
    const matches = [...body.matchAll(/raw-button:/g)];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i]!.index;
      markers.push({ position: comment.pos + 2 + start, end: comment.end,
        text: body.slice(start, matches[i + 1]?.index).trim() });
    }
  }
  for (const button of buttons) {
    const owned = markers.filter(marker => marker.position >= button.start && marker.end <= button.end);
    let unknown = false;
    for (const marker of owned) {
      const code = /^raw-button:\s*([^\s—-]+)/.exec(marker.text)?.[1];
      if (code && !CODES.includes(code)) {
        record(marker.position, "unknown-code", `unknown raw-button code '${code}' — valid codes: ${CODES.join(", ")}`);
        unknown = true;
      }
    }
    if (!unknown && (owned.length !== 1 || !VALID_MARKER.test(owned[0]!.text))) {
      record(button.position, "missing-marker", MISSING);
    }
  }
  for (const marker of markers) {
    if (!buttons.some(button => marker.position >= button.start && marker.end <= button.end)) {
      record(marker.position, "orphan-marker", "orphan raw-button marker — put the comment inside a <button> opening tag");
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function scanRoot(root: string): Finding[] {
  const files = [...new Bun.Glob(SOURCES).scanSync({ cwd: root })].sort();
  if (files.length === 0) throw new Error(`raw-buttons: no files match ${SOURCES}; the gate checked nothing`);
  return files.flatMap(file => scanSource(file, readFileSync(resolve(root, file), "utf8")));
}

if (import.meta.main) {
  try {
    const findings = scanRoot(resolve(process.argv[2] ?? process.cwd()));
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.message}`);
    }
    if (findings.length) process.exit(1);
    console.log("raw-buttons: every native button in ui-react has an intentional-raw marker (D55).");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
