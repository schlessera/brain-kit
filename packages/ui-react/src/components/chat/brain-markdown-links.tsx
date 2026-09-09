import React from "react";

import { apiBase } from "../../lib/backend.js";
import {
  isInternalRepoDir,
  isInternalRepoPath,
  useFileStore,
} from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";

/**
 * Turn a markdown image source into something the browser can actually load.
 *
 * Anything already absolute — a `data:` URI, an http(s) URL, or a path that is
 * already an API route — passes through. A repo-relative path is rewritten to
 * the files endpoint, which is where brain content is served from.
 */
export function repoImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return src;
  if (/^(data:|blob:|https?:\/\/)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/api/")) return trimmed;
  const rel = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
  return `${apiBase()}/files/content?path=${encodeURIComponent(rel)}&raw=1`;
}
/** Click target for a repo-relative file reference. Opens the file panel + viewer. */
export function FileLink({ path, children }: { path: string; children?: React.ReactNode }) {
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  return (
    <a
      href={`#/files/${path}`}
      onClick={(e) => {
        e.preventDefault();
        setFilePanelOpen(true);
        void openFile(path);
      }}
      className="brain-file-link"
      title={path}
    >
      {children ?? path}
    </a>
  );
}

/**
 * Resolve an obsidian-style `[[target]]` to a repo-relative path using the
 * wikilink map. Targets containing `/` are treated as paths directly; bare
 * slugs are looked up by basename. An `#anchor` suffix is stripped before
 * lookup.
 */
function resolveWikilinkTarget(
  raw: string,
  slugMap: Record<string, string>
): string | null {
  const hashIdx = raw.indexOf("#");
  const noAnchor = hashIdx >= 0 ? raw.slice(0, hashIdx).trim() : raw.trim();
  if (!noAnchor) return null;
  if (noAnchor.includes("/")) {
    if (noAnchor.endsWith("/")) return null;
    return /\.[a-z0-9]{1,8}$/i.test(noAnchor) ? noAnchor : `${noAnchor}.md`;
  }
  return slugMap[noAnchor.toLowerCase()] ?? null;
}

/** Click target for `[[slug]]` / `[[slug|Label]]`. */
export function WikiLink({
  target,
  label,
}: {
  target: string;
  label?: string;
}) {
  const slugMap = useFileStore((s) => s.wikilinkMap);
  const loaded = useFileStore((s) => s.wikilinkLoaded);
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);

  const resolved = resolveWikilinkTarget(target, slugMap);
  const display = label ?? target;

  if (!resolved) {
    return (
      <span
        className="brain-wiki-link brain-wiki-link--unresolved"
        title={loaded ? `Unresolved wikilink: ${target}` : "Resolving…"}
      >
        {display}
      </span>
    );
  }

  return (
    <a
      href={`#/files/${resolved}`}
      onClick={(e) => {
        e.preventDefault();
        setFilePanelOpen(true);
        void openFile(resolved);
      }}
      className="brain-file-link brain-wiki-link"
      title={resolved}
    >
      {display}
    </a>
  );
}

/**
 * Click target for a repo-relative directory reference. Opens the file
 * panel, expands the tree down to the directory, and highlights it so
 * the user sees its contents.
 */
export function DirLink({ path, children }: { path: string; children?: React.ReactNode }) {
  const openDir = useFileStore((s) => s.openDir);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const trimmed = path.replace(/\/+$/, "");
  const display = `${trimmed}/`;
  return (
    <a
      href={`#/files/${display}`}
      onClick={(e) => {
        e.preventDefault();
        setFilePanelOpen(true);
        void openDir(trimmed);
      }}
      className="brain-file-link brain-file-link--dir"
      title={display}
    >
      {children ?? display}
    </a>
  );
}

// Bare-path tokens in prose. Three passes:
//  - files:     "notes/projects/foo.md"           — ends with .ext
//  - dirs:      "notes/projects/post-templates/"  — ends with /
//  - wikilinks: "[[slug]]" or "[[slug|Display]]"  — obsidian-style
const BARE_FILE_RE =
  /\b([a-z][a-z0-9_-]*(?:\/[a-z0-9._-]+)+\.[a-z0-9]{1,8})\b/gi;
const BARE_DIR_RE =
  /\b([a-z][a-z0-9_-]*(?:\/[a-z0-9._-]+)+\/)(?=$|[\s,;:!?)\]])/gi;
const WIKILINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

interface PathMatch {
  start: number;
  end: number;
  kind: "file" | "dir" | "wikilink";
  /** For file/dir kinds. */
  path?: string;
  /** Raw target inside the brackets (may include `#anchor`). For wikilink. */
  target?: string;
  /** Display label override (after the pipe). For wikilink. */
  label?: string;
}

function scanBarePaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  BARE_FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_FILE_RE.exec(text)) !== null) {
    if (isInternalRepoPath(m[1])) {
      out.push({
        start: m.index,
        end: BARE_FILE_RE.lastIndex,
        path: m[1],
        kind: "file",
      });
    }
  }
  BARE_DIR_RE.lastIndex = 0;
  while ((m = BARE_DIR_RE.exec(text)) !== null) {
    if (isInternalRepoDir(m[1])) {
      out.push({
        start: m.index,
        end: BARE_DIR_RE.lastIndex,
        path: m[1],
        kind: "dir",
      });
    }
  }
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: WIKILINK_RE.lastIndex,
      kind: "wikilink",
      target: m[1].trim(),
      label: m[2]?.trim(),
    });
  }
  out.sort((a, b) => a.start - b.start);

  // Drop overlapping matches — keep the first (earlier) when ranges collide
  const merged: PathMatch[] = [];
  let cursor = 0;
  for (const cand of out) {
    if (cand.start >= cursor) {
      merged.push(cand);
      cursor = cand.end;
    }
  }
  return merged;
}

export function renderBarePathsInText(text: string): React.ReactNode[] {
  const matches = scanBarePaths(text);
  if (matches.length === 0) return [text];
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of matches) {
    if (m.start > last) nodes.push(text.slice(last, m.start));
    if (m.kind === "file" && m.path) {
      nodes.push(
        <FileLink key={`p${key++}`} path={m.path}>
          {m.path}
        </FileLink>
      );
    } else if (m.kind === "dir" && m.path) {
      nodes.push(
        <DirLink key={`p${key++}`} path={m.path.replace(/\/+$/, "")}>
          {m.path}
        </DirLink>
      );
    } else if (m.kind === "wikilink" && m.target) {
      nodes.push(
        <WikiLink key={`p${key++}`} target={m.target} label={m.label} />
      );
    }
    last = m.end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Public helper: turn any raw text blob into React nodes with bare-path
 * tokens replaced by FileLink elements. Use this in non-markdown surfaces
 * (tool outputs, streaming logs, plain user text).
 */
export function linkifyPaths(text: string): React.ReactNode {
  if (!text) return text;
  const parts = renderBarePathsInText(text);
  if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
  return <>{parts}</>;
}
