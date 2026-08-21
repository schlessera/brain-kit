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
  // Strip fenced and inline code first — `[['a',1]]` in a code sample is not a link
  const stripped = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

  const regex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    // Support [[target|display text]] — the target is before the pipe
    const target = match[1].split("|")[0].trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

/**
 * Resolve a wiki-link target to a file path using a filename map.
 *
 * Resolution order:
 * 1. Qualified targets containing "/" match by path suffix ([[bookshelf/research]])
 * 2. Unique basename match anywhere in the corpus
 * 3. Ambiguous basenames resolve to a same-directory sibling of sourcePath
 * 4. Otherwise unresolved (null) — never guess among multiple candidates;
 *    the old first-match behavior silently wired 52 [[research]] links to
 *    the alphabetically first research.md in the repo.
 *
 * The directory-anchor list (which file a `[[dir]]` link resolves to) comes
 * from the taxonomy resolver — `taxonomy.dirAnchors` — rather than a hardcoded
 * constant. Defaults to the core anchor set for standalone callers/tests.
 */
export function resolveWikiLink(
  target: string,
  fileMap: Map<string, string>,
  sourcePath?: string,
  dirAnchors: string[] = DEFAULT_DIR_ANCHORS
): string | null {
  // Drop heading fragments: [[file#section]] links to the file
  target = target.split("#")[0].trim();
  if (!target) return null;

  // A trailing slash is an explicit directory link: it resolves to the
  // directory's anchor file (dirAnchors order), never to a same-named .md file.
  // Handles both a qualified dir path ([[projects/active/bookshelf/]]) and a
  // bare dir name ([[bookshelf/]]).
  if (target.endsWith("/")) {
    const dir = target.replace(/\/+$/, "");
    if (!dir) return null;
    return resolveDirAnchor(dir, fileMap, dirAnchors, sourcePath);
  }

  // Qualified link: path suffix match
  if (target.includes("/")) {
    const suffix = target.endsWith(".md") ? target : `${target}.md`;
    for (const [path] of fileMap) {
      if (path === suffix || path.endsWith("/" + suffix)) return path;
    }
    return null;
  }

  const candidates: string[] = [];
  for (const [path] of fileMap) {
    const basename = path.replace(/\.md$/, "").split("/").pop();
    if (basename === target) candidates.push(path);
  }
  // Fall back to _index resolution ([[index]] -> studies/_index.md)
  if (candidates.length === 0) {
    for (const [path] of fileMap) {
      const basename = path.replace(/\.md$/, "").split("/").pop();
      if (basename === `_${target}`) candidates.push(path);
    }
  }
  // Directory link: [[bookshelf]] -> projects/active/bookshelf/<anchor>.
  // One anchor per matching directory, by dirAnchors preference.
  if (candidates.length === 0) {
    const dirs = new Set<string>();
    for (const [path] of fileMap) {
      const segs = path.split("/");
      for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i] === target) {
          dirs.add(segs.slice(0, i + 1).join("/"));
          break;
        }
      }
    }
    for (const dir of dirs) {
      for (const anchor of dirAnchors) {
        if (fileMap.has(`${dir}/${anchor}`)) {
          candidates.push(`${dir}/${anchor}`);
          break;
        }
      }
    }
  }

  return disambiguateCandidates(candidates, sourcePath);
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
    const namesakeSub = candidates.find((p) => p.startsWith(srcBase + "/"));
    if (namesakeSub) return namesakeSub;

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
 * Resolve an explicit directory reference to its anchor file. `dir` may be a
 * qualified path (projects/active/bookshelf) matched by full/suffix path, or a
 * bare directory name (bookshelf) matched on any single path segment. One
 * anchor per matching directory, by dirAnchors preference; ambiguity among
 * matching directories is settled from the source's position.
 */
function resolveDirAnchor(
  dir: string,
  fileMap: Map<string, string>,
  dirAnchors: string[],
  sourcePath?: string
): string | null {
  const qualified = dir.includes("/");
  const dirs = new Set<string>();
  for (const [path] of fileMap) {
    const segs = path.split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      const prefix = segs.slice(0, i + 1).join("/");
      const hit = qualified ? prefix === dir || prefix.endsWith("/" + dir) : segs[i] === dir;
      if (hit) {
        dirs.add(prefix);
        break;
      }
    }
  }

  const candidates: string[] = [];
  for (const d of dirs) {
    for (const anchor of dirAnchors) {
      if (fileMap.has(`${d}/${anchor}`)) {
        candidates.push(`${d}/${anchor}`);
        break;
      }
    }
  }

  return disambiguateCandidates(candidates, sourcePath);
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

