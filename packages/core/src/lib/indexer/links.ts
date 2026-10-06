/**
 * Wiki-link resolution: `[[target]]` → a repo-relative markdown path.
 *
 * Pure functions over the corpus maps the parse phase builds, with no database
 * and no filesystem. That is what lets `validate` and the OKF exporter reuse
 * them to resolve links without running an index.
 */
import { DEFAULT_DIR_ANCHORS } from "../config.js";

/**
 * Extract [[wiki-link]] targets from markdown content.
 */
export function extractWikiLinks(content: string): string[] {
  return [...new Set(wikiLinkMatches(content).map((m) => m.target))];
}

/**
 * Every `[[…]]` token in `content` whose target is `target`, as written,
 * deduplicated and sorted: the same links `extractWikiLinks` reads.
 */
export function wikiLinkTokens(content: string, target: string): string[] {
  return [...new Set(wikiLinkMatches(content).filter((m) => m.target === target).map((m) => m.token))].sort();
}

function wikiLinkMatches(content: string): Array<{ token: string; target: string }> {
  // Strip fenced and inline code first — `[['a',1]]` in a code sample is not a link
  const stripped = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

  const regex = /\[\[([^\]]+)\]\]/g;
  const links: Array<{ token: string; target: string }> = [];
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    // Support [[target|display text]] — the target is before the pipe
    const target = match[1].split("|")[0].trim();
    if (target) links.push({ token: match[0], target });
  }
  return links;
}

/**
 * Build lookup tables once for a corpus snapshot. No global cache: callers may
 * mutate a file map between runs, and resolution must see that new snapshot.
 */
export function createWikiLinkResolver(
  fileMap: Map<string, string>,
  dirAnchors: string[] = DEFAULT_DIR_ANCHORS
): (target: string, sourcePath?: string) => string | null {
  const paths = new Set(fileMap.keys());
  const basenames = new Map<string, string[]>();
  const suffixes = new Map<string, string[]>();
  const directories = new Map<string, Set<string>>();
  const add = (map: Map<string, string[]>, key: string, path: string) => {
    const entries = map.get(key) ?? [];
    entries.push(path);
    map.set(key, entries);
  };
  for (const path of paths) {
    const parts = path.split("/");
    add(basenames, parts.at(-1)!.replace(/\.md$/, ""), path);
    for (let i = 0; i < parts.length - 1; i++) {
      add(suffixes, parts.slice(i).join("/"), path);
      const directory = parts.slice(0, i + 1).join("/");
      for (let j = 0; j <= i; j++) {
        const key = parts.slice(j, i + 1).join("/");
        const entries = directories.get(key) ?? new Set<string>();
        entries.add(directory);
        directories.set(key, entries);
      }
    }
  }
  const anchors = new Map<string, string[]>();
  for (const [key, dirs] of directories) {
    const candidates: string[] = [];
    for (const dir of dirs) {
      const anchor = dirAnchors.find((name) => paths.has(`${dir}/${name}`));
      if (anchor) candidates.push(`${dir}/${anchor}`);
    }
    anchors.set(key, candidates);
  }

  return (rawTarget, sourcePath) => {
    const [documentTarget, heading] = rawTarget.split("#");
    const target = documentTarget.trim();
    if (!target) {
      // A heading without a document target refers to the linking document.
      // As with [[file#heading]], resolution does not check heading existence.
      return heading?.trim() && sourcePath && paths.has(sourcePath) ? sourcePath : null;
    }
    if (target.endsWith("/")) {
      return disambiguateCandidates(anchors.get(target.replace(/\/+$/, "")) ?? [], sourcePath);
    }
    if (target.includes("/")) {
      const suffix = target.endsWith(".md") ? target : `${target}.md`;
      // An exact repo-relative path always wins over a shorter suffix match.
      if (paths.has(suffix)) return suffix;
      return disambiguateCandidates(suffixes.get(suffix) ?? [], sourcePath);
    }
    const candidates = basenames.get(target) ?? basenames.get(`_${target}`) ?? anchors.get(target) ?? [];
    return disambiguateCandidates(candidates, sourcePath);
  };
}

/**
 * Why a wiki-link that resolved to nothing did not resolve, as `brain
 * validate` and `brain audit` both word it: ambiguous when its last segment
 * names more than one of `paths` and none is a same-directory sibling,
 * otherwise unresolved. Built once per corpus snapshot, like the resolver.
 */
export function createUnresolvedLinkDescriber(paths: Iterable<string>): (link: string) => string {
  const basenameCounts = new Map<string, number>();
  for (const path of paths) {
    const basename = path.replace(/\.md$/, "").split("/").pop()!;
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return (link) => {
    const candidates = basenameCounts.get(link.split("/").pop()!) ?? 0;
    return candidates > 1
      ? `Ambiguous wiki-link: [[${link}]] matches ${candidates} files and none is a same-directory sibling — qualify it (e.g. [[dir/${link}]])`
      : `Unresolved wiki-link: [[${link}]]`;
  };
}

/** Resolve one link; batch callers should build a resolver once per corpus. */
export function resolveWikiLink(
  target: string,
  fileMap: Map<string, string>,
  sourcePath?: string,
  dirAnchors: string[] = DEFAULT_DIR_ANCHORS
): string | null {
  return createWikiLinkResolver(fileMap, dirAnchors)(target, sourcePath);
}

/**
 * Pick one path among ambiguous candidates from the source's position:
 * 1. The source's namesake subdirectory (studies/{slug}.md registry files link
 *    into studies/{slug}/)
 * 2. Walk up the source's ancestor directories (closest first); the first
 *    scope containing exactly one candidate wins. Covers same-directory
 *    siblings and "nearest _index" references; multiple candidates inside
 *    the nearest scope stay ambiguous (null).
 */
function disambiguateCandidates(
  candidates: string[],
  sourcePath?: string
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (sourcePath) {
    const srcBase = sourcePath.replace(/\.md$/, "");
    const namesakeSub = candidates.filter((p) => p.startsWith(srcBase + "/"));
    if (namesakeSub.length === 1) return namesakeSub[0];
    if (namesakeSub.length > 1) return null;

    const parts = sourcePath.split("/").slice(0, -1);
    for (let depth = parts.length; depth >= 0; depth--) {
      const prefix = depth > 0 ? parts.slice(0, depth).join("/") + "/" : "";
      const within = candidates.filter((c) => c.startsWith(prefix));
      if (within.length === 1) return within[0];
      if (within.length > 1) return null;
    }
  }

  return null;
}

/**
 * Resolve a wiki-link via frontmatter aliases (alias -> paths), with the
 * same disambiguation rules as basename resolution.
 */
export function resolveAlias(
  target: string,
  aliasMap: Map<string, string[]>,
  sourcePath?: string
): string | null {
  const candidates = aliasMap.get(target.toLowerCase());
  if (!candidates || candidates.length === 0) return null;
  return disambiguateCandidates(candidates, sourcePath);
}
