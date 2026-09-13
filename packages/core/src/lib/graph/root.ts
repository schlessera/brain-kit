import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";

import { extractWikiLinks, createWikiLinkResolver } from "../indexer/links.js";
import { safeResolve } from "../safe-path.js";
import type { Taxonomy } from "../taxonomy.js";
import type { GraphRoot } from "./types.js";

/**
 * Entry files tried when the config names no root, in order. README.md is
 * deliberately absent: it addresses a human arriving at the repo, not the
 * knowledge graph.
 */
export const DEFAULT_ROOT_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

export interface ResolveGraphRootOptions {
  /** Brain repo root on disk. */
  root: string;
  /** Supplies `graph.root` from brain.config plus the wiki-link dir anchors. */
  taxonomy: Taxonomy;
  /** Explicit root; skips the configured value and the default candidates. */
  override?: string;
}

/**
 * Pick the document the graph is measured from.
 *
 * The usual entry file (AGENTS.md, CLAUDE.md) is excluded from indexing, so it
 * has no `documents` row and cannot be a node. Rather than fabricate one, it
 * becomes a *virtual* root: its wiki-links are resolved here and returned as
 * seeds, and consumers synthesize a node for it (id 0) when they need to draw
 * it.
 *
 * Note that a virtual root's links resolve by path and basename only —
 * frontmatter aliases are not retained in the database in a form this can
 * reconstruct, so an alias-only link from the entry file does not become a
 * seed. Both `brain index` and `brain graph compute` therefore see the same
 * seed set, which matters more here than catching the last few links.
 */
export function resolveGraphRoot(
  db: Database,
  options: ResolveGraphRootOptions
): GraphRoot | null {
  // A named root (--root, or graph.root in brain.config) is honoured as given.
  // The built-in entry files are only guesses, so they have to earn it.
  const named = options.override ?? options.taxonomy.graphRoot;
  const candidates: { path: string; named: boolean }[] = named
    ? [{ path: named, named: true }]
    : DEFAULT_ROOT_CANDIDATES.map((path) => ({ path, named: false }));

  const findDoc = db.prepare(
    "SELECT id FROM documents WHERE path = ? AND asset_type = 'markdown'"
  );

  for (const candidate of candidates) {
    const row = findDoc.get(candidate.path) as { id: number } | null;
    if (row) return { kind: "document", path: candidate.path, id: row.id };

    const seedIds = resolveEntryFileLinks(db, candidate.path, options);
    if (!seedIds) continue;
    // An entry file whose wiki-links resolve to nothing is not a root — it is a
    // file that happens to be called AGENTS.md. Adopting it anyway would report
    // the entire corpus as unreachable and offer a discovery view of one node,
    // which points a reader at the wrong problem. Falling through to "no root"
    // instead makes the UI ask for one.
    if (seedIds.length === 0 && !candidate.named) continue;
    return { kind: "virtual", path: candidate.path, seedIds };
  }

  return null;
}

/**
 * Read an index-excluded entry file from disk and resolve its wiki-links
 * against the indexed corpus. Returns null when the file is not there — which
 * is how the candidate list moves on to the next entry.
 */
function resolveEntryFileLinks(
  db: Database,
  candidate: string,
  options: ResolveGraphRootOptions
): number[] | null {
  const fullPath = safeResolve(options.root, candidate);
  if (!fullPath || !existsSync(fullPath)) return null;

  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }

  const rows = db
    .prepare("SELECT id, path, title FROM documents WHERE asset_type = 'markdown' ORDER BY id")
    .all() as { id: number; path: string; title: string }[];

  const fileMap = new Map<string, string>();
  const idByPath = new Map<string, number>();
  for (const row of rows) {
    fileMap.set(row.path, row.title);
    idByPath.set(row.path, row.id);
  }

  const resolveLink = createWikiLinkResolver(fileMap, options.taxonomy.dirAnchors);
  const seedIds: number[] = [];
  const seen = new Set<number>();
  for (const link of extractWikiLinks(content)) {
    const targetPath = resolveLink(link, candidate);
    if (!targetPath) continue;
    const id = idByPath.get(targetPath);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    seedIds.push(id);
  }

  return seedIds;
}

/** The `index_metadata.graph_root` value for a resolved root. */
export function graphRootKey(root: GraphRoot): string {
  return root.kind === "virtual" ? `virtual:${root.path}` : root.path;
}
