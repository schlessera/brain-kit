/**
 * Media in a brain: which files are binaries worth a decision before they are
 * committed, and the size past which any file is. A brain is a text
 * knowledge base, and git keeps every version of a binary forever, so
 * `brain sync assess` classes these as MEDIA or LARGE for the sync skill to
 * ask about, and `brain doctor` reports the heaviest ones already tracked.
 * See docs/media.md.
 */

import type { BrainConfig } from "./config.js";
import { matchesAnyPattern } from "./tool-leftovers.js";

/** Images, PDF, audio, video and office documents. SVG is text and is not here. */
export const MEDIA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif",
  "pdf",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus",
  "mp4", "mov", "m4v", "webm", "mkv", "avi",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "key", "pages", "numbers",
]);

export interface MediaPolicy {
  maxTrackedBytes: number;
  track: string[];
  ignore: string[];
}

/** 5 MiB: well under GitHub's 50 MiB warning, and large for a note's attachment. */
export const DEFAULT_MEDIA_POLICY: MediaPolicy = { maxTrackedBytes: 5 * 1024 * 1024, track: [], ignore: [] };

export function mediaPolicy(config: BrainConfig | null | undefined): MediaPolicy {
  const media = config?.media;
  return {
    maxTrackedBytes: media?.maxTrackedBytes ?? DEFAULT_MEDIA_POLICY.maxTrackedBytes,
    track: media?.track ?? [],
    ignore: media?.ignore ?? [],
  };
}

export function isMediaPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 && MEDIA_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** The policy's own verdict for `path`, before any size or media class: `ignore` wins over `track`. */
export function mediaPolicyClass(path: string, policy: MediaPolicy): "ARTIFACT" | "TRACK" | null {
  if (matchesAnyPattern(path, policy.ignore)) return "ARTIFACT";
  if (matchesAnyPattern(path, policy.track)) return "TRACK";
  return null;
}

/** `bytes` for a person: `6.0 MB`, `20.0 KB`, `512 B`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export interface IndexedFile {
  path: string;
  /** Size of the blob git stores for it (for an LFS file, the pointer's). */
  bytes: number;
  /** The blob is a Git LFS pointer; the payload lives on the LFS server. */
  lfs: boolean;
}

/** What `git lfs` writes as the first line of every pointer file. */
const LFS_POINTER = "version https://git-lfs.github.com/spec/";
/** Pointer files are around 130 bytes; anything this size or larger is content. */
const MAX_POINTER_BYTES = 1024;

function git(root: string, args: string[], stdin?: string): { ok: boolean; stdout: Buffer; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { ok: proc.exitCode === 0, stdout: Buffer.from(proc.stdout), stderr: new TextDecoder().decode(proc.stderr).trim() };
}

/**
 * Every regular file in git's index with the size of the blob git stores:
 * what a clone downloads, not what happens to be in the work tree. Read-only
 * (`git ls-files -s`, `git cat-file --batch-check`). Symlinks and submodules
 * are skipped (git stores a link target or a commit, not content), and a small
 * blob that is a Git LFS pointer is marked. Anything that could not be read is
 * returned in `problems`, never silently dropped.
 */
export function indexedFiles(root: string): { files: IndexedFile[]; problems: string[] } {
  const listed = git(root, ["ls-files", "-s", "-z"]);
  if (!listed.ok) return { files: [], problems: [`git ls-files failed: ${listed.stderr}`] };
  const entries: { path: string; sha: string }[] = [];
  for (const record of listed.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    // Regular files only (100644, 100755), and one entry per path mid-merge.
    if (!mode.startsWith("100") || (stage !== "0" && stage !== "2")) continue;
    entries.push({ path: record.slice(tab + 1), sha });
  }
  if (entries.length === 0) return { files: [], problems: [] };

  const checked = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], entries.map((e) => e.sha).join("\n") + "\n");
  if (!checked.ok) return { files: [], problems: [`git cat-file failed: ${checked.stderr}`] };
  const lines = checked.stdout.toString("utf8").trimEnd().split("\n");
  const files: IndexedFile[] = [];
  const problems: string[] = [];
  entries.forEach((entry, i) => {
    const [sha, type, size] = (lines[i] ?? "").split(" ");
    if (sha !== entry.sha || type !== "blob" || !/^\d+$/.test(size ?? "")) {
      problems.push(`${entry.path}: object ${entry.sha} could not be read (${lines[i] ?? "no answer"})`);
      return;
    }
    files.push({ path: entry.path, bytes: Number(size), lfs: false });
  });

  // Only a small blob can be a pointer; read just those.
  const small = files.filter((f) => f.bytes < MAX_POINTER_BYTES);
  if (small.length > 0) {
    const shaOf = new Map(entries.map((e) => [e.path, e.sha]));
    const batch = git(root, ["cat-file", "--batch"], small.map((f) => shaOf.get(f.path)).join("\n") + "\n");
    if (!batch.ok) {
      problems.push(`git cat-file --batch failed, so Git LFS pointers were not recognised: ${batch.stderr}`);
    } else {
      let at = 0;
      for (const file of small) {
        const header = batch.stdout.indexOf(0x0a, at);
        const size = Number(batch.stdout.subarray(at, header).toString("utf8").split(" ")[2]);
        const body = batch.stdout.subarray(header + 1, header + 1 + size);
        file.lfs = body.toString("utf8").startsWith(LFS_POINTER);
        at = header + 1 + size + 1; // the body, then a newline
      }
    }
  }
  return { files, problems };
}
