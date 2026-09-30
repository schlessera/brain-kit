/**
 * Skill installation from archives — the "install" half of the Settings →
 * Skills surface: a user-uploaded ZIP, or a GitHub repository (public, or
 * private via the deployment's GITHUB_TOKEN) fetched as a zipball. Both run
 * through ONE pipeline so they share the same guarantees:
 *
 * - A skill is any directory in the archive containing a SKILL.md (the
 *   archive root included). One archive may carry several skills.
 * - The INSTALLED name comes from the SKILL.md frontmatter (validated like a
 *   created skill), not from whatever the archive called the folder.
 * - Zip-slip is structurally impossible: entry paths are normalized and any
 *   `..`, absolute path, backslash, or NUL rejects the archive; files are
 *   written only under `.agents/skills/<name>/`, staged then swapped so a
 *   half-written skill is never discoverable.
 * - Caps: archive ≤ 100 MB compressed, ≤ 250 MB inflated, ≤ 400 files per
 *   skill, per-file ≤ 10 MB. The inflated and per-file caps are enforced
 *   DURING decompression (streaming), so a zip bomb aborts at the cap
 *   instead of inflating fully into memory first.
 * - Conflicts are SKIPPED by default and reported; `overwrite: true` may
 *   replace an existing CUSTOM skill (enabled or disabled) but can never
 *   touch a package skill — those are symlinks and stay refused.
 */

import { Unzip, UnzipInflate } from "fflate";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { parseFrontmatter } from "../lib/frontmatter-parse.js";

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_INFLATED_BYTES = 250 * 1024 * 1024;
export const MAX_FILES_PER_SKILL = 400;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class InstallError extends Error {}

export interface InstallOutcome {
  /** Installed-as name (frontmatter), or the archive folder for failures. */
  name: string;
  status: "installed" | "replaced" | "skipped";
  reason?: string;
  files?: number;
}

export interface InstallOptions {
  overwrite?: boolean;
  /** Only consider entries under this archive subpath (GitHub `tree` URLs). */
  subpath?: string;
}

export interface InstallDeps {
  brainPath: string;
}

/** A safe, normalized archive path or null. Rejects slip vectors outright. */
function safeEntryPath(raw: string): string | null {
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) return null;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.length > 128)) return null;
  return parts.join("/");
}

function existsAs(p: string): "dir" | "symlink" | null {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.length;
  }
  return whole;
}

export interface UnzipCaps {
  maxFileBytes: number;
  maxInflatedBytes: number;
}

/**
 * Streaming unzip with the size caps enforced as bytes decompress. unzipSync
 * would inflate the whole archive before any check could run — exactly the
 * zip-bomb window the caps exist to close. Caps are injectable for tests;
 * production uses the module constants.
 */
export function unzipWithCaps(
  archive: Uint8Array,
  caps: UnzipCaps = { maxFileBytes: MAX_FILE_BYTES, maxInflatedBytes: MAX_INFLATED_BYTES }
): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let inflated = 0;
  let sawEntry = false;
  const unzip = new Unzip((file) => {
    sawEntry = true;
    if (file.name.endsWith("/")) return; // directory marker
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (err) {
        throw new InstallError(
          `Archive entry ${JSON.stringify(file.name)} does not decompress: ${err.message}`
        );
      }
      size += data.length;
      inflated += data.length;
      if (size > caps.maxFileBytes) {
        throw new InstallError(`${file.name} exceeds ${caps.maxFileBytes / 1024 / 1024}MB.`);
      }
      if (inflated > caps.maxInflatedBytes) {
        throw new InstallError(
          `Archive inflates past the ${caps.maxInflatedBytes / 1024 / 1024}MB cap.`
        );
      }
      chunks.push(data);
      if (final) entries[file.name] = concatChunks(chunks, size);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(archive, true);
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError(
      `Not a readable ZIP archive: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  // The streaming parser scans for entry signatures and finds none in
  // garbage instead of throwing the way unzipSync did.
  if (!sawEntry) throw new InstallError("Not a readable ZIP archive: no entries found.");
  return entries;
}

/**
 * The shared core: install every skill found among already-unzipped entries.
 * Throws InstallError for archive-level problems; per-skill problems land as
 * skipped outcomes.
 */
export function installSkillsFromEntries(
  deps: InstallDeps,
  entries: Record<string, Uint8Array>,
  opts: InstallOptions = {}
): InstallOutcome[] {
  // Normalize + guard every entry, enforcing the inflated cap.
  const files = new Map<string, Uint8Array>();
  let inflated = 0;
  for (const [raw, bytes] of Object.entries(entries)) {
    if (raw.endsWith("/")) continue; // directory marker
    const path = safeEntryPath(raw);
    if (path === null) {
      throw new InstallError(`Archive contains an unsafe path: ${JSON.stringify(raw)}`);
    }
    if (bytes.length > MAX_FILE_BYTES) {
      throw new InstallError(`${path} exceeds ${MAX_FILE_BYTES / 1024 / 1024}MB.`);
    }
    inflated += bytes.length;
    if (inflated > MAX_INFLATED_BYTES) {
      throw new InstallError("Archive inflates past the 50MB cap.");
    }
    files.set(path, bytes);
  }

  // Candidate skill roots: every directory (or the root) holding a SKILL.md,
  // optionally filtered to a subpath.
  const prefix = opts.subpath ? opts.subpath.replace(/^\/+|\/+$/g, "") + "/" : "";
  const roots = [...files.keys()]
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .map((p) => (p === "SKILL.md" ? "" : p.slice(0, -"/SKILL.md".length)))
    .filter((root) => (prefix ? (root + "/").startsWith(prefix) : true))
    .sort();
  if (roots.length === 0) {
    throw new InstallError(
      "No skill found: no directory containing a SKILL.md" +
        (opts.subpath ? ` under "${opts.subpath}"` : "") +
        "."
    );
  }

  const enabledDir = join(deps.brainPath, ".agents", "skills");
  const disabledDir = join(deps.brainPath, ".agents", "skills-disabled");
  mkdirSync(enabledDir, { recursive: true });

  const outcomes: InstallOutcome[] = [];
  for (const root of roots) {
    const rootPrefix = root === "" ? "" : root + "/";
    const label = root || "(archive root)";
    // Each file belongs to its DEEPEST skill root, so nested skills never
    // double-install into their parent.
    const deeper = roots.filter((r) => r !== root && r.startsWith(rootPrefix));
    const skillFiles = new Map<string, Uint8Array>();
    for (const [path, bytes] of files) {
      if (!path.startsWith(rootPrefix)) continue;
      if (deeper.some((d) => path.startsWith(d + "/"))) continue;
      skillFiles.set(path.slice(rootPrefix.length), bytes);
    }

    outcomes.push(installOne(label, skillFiles, enabledDir, disabledDir, opts));
  }
  return outcomes;
}

function installOne(
  label: string,
  skillFiles: Map<string, Uint8Array>,
  enabledDir: string,
  disabledDir: string,
  opts: InstallOptions
): InstallOutcome {
  const skillMd = skillFiles.get("SKILL.md");
  if (!skillMd) return { name: label, status: "skipped", reason: "SKILL.md unreadable" };

  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(Buffer.from(skillMd).toString("utf-8")).data as Record<string, unknown>;
  } catch (e) {
    return {
      name: label,
      status: "skipped",
      reason: `frontmatter does not parse: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const name = typeof data.name === "string" ? data.name : "";
  if (!NAME_PATTERN.test(name)) {
    return {
      name: label,
      status: "skipped",
      reason: "frontmatter `name` missing or not lowercase kebab-case",
    };
  }
  if (typeof data.description !== "string" || !data.description.trim()) {
    return { name, status: "skipped", reason: "frontmatter has no `description`" };
  }
  if (skillFiles.size > MAX_FILES_PER_SKILL) {
    return { name, status: "skipped", reason: `more than ${MAX_FILES_PER_SKILL} files` };
  }

  const target = join(enabledDir, name);
  const disabledTarget = join(disabledDir, name);
  if (existsAs(target) === "symlink") {
    return {
      name,
      status: "skipped",
      reason: "a built-in (package) skill has this name; rename yours in the frontmatter",
    };
  }
  const existing = existsAs(target) === "dir" || existsAs(disabledTarget) === "dir";
  if (existing && !opts.overwrite) {
    return { name, status: "skipped", reason: "already installed (enable overwrite to replace)" };
  }

  // Stage into a temp sibling, then swap — a half-written skill dir must
  // never be what an agent discovers.
  const staging = join(enabledDir, `.install-${name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [rel, bytes] of skillFiles) {
      const dest = join(staging, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
    rmSync(target, { recursive: true, force: true });
    if (existsSync(disabledTarget)) rmSync(disabledTarget, { recursive: true, force: true });
    renameSync(staging, target);
    return { name, status: existing ? "replaced" : "installed", files: skillFiles.size };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return {
      name,
      status: "skipped",
      reason: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Install every skill found in an uploaded ZIP archive. */
export function installSkillsFromZip(
  deps: InstallDeps,
  archive: Uint8Array,
  opts: InstallOptions = {}
): InstallOutcome[] {
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new InstallError(`Archive exceeds ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB.`);
  }
  return installSkillsFromEntries(deps, unzipWithCaps(archive), opts);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GitHubSource {
  owner: string;
  repo: string;
  ref?: string;
  /** Repo subpath to search for skills (from a /tree/<ref>/<path> URL). */
  subpath?: string;
}

/**
 * Parse "owner/repo", a github.com URL, or a /tree/<ref>/<subpath> URL.
 * The ref/subpath split is heuristic for URLs (a ref containing "/" cannot
 * be told apart from a path); pass an explicit ref for those.
 */
export function parseGitHubSource(input: string): GitHubSource | null {
  const trimmed = input.trim();
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (bare) return { owner: bare[1]!, repo: bare[2]!.replace(/\.git$/, "") };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  if (parts.length >= 4 && (parts[2] === "tree" || parts[2] === "blob")) {
    const ref = parts[3]!;
    const subpath = parts.slice(4).join("/") || undefined;
    return { owner, repo, ref, ...(subpath ? { subpath } : {}) };
  }
  return { owner, repo };
}

/** Injectable for tests; production passes globalThis.fetch. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Read a response body, aborting the download once it grows past the cap. */
async function readBodyCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.length > cap) {
      throw new InstallError(`Repository archive exceeds ${cap / 1024 / 1024}MB.`);
    }
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new InstallError(`Repository archive exceeds ${cap / 1024 / 1024}MB.`);
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}

/**
 * Download a repo zipball (the API endpoint — works for private repos with a
 * token, follows the codeload redirect) and install through the shared
 * pipeline. GitHub zipballs prefix every entry with `owner-repo-sha/`; that
 * wrapper folder is stripped before candidate discovery so subpaths from
 * /tree/ URLs match repo-relative paths.
 */
export async function installSkillsFromGitHub(
  deps: InstallDeps,
  source: GitHubSource,
  opts: { overwrite?: boolean; token?: string; fetcher?: Fetcher } = {}
): Promise<InstallOutcome[]> {
  const fetcher = opts.fetcher ?? fetch;
  const ref = source.ref ? `/${encodeURIComponent(source.ref)}` : "";
  const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/zipball${ref}`;
  const res = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "brain-kit-ui",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    redirect: "follow",
  });
  if (res.status === 404) {
    throw new InstallError(
      `GitHub says 404 for ${source.owner}/${source.repo}` +
        (opts.token
          ? "."
          : " — if the repository is private, set GITHUB_TOKEN on the server.")
    );
  }
  if (!res.ok) {
    throw new InstallError(`GitHub zipball fetch failed: HTTP ${res.status}`);
  }
  const buf = await readBodyCapped(res, MAX_ARCHIVE_BYTES);
  const entries = unzipWithCaps(buf);
  const stripped: Record<string, Uint8Array> = {};
  for (const [key, bytes] of Object.entries(entries)) {
    const slash = key.indexOf("/");
    if (slash === -1) continue; // nothing lives outside the wrapper dir
    stripped[key.slice(slash + 1)] = bytes;
  }
  return installSkillsFromEntries(deps, stripped, {
    ...(opts.overwrite !== undefined ? { overwrite: opts.overwrite } : {}),
    ...(source.subpath ? { subpath: source.subpath } : {}),
  });
}
