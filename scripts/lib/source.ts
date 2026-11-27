/**
 * The one TypeScript parse the lint gates make (#4673). A compiler API change
 * (#2311) is adapted here once instead of in every gate.
 */
import ts from "typescript";

/** The script kind a gate parses `file` with when it does not force one. */
export function scriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** A source file with parent pointers, its kind chosen by extension unless the caller passes one. */
export function parse(file: string, text: string, kind: ts.ScriptKind = scriptKind(file)): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, kind);
}
