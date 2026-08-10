import matter from "gray-matter";

/**
 * gray-matter parses unquoted YAML dates (`created: 2026-03-06`) into JS Date
 * objects, and a naive `matter.stringify` re-emits them as full ISO timestamps
 * (`2026-03-06T00:00:00.000Z`), violating the frontmatter schema. Normalize
 * Date values (top-level and inside arrays) back to YYYY-MM-DD strings.
 */
export function normalizeFrontmatterDates(
  data: Record<string, any>
): Record<string, any> {
  const toDateString = (v: any) =>
    v instanceof Date ? v.toISOString().split("T")[0] : v;

  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    normalized[key] = Array.isArray(value)
      ? value.map(toDateString)
      : toDateString(value);
  }
  return normalized;
}

/**
 * Serialize a brain document, preserving schema conventions that a plain
 * `matter.stringify` round-trip would mangle:
 * - date fields stay bare `YYYY-MM-DD` scalars
 * - arrays (tags, aliases) stay inline flow style (`[a, b]`)
 *
 * `flowLevel` passes through gray-matter to js-yaml's dump(). js-yaml quotes
 * date-like strings (they'd otherwise resolve as YAML timestamps), so bare
 * dates are restored inside the frontmatter block afterwards.
 */
export function stringifyDocument(
  content: string,
  data: Record<string, any>
): string {
  const out = matter.stringify(content, normalizeFrontmatterDates(data), {
    flowLevel: 1,
  } as any);
  return out.replace(/^---\n[\s\S]*?\n---/, (block) =>
    block.replace(/^(\w[\w-]*): '(\d{4}-\d{2}-\d{2})'$/gm, "$1: $2")
  );
}
