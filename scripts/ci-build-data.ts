/** Finite source-data reference policy for the reviewed TypeScript producer. */
import ts from "typescript";
import { posix, join } from "node:path";
import { buildRead } from "./ci-build-files";
import { type BuildFile } from "./ci-build-boundary";
export function buildDataRefusals(input: string, records: readonly BuildFile[]): string[] {
  const refused: string[] = [];
  for (const entry of records) {
    if (entry.kind !== "file" || !/^packages\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/.test(entry.path)) continue;
    const text = buildRead(join(input, entry.path)).bytes.toString("utf8");
    const parsed = ts.preProcessFile(text, true, true);
    for (const ref of [...parsed.importedFiles, ...parsed.referencedFiles, ...parsed.typeReferenceDirectives]) {
      const name = ref.fileName;
      if (name.startsWith("node:") || name.startsWith("bun:")) continue;
      if (name.includes("\\") || posix.isAbsolute(name) || /^[a-z][a-z0-9+.-]*:/i.test(name)) { refused.push(`${entry.path}:external-reference`); continue; }
      if (name.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(entry.path), name));
        if (target === ".." || target.startsWith("../")) refused.push(`${entry.path}:external-reference`);
      }
    }
  }
  return [...new Set(refused)].sort();
}
