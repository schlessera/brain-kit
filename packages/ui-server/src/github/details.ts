/**
 * On-demand GitHub detail pages and the avatar proxy for the chat components
 * (#3796, epic #3791). Display data only: nothing here reaches a turn, the
 * provider-facing conversation, the turn journal or the session's taint.
 *
 * Bounded authority. A page is served only for an object (`owner/repo#n`)
 * that a host GitHub tool result in that session returned, read from the
 * session's own recorded history; an avatar only for a login that appears in
 * those results or in a page served for that session. It is not a GitHub
 * proxy: the paths are fixed per part, under the fixed API origin, with the
 * tools' dedicated credential (`BRAIN_UI_GITHUB_TOOLS_TOKEN`, no fallback).
 *
 * Items use the tools' contract types, and every direct link passes the
 * contract's validator for its kind and identity, else it is null. Nothing
 * here builds a GitHub URL a component may open.
 *
 * Avatars come from GitHub's avatar host without any credential. Only PNG,
 * JPEG, GIF and WebP pass, judged by their bytes, within a byte and a pixel
 * cap, and they are kept in a bounded in-memory cache that evicts and never
 * grows: nothing is written to disk, `brain.db` or the brain.
 */
import {
  GITHUB_DETAIL_PAGE_SIZE, GITHUB_LIMITS, GITHUB_RESULT_SCHEMAS, GITHUB_TOOL_NAMES, BRIDGE_MCP_PREFIX, githubDirectUrl, parseGithubRepository,
  type GithubAuthor, type GithubChangedFile, type GithubCheckRun, type GithubComment, type GithubCommit, type GithubDetailPage, type GithubDetailPart,
  type GithubLinkScope, type GithubReview, type GithubReviewComment, type GithubToolName, type GithubUser,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import {
  GithubRefusal, LOGIN, SHA, array, author, body, comment, commit, cut, githubGet, integer, nextLink, record, review, text, time, requiredTime,
  type GithubTransport, type Json,
} from "./host.js";

/** The host that serves avatars, and the only one an avatar request reaches. */
const GITHUB_AVATAR_ORIGIN = "https://avatars.githubusercontent.com";
/** The sizes an avatar is fetched at; a request takes the smallest that covers it. */
const GITHUB_AVATAR_SIZES = [32, 64, 128, 256] as const;
const GITHUB_AVATAR_LIMITS = Object.freeze({
  /** One image, bytes. */
  bytes: 512 * 1024,
  /** One image's width and height, pixels. */
  pixels: 1024,
  /** The cache: entries and bytes held at most, and how long one is kept. */
  entries: 256,
  cacheBytes: 8 * 1024 * 1024,
  ttlMs: 6 * 60 * 60 * 1000,
});

/** The objects and logins a session's GitHub tool results returned. */
interface GithubSessionScope {
  /** `owner/repo#n`, lower-cased, to whether it is a pull request (null when no result said). */
  objects: Map<string, { repository: string; number: number; pullRequest: boolean | null }>;
  /** Lower-cased logins. */
  logins: Set<string>;
}

const objectKey = (repository: string, number: number) => `${repository.toLowerCase()}#${number}`;

function toolName(name: string): GithubToolName | null {
  const bare = name.startsWith(BRIDGE_MCP_PREFIX) ? name.slice(BRIDGE_MCP_PREFIX.length) : name;
  return (Object.values(GITHUB_TOOL_NAMES) as string[]).includes(bare) ? bare as GithubToolName : null;
}

/**
 * What the session's recorded GitHub tool results returned. Only a result
 * that parses as the tool's own successful envelope counts: an error, a
 * truncated or edited output, or another tool's text names nothing.
 */
export function githubSessionScope(messages: readonly SessionHistoryMessage[]): GithubSessionScope {
  const scope: GithubSessionScope = { objects: new Map(), logins: new Set() };
  const login = (user: GithubUser | GithubAuthor | null | undefined) => { if (user?.login) scope.logins.add(user.login.toLowerCase()); };
  const object = (repository: string, number: number, pullRequest: boolean | null) => {
    const key = objectKey(repository, number), known = scope.objects.get(key);
    if (!known || known.pullRequest === null) scope.objects.set(key, { repository, number, pullRequest });
  };
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const tool = toolName(call.name);
      if (!tool || call.isError || typeof call.output !== "string" || call.output.length > 4_000_000) continue;
      let raw: unknown;
      try { raw = JSON.parse(call.output); } catch { continue; }
      const parsed = GITHUB_RESULT_SCHEMAS[tool].safeParse(raw);
      if (!parsed.success || !parsed.data.ok) continue;
      const result = parsed.data.result;
      switch (result.kind) {
        case "issue": case "pull_request": {
          object(result.repository, result.number, result.kind === "pull_request");
          login(result.author);
          for (const item of result.comments.items) login(item.author);
          if (result.kind === "pull_request") {
            login(result.merged_by);
            for (const user of result.requested_reviewers) login(user);
            for (const item of result.reviews.items) login(item.author);
            for (const item of result.review_decisions) login(item.reviewer);
            for (const item of result.commits.items) login(item.author);
          }
          break;
        }
        case "search":
          for (const item of result.items) { object(result.repository, item.number, item.kind === "pull_request"); login(item.author); }
          break;
        case "issue_created": case "comment_created":
          object(result.repository, result.number, null);
          break;
      }
    }
  }
  return scope;
}

/** A refused cursor or part, before anything is sent. */
export class GithubDetailInputError extends Error {
  constructor(readonly reason: "part" | "cursor" | "not_pull_request", message: string) { super(message); }
}

export interface GithubDetailsOptions extends GithubTransport {
  /** The tools' dedicated credential; undefined answers `unavailable`. */
  token: () => string | undefined;
  /** @internal Test seam for the avatar host; production uses the global fetch. */
  avatarFetch?: typeof fetch;
  /** @internal Test bounds; production uses {@link GITHUB_AVATAR_LIMITS}. */
  avatarLimits?: Partial<Record<keyof typeof GITHUB_AVATAR_LIMITS, number>>;
}

interface GithubAvatar { bytes: Uint8Array<ArrayBuffer>; type: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }

export interface GithubDetails {
  /** One page of `part`, or a {@link GithubRefusal} / {@link GithubDetailInputError}. */
  page(sessionId: string, object: { repository: string; number: number; pullRequest: boolean | null }, part: GithubDetailPart,
    cursor: string | null, signal?: AbortSignal): Promise<GithubDetailPage>;
  /** Whether `login` appeared in a page served for this session. */
  servedLogin(sessionId: string, login: string): boolean;
  /** The avatar, or null for any failure. */
  avatar(login: string, size: number, signal?: AbortSignal): Promise<GithubAvatar | null>;
  /** @internal What the avatar cache holds now. */
  avatarCache(): { entries: number; bytes: number };
}

/** The cursor of a part: a page number, and for checks which source it pages. */
function parseCursor(part: GithubDetailPart, cursor: string | null): { source: "runs" | "statuses"; page: number } {
  if (cursor === null) return { source: "runs", page: 1 };
  const match = part === "checks" ? /^(runs|statuses):([1-9][0-9]{0,3})$/.exec(cursor) : /^()([1-9][0-9]{0,3})$/.exec(cursor);
  if (!match) throw new GithubDetailInputError("cursor", "The cursor is not one this host issued.");
  return { source: match[1] === "statuses" ? "statuses" : "runs", page: Number(match[2]) };
}

function reviewComment(value: Json, scope: GithubLinkScope, fallback: string): GithubReviewComment | null {
  const id = integer(value.id);
  if (!id) return null;
  const line = integer(value.line);
  return { id, review_id: integer(value.pull_request_review_id) || null, in_reply_to_id: integer(value.in_reply_to_id) || null,
    author: author(value.user, value.author_association), path: cut(text(value.path) ?? "", 1024).text, line: line && line > 0 ? line : null,
    created_at: requiredTime(value.created_at, fallback), updated_at: requiredTime(value.updated_at, requiredTime(value.created_at, fallback)),
    ...body(value.body, GITHUB_LIMITS.commentBodyChars), html_url: githubDirectUrl(value.html_url, scope, { kind: "review_comment", id }) };
}

const FILE_STATUSES = new Set(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);
function changedFile(value: Json): GithubChangedFile | null {
  const filename = text(value.filename), status = text(value.status);
  if (!filename || !status || !FILE_STATUSES.has(status)) return null;
  const previous = text(value.previous_filename);
  return { filename: cut(filename, 1024).text, previous_filename: previous ? cut(previous, 1024).text : null, status: status as GithubChangedFile["status"],
    additions: integer(value.additions) ?? 0, deletions: integer(value.deletions) ?? 0, changes: integer(value.changes) ?? 0 };
}

const RUN_CONCLUSIONS = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]);
function checkRun(value: Json): GithubCheckRun {
  const completed = value.status === "completed";
  const conclusion = completed && RUN_CONCLUSIONS.has(String(value.conclusion)) ? value.conclusion as GithubCheckRun["conclusion"] : null;
  // The same buckets as the payload's `checks` counts.
  const state = !completed ? "running" : conclusion === "success" || conclusion === "neutral" ? "passed" : conclusion === "skipped" ? "skipped" : "failed";
  return { source: "check_run", name: cut(text(value.name) ?? "", 256).text, state, conclusion,
    started_at: time(value.started_at), completed_at: completed ? time(value.completed_at) : null };
}
function commitStatus(value: Json): GithubCheckRun {
  const raw = String(value.state);
  const conclusion = (["success", "failure", "error", "pending"] as const).find(state => state === raw) ?? null;
  const state = conclusion === "success" ? "passed" : conclusion === "pending" ? "running" : "failed";
  return { source: "status", name: cut(text(value.context) ?? "", 256).text, state, conclusion,
    started_at: time(value.created_at), completed_at: conclusion && conclusion !== "pending" ? time(value.updated_at) : null };
}

/** The image's type and size, judged by its bytes alone, or null. */
export function sniffImage(bytes: Uint8Array): { type: GithubAvatar["type"]; width: number; height: number } | null {
  const at = (index: number) => bytes[index] ?? -1;
  const be16 = (index: number) => (at(index) << 8) | at(index + 1);
  const le16 = (index: number) => at(index) | (at(index + 1) << 8);
  const be32 = (index: number) => ((at(index) << 24) >>> 0) + (at(index + 1) << 16) + (at(index + 2) << 8) + at(index + 3);
  const ascii = (index: number, value: string) => [...value].every((char, offset) => at(index + offset) === char.charCodeAt(0));
  if (bytes.length >= 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte) && ascii(12, "IHDR"))
    return { type: "image/png", width: be32(16), height: be32(20) };
  if (bytes.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return { type: "image/gif", width: le16(6), height: le16(8) };
  if (bytes.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && at(23) === 0x9d && at(24) === 0x01 && at(25) === 0x2a) return { type: "image/webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (ascii(12, "VP8L") && at(20) === 0x2f) {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(12, "VP8X")) return { type: "image/webp", width: (at(24) | (at(25) << 8) | (at(26) << 16)) + 1, height: (at(27) | (at(28) << 8) | (at(29) << 16)) + 1 };
    return null;
  }
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    // Walk the markers to the first start-of-frame, which carries the size.
    let index = 2;
    while (index + 9 < bytes.length) {
      if (at(index) !== 0xff) return null;
      const marker = at(index + 1);
      if (marker === 0xff) { index++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { index += 2; continue; }
      const length = be16(index + 2);
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { type: "image/jpeg", width: be16(index + 7), height: be16(index + 5) };
      if (marker === 0xd9 || marker === 0xda) return null;
      index += 2 + length;
    }
  }
  return null;
}

/** The whole body, or null once it passes `max` bytes. */
async function boundedBody(response: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export function createGithubDetails(options: GithubDetailsOptions): GithubDetails {
  const now = options.now ?? Date.now;
  const limits = { ...GITHUB_AVATAR_LIMITS, ...options.avatarLimits };
  const get = (token: string, path: string, signal?: AbortSignal) => githubGet(options, token, path, signal);
  /** Logins of the pages served per session: bounded, oldest session dropped first. */
  const served = new Map<string, Set<string>>();
  const avatars = new Map<string, { avatar: GithubAvatar; at: number }>();
  let cachedBytes = 0;

  function remember(sessionId: string, logins: Iterable<string>) {
    let set = served.get(sessionId);
    if (set) served.delete(sessionId);
    else set = new Set();
    served.set(sessionId, set);
    for (const login of logins) if (set.size < 2_000) set.add(login.toLowerCase());
    while (served.size > 200) served.delete(served.keys().next().value!);
  }

  const items = (json: unknown) => array(json).map(record).filter((item): item is Json => item !== null);

  async function page(sessionId: string, object: { repository: string; number: number; pullRequest: boolean | null }, part: GithubDetailPart,
    cursor: string | null, signal?: AbortSignal): Promise<GithubDetailPage> {
    const { source, page: at } = parseCursor(part, cursor);
    if (part !== "comments" && object.pullRequest === false)
      throw new GithubDetailInputError("not_pull_request", "Only a pull request has this part.");
    const token = options.token();
    if (!token) throw new GithubRefusal("unavailable", "no_credential", "This host has no GitHub credential for its GitHub tools (BRAIN_UI_GITHUB_TOOLS_TOKEN). GITHUB_TOKEN is never used for them.");
    const parsed = parseGithubRepository(object.repository)!;
    const name = `${parsed.owner}/${parsed.repo}`, scope: GithubLinkScope = { owner: parsed.owner, repo: parsed.repo, number: object.number };
    const fetchedAt = new Date(now()).toISOString();
    const size = GITHUB_DETAIL_PAGE_SIZE, query = `per_page=${size}&page=${at}`;
    const base = { kind: "detail_page" as const, repository: name, number: object.number, fetched_at: fetchedAt };
    const listed = async (path: string) => {
      const { json, response } = await get(token, `${path}?${query}`, signal);
      return { raw: items(json).slice(0, size), next: nextLink(response) ? String(at + 1) : null };
    };
    const logins = (list: Array<{ author: GithubUser | GithubAuthor | null }>) => list.flatMap(item => item.author?.login ? [item.author.login] : []);
    let result: GithubDetailPage;
    switch (part) {
      case "comments": {
        const { raw, next } = await listed(`/repos/${name}/issues/${object.number}/comments`);
        const list = raw.map(item => comment(item, scope, fetchedAt)).filter((item): item is GithubComment => item !== null);
        remember(sessionId, logins(list));
        result = { ...base, part, items: list, total_count: null, next_cursor: next };
        break;
      }
      case "reviews": {
        const { raw, next } = await listed(`/repos/${name}/pulls/${object.number}/reviews`);
        const list = raw.map(item => review(item, scope)).filter((item): item is GithubReview => item !== null);
        remember(sessionId, logins(list));
        result = { ...base, part, items: list, total_count: null, next_cursor: next };
        break;
      }
      case "review-comments": {
        const { raw, next } = await listed(`/repos/${name}/pulls/${object.number}/comments`);
        const list = raw.map(item => reviewComment(item, scope, fetchedAt)).filter((item): item is GithubReviewComment => item !== null);
        remember(sessionId, logins(list));
        result = { ...base, part, items: list, total_count: null, next_cursor: next };
        break;
      }
      case "commits": {
        const { raw, next } = await listed(`/repos/${name}/pulls/${object.number}/commits`);
        const list = raw.map(item => commit(item, scope)).filter((item): item is GithubCommit => item !== null);
        remember(sessionId, logins(list));
        result = { ...base, part, items: list, total_count: null, next_cursor: next };
        break;
      }
      case "files": {
        const { raw, next } = await listed(`/repos/${name}/pulls/${object.number}/files`);
        result = { ...base, part, items: raw.map(changedFile).filter((item): item is GithubChangedFile => item !== null), total_count: null, next_cursor: next };
        break;
      }
      case "checks": {
        const pull = record((await get(token, `/repos/${name}/pulls/${object.number}`, signal)).json);
        const sha = text(record(pull?.head)?.sha);
        if (!sha || !SHA.test(sha)) throw new GithubRefusal("upstream_error", "malformed", "GitHub returned an unexpected pull request.");
        if (source === "runs") {
          const { json, response } = await get(token, `/repos/${name}/commits/${sha}/check-runs?${query}`, signal);
          const runs = array(record(json)?.check_runs).map(record).filter((item): item is Json => item !== null).slice(0, size).map(checkRun);
          result = { ...base, part, items: runs, total_count: null, next_cursor: nextLink(response) ? `runs:${at + 1}` : "statuses:1" };
        } else {
          const status = record((await get(token, `/repos/${name}/commits/${sha}/status?${query}`, signal)).json);
          const statuses = array(status?.statuses).map(record).filter((item): item is Json => item !== null).slice(0, size).map(commitStatus);
          const total = integer(status?.total_count);
          result = { ...base, part, items: statuses, total_count: null, next_cursor: total !== null && at * size < total ? `statuses:${at + 1}` : null };
        }
        break;
      }
    }
    return result;
  }

  function drop(key: string) {
    const entry = avatars.get(key);
    if (entry) { avatars.delete(key); cachedBytes -= entry.avatar.bytes.byteLength; }
  }
  function evict() {
    const cutoff = now() - limits.ttlMs;
    for (const [key, entry] of [...avatars]) if (entry.at < cutoff) drop(key);
    // Insertion order is age: a hit re-inserts, so the first key is the least recently used.
    while (avatars.size > limits.entries || cachedBytes > limits.cacheBytes) drop(avatars.keys().next().value!);
  }

  async function avatar(login: string, size: number, signal?: AbortSignal): Promise<GithubAvatar | null> {
    if (!LOGIN.test(login)) return null;
    const fitted = GITHUB_AVATAR_SIZES.find(candidate => candidate >= size) ?? GITHUB_AVATAR_SIZES.at(-1)!;
    const key = `${login.toLowerCase()}@${fitted}`;
    const hit = avatars.get(key);
    if (hit && hit.at >= now() - limits.ttlMs) { avatars.delete(key); avatars.set(key, hit); return hit.avatar; }
    let url = new URL(`/${encodeURIComponent(login)}`, GITHUB_AVATAR_ORIGIN);
    url.search = new URLSearchParams({ size: String(fitted) }).toString();
    try {
      for (let hop = 0; hop < 3; hop++) {
        if (url.origin !== GITHUB_AVATAR_ORIGIN) return null;
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
        // No credential of any kind: no token, no cookie.
        const response = await (options.avatarFetch ?? fetch)(url, { method: "GET", redirect: "manual", credentials: "omit",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: "image/png,image/jpeg,image/gif,image/webp", "user-agent": "brain-ui" } });
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          await response.body?.cancel().catch(() => {});
          url = new URL(response.headers.get("location")!, url);
          continue;
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
        const bytes = await boundedBody(response, limits.bytes);
        if (!bytes) return null;
        // The upstream content type is not believed: the bytes decide.
        const image = sniffImage(bytes);
        if (!image || image.width < 1 || image.height < 1 || image.width > limits.pixels || image.height > limits.pixels) return null;
        const result: GithubAvatar = { bytes, type: image.type };
        drop(key);
        avatars.set(key, { avatar: result, at: now() });
        cachedBytes += bytes.byteLength;
        evict();
        return result;
      }
      return null;
    } catch {
      return null;
    }
  }

  return {
    page,
    servedLogin: (sessionId, login) => served.get(sessionId)?.has(login.toLowerCase()) ?? false,
    avatar,
    avatarCache: () => ({ entries: avatars.size, bytes: cachedBytes }),
  };
}
