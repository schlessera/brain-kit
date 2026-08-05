import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, resolve, sep, posix, dirname } from "node:path";
import { existsSync } from "node:fs";
import ignore, { type Ignore } from "ignore";
import type { FileEntry, FileContentKind } from "@schlessera/brain-ui-sdk/protocol";
import { FILE_SIZE_CAP_BYTES } from "@schlessera/brain-ui-sdk/protocol";

const HARD_EXCLUDE_DIRS = new Set([".git", "node_modules"]);
const HARD_EXCLUDE_FILE_PATTERNS = [
  /\.db$/i,
  /\.db-wal$/i,
  /\.db-shm$/i,
];
// Build / dependency manifests that aren't browseable content. Matched by
// exact name (case-insensitive) at any depth.
const HARD_EXCLUDE_FILE_NAMES = new Set(
  [
    "package.json",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
    "yarn.lock",
    "pnpm-lock.yaml",
    "skills-lock.json",
  ].map((n) => n.toLowerCase())
);

export function getBrainRoot(): string {
  return process.env.BRAIN_PATH || join(process.env.HOME || "/root", "brain");
}

export class PathEscapeError extends Error {
  constructor(rel: string) {
    super(`path_escape: ${rel}`);
    this.name = "PathEscapeError";
  }
}

export class NotFoundError extends Error {
  constructor(rel: string) {
    super(`not_found: ${rel}`);
    this.name = "NotFoundError";
  }
}

export class TooLargeError extends Error {
  constructor(public size: number) {
    super(`file_too_large: ${size}`);
    this.name = "TooLargeError";
  }
}

/**
 * Resolve a repo-relative path to an absolute path, rejecting any escape
 * outside the brain root (including via symlinks).
 */
export async function safeResolve(rel: string, root = getBrainRoot()): Promise<string> {
  if (typeof rel !== "string") throw new PathEscapeError(String(rel));
  // Reject absolute paths and null bytes
  if (rel.startsWith("/") || rel.startsWith("\\") || rel.includes("\0")) {
    throw new PathEscapeError(rel);
  }
  // Normalize separators; reject ".." segments anywhere
  const normalized = rel.replace(/\\/g, "/");
  for (const seg of normalized.split("/")) {
    if (seg === "..") throw new PathEscapeError(rel);
  }
  const absRoot = resolve(root);
  const abs = resolve(absRoot, normalized);
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new PathEscapeError(rel);
  }
  // Check for symlink escape via realpath when the path exists
  if (existsSync(abs)) {
    const real = await realpath(abs);
    if (real !== absRoot && !real.startsWith(absRoot + sep)) {
      throw new PathEscapeError(rel);
    }
  }
  return abs;
}

interface CachedIgnore {
  matcher: Ignore;
  mtime: number;
}
const ignoreCache = new Map<string, CachedIgnore>();

async function loadIgnore(root: string): Promise<Ignore> {
  const gitignore = join(root, ".gitignore");
  let mtime = 0;
  try {
    const s = await stat(gitignore);
    mtime = s.mtimeMs;
  } catch {
    // no .gitignore — empty matcher
  }
  const cached = ignoreCache.get(root);
  if (cached && cached.mtime === mtime) return cached.matcher;

  const matcher = ignore();
  if (mtime > 0) {
    try {
      const text = await readFile(gitignore, "utf8");
      matcher.add(text);
    } catch {}
  }
  ignoreCache.set(root, { matcher, mtime });
  return matcher;
}

function isHardExcluded(name: string, isDir: boolean): boolean {
  // Hide all dotfiles and dot-directories — they are tooling/config noise
  // (.git, .gitignore, .agents, .claude, .brain-ui, etc.) that the user
  // doesn't want to navigate as content.
  if (name.startsWith(".")) return true;
  if (isDir) return HARD_EXCLUDE_DIRS.has(name);
  if (HARD_EXCLUDE_FILE_NAMES.has(name.toLowerCase())) return true;
  return HARD_EXCLUDE_FILE_PATTERNS.some((re) => re.test(name));
}

/**
 * List entries of a directory, applying ignore rules.
 * Always excludes: .git, node_modules, *.db*. Then applies .gitignore.
 */
export async function listDirectory(rel: string, root = getBrainRoot()): Promise<FileEntry[]> {
  const abs = await safeResolve(rel, root);
  let s;
  try {
    s = await stat(abs);
  } catch {
    throw new NotFoundError(rel);
  }
  if (!s.isDirectory()) throw new NotFoundError(rel);

  const matcher = await loadIgnore(root);
  const dirents = await readdir(abs, { withFileTypes: true });

  const entries: FileEntry[] = [];
  for (const d of dirents) {
    const isDir = d.isDirectory();
    const isFile = d.isFile();
    const isSymlink = d.isSymbolicLink();
    if (!isDir && !isFile && !isSymlink) continue;
    if (isHardExcluded(d.name, isDir)) continue;

    const relChild = rel ? posix.join(rel, d.name) : d.name;
    // ignore expects trailing slash on dirs to match dir-only rules
    const matchPath = isDir ? `${relChild}/` : relChild;
    if (matcher.ignores(matchPath)) continue;

    let childStat;
    try {
      childStat = await stat(join(abs, d.name));
    } catch {
      continue; // broken symlink
    }
    // Resolve symlinks: drop ones that escape the root
    if (isSymlink) {
      try {
        const real = await realpath(join(abs, d.name));
        const absRoot = resolve(root);
        if (real !== absRoot && !real.startsWith(absRoot + sep)) continue;
      } catch {
        continue;
      }
    }

    entries.push({
      name: d.name,
      path: relChild,
      type: childStat.isDirectory() ? "dir" : "file",
      size: childStat.isFile() ? childStat.size : undefined,
      mtime: Math.floor(childStat.mtimeMs),
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
}

const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
const HTML_EXT = new Set([".html", ".htm"]);
const KNOWN_TEXT_EXT = new Set([
  ".txt", ".text", ".log",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h",
  ".cpp", ".hpp", ".cc", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish",
  ".css", ".scss", ".sass", ".less",
  ".sql", ".env", ".ini", ".conf", ".cfg",
  ".gitignore", ".gitattributes", ".editorconfig", ".prettierrc",
  ".dockerfile", ".lock",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0) return "";
  return name.slice(i).toLowerCase();
}

export function classifyKind(name: string, bytes?: Buffer): FileContentKind {
  const ext = extOf(name);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (KNOWN_TEXT_EXT.has(ext)) return "text";
  // Bare names like "Dockerfile", "Makefile", "LICENSE", "README"
  const base = name.toLowerCase();
  if (["dockerfile", "makefile", "license", "licence", "readme", "changelog", "authors", "contributors", "notice"].includes(base)) {
    return "text";
  }
  // Fall back to byte sniff: a buffer is "text" if no NUL byte in first 4KB and decodes as UTF-8.
  if (bytes) {
    const slice = bytes.subarray(0, Math.min(bytes.length, 4096));
    if (slice.includes(0)) return "binary";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(slice);
      return "text";
    } catch {
      return "binary";
    }
  }
  return "binary";
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function mimeFor(name: string, kind: FileContentKind): string {
  const ext = extOf(name);
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (kind === "markdown") return "text/markdown; charset=utf-8";
  if (kind === "html") return "text/html; charset=utf-8";
  if (kind === "text") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export interface FileContent {
  kind: FileContentKind;
  size: number;
  mtime: number;
  mime: string;
  content?: string;
}

export async function readFileContent(rel: string, root = getBrainRoot()): Promise<FileContent> {
  const abs = await safeResolve(rel, root);
  let s;
  try {
    s = await stat(abs);
  } catch {
    throw new NotFoundError(rel);
  }
  if (!s.isFile()) throw new NotFoundError(rel);
  if (s.size > FILE_SIZE_CAP_BYTES) throw new TooLargeError(s.size);

  const ext = extOf(abs);
  const presumed: FileContentKind | null = MARKDOWN_EXT.has(ext)
    ? "markdown"
    : HTML_EXT.has(ext)
      ? "html"
      : KNOWN_TEXT_EXT.has(ext)
        ? "text"
        : null;

  if (presumed) {
    const content = await readFile(abs, "utf8");
    return {
      kind: presumed,
      size: s.size,
      mtime: Math.floor(s.mtimeMs),
      mime: mimeFor(rel, presumed),
      content,
    };
  }

  const buf = await readFile(abs);
  const kind = classifyKind(abs, buf);
  if (kind === "text" || kind === "markdown" || kind === "html") {
    return {
      kind,
      size: s.size,
      mtime: Math.floor(s.mtimeMs),
      mime: mimeFor(rel, kind),
      content: buf.toString("utf8"),
    };
  }
  return {
    kind: "binary",
    size: s.size,
    mtime: Math.floor(s.mtimeMs),
    mime: mimeFor(rel, "binary"),
  };
}

/**
 * Stream raw bytes of a file (for image/binary preview).
 * Returns the absolute path; caller uses Bun.file() to stream.
 */
export async function resolveForRaw(rel: string, root = getBrainRoot()): Promise<{ abs: string; size: number; mime: string; kind: FileContentKind }> {
  const abs = await safeResolve(rel, root);
  let s;
  try {
    s = await stat(abs);
  } catch {
    throw new NotFoundError(rel);
  }
  if (!s.isFile()) throw new NotFoundError(rel);
  if (s.size > FILE_SIZE_CAP_BYTES) throw new TooLargeError(s.size);
  const kind = classifyKind(abs);
  return { abs, size: s.size, mime: mimeFor(rel, kind), kind };
}

/**
 * Walk the brain repo and build a slug -> repo-relative-path map for all
 * markdown files (.md / .markdown / .mdx), respecting the same ignore
 * rules as listDirectory. Slug = basename without extension, lowercase.
 *
 * If two files share a slug (rare), the first one encountered wins —
 * deterministic given the sorted directory traversal.
 */
export async function buildWikilinkMap(root = getBrainRoot()): Promise<Record<string, string>> {
  const matcher = await loadIgnore(root);
  const out: Record<string, string> = {};

  async function walk(rel: string): Promise<void> {
    const abs = await safeResolve(rel, root);
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort for deterministic precedence
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const isDir = d.isDirectory();
      const isFile = d.isFile();
      const isSymlink = d.isSymbolicLink();
      if (!isDir && !isFile && !isSymlink) continue;
      if (isHardExcluded(d.name, isDir)) continue;
      const relChild = rel ? posix.join(rel, d.name) : d.name;
      const matchPath = isDir ? `${relChild}/` : relChild;
      if (matcher.ignores(matchPath)) continue;

      let childStat;
      try {
        childStat = await stat(join(abs, d.name));
      } catch {
        continue;
      }
      if (isSymlink) {
        try {
          const real = await realpath(join(abs, d.name));
          const absRoot = resolve(root);
          if (real !== absRoot && !real.startsWith(absRoot + sep)) continue;
        } catch {
          continue;
        }
      }

      if (childStat.isDirectory()) {
        await walk(relChild);
        continue;
      }
      const lower = d.name.toLowerCase();
      const dot = lower.lastIndexOf(".");
      const ext = dot >= 0 ? lower.slice(dot) : "";
      if (ext !== ".md" && ext !== ".markdown" && ext !== ".mdx") continue;
      const slug = lower.slice(0, dot);
      if (slug && !out[slug]) out[slug] = relChild;
    }
  }

  await walk("");
  return out;
}

/**
 * Return ancestor directories of a path, root-first (excluding root and the path itself).
 *   resolve("a/b/c.md") -> { ancestors: ["a", "a/b"], exists, type }
 */
export async function resolveAncestors(rel: string, root = getBrainRoot()): Promise<{ ancestors: string[]; exists: boolean; type?: "dir" | "file" }> {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return { ancestors: [], exists: true, type: "dir" };
  const parts = normalized.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join("/"));
  }
  try {
    const abs = await safeResolve(normalized, root);
    const s = await stat(abs);
    return { ancestors, exists: true, type: s.isDirectory() ? "dir" : "file" };
  } catch {
    return { ancestors, exists: false };
  }
}

// Re-export for callers
export { dirname };
