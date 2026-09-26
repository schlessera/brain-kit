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

export type GitRun = (root: string, args: string[], stdin?: string) => { ok: boolean; stdout: Buffer; stderr: string };

const runGit: GitRun = (root, args, stdin) => {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { ok: proc.exitCode === 0, stdout: Buffer.from(proc.stdout), stderr: new TextDecoder().decode(proc.stderr).trim() };
};

/**
 * Parse `git cat-file --batch` output for `shas`, in order: for each, the blob
 * body, or null when git answered "missing", another type, or anything the
 * parser cannot align. After a malformed answer the rest are null too, because
 * the position of the next header is no longer known.
 */
export function parseCatFileBatch(stdout: Buffer, shas: string[]): (Buffer | null)[] {
  const bodies: (Buffer | null)[] = [];
  let at = 0;
  for (const sha of shas) {
    const end = stdout.indexOf(0x0a, at);
    if (end === -1) break;
    const [name, type, size] = stdout.subarray(at, end).toString("utf8").split(" ");
    if (name === sha && type === "missing") {
      bodies.push(null);
      at = end + 1;
      continue;
    }
    const bytes = Number(size);
    const bodyEnd = end + 1 + bytes;
    if (name !== sha || type !== "blob" || !/^\d+$/.test(size ?? "") || bodyEnd >= stdout.length || stdout[bodyEnd] !== 0x0a) {
      break;
    }
    bodies.push(stdout.subarray(end + 1, bodyEnd));
    at = bodyEnd + 1;
  }
  while (bodies.length < shas.length) bodies.push(null);
  return bodies;
}

/**
 * Every regular file in git's index with the size of the blob git stores:
 * what a clone downloads, not what happens to be in the work tree. Read-only
 * (`git ls-files -s`, `git cat-file --batch-check`, and `--batch` for small
 * blobs). Symlinks and submodules are skipped (git stores a link target or a
 * commit, not content), and a small blob that is a Git LFS pointer is marked.
 * A conflicted path, or anything that could not be read, is returned in
 * `problems`, never silently dropped.
 */
export function indexedFiles(root: string, git: GitRun = runGit): { files: IndexedFile[]; problems: string[] } {
  const listed = git(root, ["ls-files", "-s", "-z"]);
  if (!listed.ok) return { files: [], problems: [`git ls-files failed: ${listed.stderr}`] };
  const entries: { path: string; sha: string }[] = [];
  const conflicted = new Set<string>();
  for (const record of listed.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    // Mid-merge a path has stages 1-3 and no settled content to weigh.
    if (stage !== "0") {
      conflicted.add(path);
      continue;
    }
    // Regular files only (100644, 100755).
    if (!mode.startsWith("100")) continue;
    entries.push({ path, sha });
  }
  const problems: string[] = [];
  if (conflicted.size > 0) {
    const names = [...conflicted].sort();
    problems.push(`${names.length} conflicted path(s) not inspected until the merge is resolved: ${names.slice(0, 3).join(", ")}`);
  }
  if (entries.length === 0) return { files: [], problems };

  const checked = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], entries.map((e) => e.sha).join("\n") + "\n");
  if (!checked.ok) return { files: [], problems: [...problems, `git cat-file failed: ${checked.stderr}`] };
  const lines = checked.stdout.toString("utf8").trimEnd().split("\n");
  const files: (IndexedFile & { sha: string })[] = [];
  entries.forEach((entry, i) => {
    const [sha, type, size] = (lines[i] ?? "").split(" ");
    if (sha !== entry.sha || type !== "blob" || !/^\d+$/.test(size ?? "")) {
      problems.push(`${entry.path}: object ${entry.sha} could not be read (${lines[i] ?? "no answer"})`);
      return;
    }
    files.push({ path: entry.path, bytes: Number(size), lfs: false, sha: entry.sha });
  });

  // Only a small blob can be a pointer; read just those.
  const small = files.filter((f) => f.bytes < MAX_POINTER_BYTES);
  if (small.length > 0) {
    const batch = git(root, ["cat-file", "--batch"], small.map((f) => f.sha).join("\n") + "\n");
    if (!batch.ok) {
      problems.push(`git cat-file --batch failed, so Git LFS pointers were not recognised: ${batch.stderr}`);
    } else {
      const bodies = parseCatFileBatch(batch.stdout, small.map((f) => f.sha));
      small.forEach((file, i) => {
        const body = bodies[i];
        if (body === null || body.length !== file.bytes) {
          problems.push(`${file.path}: object ${file.sha} could not be read to check for a Git LFS pointer`);
        } else {
          file.lfs = body.toString("utf8").startsWith(LFS_POINTER);
        }
      });
    }
  }
  return { files: files.map(({ sha: _sha, ...file }) => file), problems };
}
