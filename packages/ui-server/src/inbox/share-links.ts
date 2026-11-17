/**
 * Markdown link targets a filed document resolves, as brain-root paths.
 *
 * Share completion asks whether the filed note links a retained binary. A
 * working link from `travel/ithaca/note.md` is document-relative
 * (`../../assets/x.pdf`) or brain-root-absolute (`/assets/x.pdf`), so a
 * literal substring match on the target path refuses every link that renders.
 * Wiki-links are not counted: the brain resolves them to Markdown documents
 * only (`createWikiLinkResolver`, `packages/core/src/lib/indexer/links.ts:46-103`).
 */

/** Remove fenced blocks and inline code spans; a path quoted as code is not a link. */
function withoutCode(content: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.slice(marker[0].length).trim() === "") fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue; }
    kept.push(line);
  }
  return kept.join("\n").replace(/(`+)[\s\S]*?(?<!`)\1(?!`)/g, "");
}

/** Normalise `target` against the linking document's folder; `null` when it leaves the brain or names another scheme. */
export function resolveLinkTarget(documentPath: string, target: string): string | null {
  let destination = target.trim();
  if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
  destination = destination.replace(/[?#].*$/, "");
  if (!destination || destination.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(destination)) return null;
  try { destination = decodeURIComponent(destination); } catch { return null; }
  if (destination.includes("\\")) return null;
  const rooted = destination.startsWith("/");
  const parts = rooted ? [] : documentPath.split("/").slice(0, -1);
  for (const part of destination.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** Every inline or reference-definition link destination in `content`, resolved from `documentPath`. */
export function markdownLinkTargets(documentPath: string, content: string): Set<string> {
  const text = withoutCode(content), targets = new Set<string>();
  const destinations = [
    ...[...text.matchAll(/\]\(\s*(<[^>\n]*>|[^\s()]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g)].map(m => m[1]!),
    ...[...text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)].map(m => m[1]!),
  ];
  for (const destination of destinations) {
    const resolved = resolveLinkTarget(documentPath, destination);
    if (resolved) targets.add(resolved);
  }
  return targets;
}
