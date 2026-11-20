/**
 * The host GitHub API relay for module cron jobs (#4259).
 *
 * A scheduled module job runs in a maintenance worker with no credential and
 * no network. A job whose repositories the host granted (the module's
 * `repositories` ∩ `BRAIN_UI_MODULE_REPOSITORIES`, the same grant as its read
 * mirror) also gets this per-run relay: a Unix socket in a private directory
 * the launcher binds read-only into that one worker. The job sends ordinary
 * GitHub API requests to the socket; the relay:
 *
 * - forwards only to `https://api.github.com`, never a redirect, with the host
 *   credential `BRAIN_UI_MODULE_GITHUB_TOKEN` and no other token;
 * - reads: REST `GET /repos/<owner>/<repo>/…` for a granted repository, and
 *   GraphQL queries (never a mutation or subscription) whose only root field
 *   is `repository(owner:, name:)` naming a granted repository;
 * - writes: only an operation the operator enabled for that repository in
 *   `BRAIN_UI_MODULE_GITHUB_WRITES`: `issue_comment`
 *   (`POST /repos/<r>/issues/<n>/comments`, `{ body }`) and `issue_state`
 *   (`PATCH /repos/<r>/issues/<n>`, `{ state, state_reason? }`);
 * - refuses everything else before any request leaves the host, with a
 *   message naming the setting, and bounds request size, response size and
 *   calls per run. It reports each write, never the token.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerIdentityHelper } from "@schlessera/brain-ui-sdk/internal";
import { GITHUB_API_ORIGIN } from "@schlessera/brain-ui-sdk/tool-contracts";

/** The relay's socket name in its private directory. */
const MODULE_GITHUB_RELAY_SOCKET_NAME = "github.sock";
/** The write operations an operator can enable per repository. */
const MODULE_GITHUB_WRITES = ["issue_comment", "issue_state"] as const;
export type ModuleGitHubWrite = (typeof MODULE_GITHUB_WRITES)[number];
/** A request body larger than this is refused before it is forwarded. */
const MAX_MODULE_GITHUB_REQUEST_BYTES = 1024 * 1024;
/** A response larger than this is refused rather than relayed. */
const MAX_MODULE_GITHUB_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Calls one run may make through the relay. */
const MAX_MODULE_GITHUB_CALLS = 500;
/** Calls in flight at once, so request and response buffers bound the runner's memory too. */
const MAX_MODULE_GITHUB_CONCURRENT = 8;
const RESPONSE_HEADERS = ["content-type", "link", "etag", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-github-request-id"];
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** One write the relay forwarded, for the job's Activity run. */
export interface ModuleGitHubWriteRecord { repository: string; operation: ModuleGitHubWrite; number: number; status: number }

export interface ModuleGitHubRelayOptions {
  /** The host credential, read at the edge; absent refuses every call. */
  token: () => string | undefined;
  /** Granted repositories as `owner/repo`. */
  repositories: readonly string[];
  /** Operator-enabled writes per granted `owner/repo`. */
  writes: ReadonlyMap<string, ReadonlySet<ModuleGitHubWrite>>;
  observe?: (write: ModuleGitHubWriteRecord) => void;
  /** @internal Test seams. */
  fetch?: typeof fetch; origin?: string; maxCalls?: number; maxResponseBytes?: number; maxConcurrent?: number;
}

export interface ModuleGitHubRelay { dir: string; socketPath: string; stop(): Promise<void> }

const lower = (repository: string) => repository.toLowerCase();

/** `owner/repo` of a granted GitHub repository URL, or null for any other host. */
export function githubRepositoryOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.username || parsed.password) return null;
    const parts = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
    return parts.length === 2 && parts.every(part => NAME.test(part)) ? `${parts[0]}/${parts[1]}` : null;
  } catch { return null; }
}

/**
 * The operator's write list: entries `<https://github.com/owner/repo>#<operation>`,
 * comma or whitespace separated. An unknown operation or a non-GitHub URL is
 * reported invalid and enables nothing.
 */
export function parseModuleGitHubWrites(raw: string | undefined): { writes: Map<string, Set<ModuleGitHubWrite>>; invalid: string[] } {
  const writes = new Map<string, Set<ModuleGitHubWrite>>(), invalid: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const hash = entry.lastIndexOf("#");
    const repository = hash > 0 ? githubRepositoryOf(entry.slice(0, hash)) : null;
    const operation = entry.slice(hash + 1) as ModuleGitHubWrite;
    if (!repository || !MODULE_GITHUB_WRITES.includes(operation)) { invalid.push(entry); continue; }
    const key = lower(repository);
    writes.set(key, (writes.get(key) ?? new Set()).add(operation));
  }
  return { writes, invalid };
}

class Refusal extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const refuse = (status: number, code: string, message: string): never => { throw new Refusal(status, code, message); };

/** GraphQL text with strings, block strings and comments blanked, so structure can be read. */
function graphqlStructure(query: string): string {
  return query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, match => " ".repeat(match.length));
}

/**
 * The repository a query reads, when it is one query operation whose only root
 * selection is `repository(owner:, name:)`; null otherwise. Arguments are
 * string literals or `$variables` resolved from `variables`.
 */
export function graphqlQueryRepository(query: string, variables: unknown, operationName?: unknown): string | null {
  // A strict subset, so this reader and GitHub's parser cannot disagree about
  // where a string or comment ends: no comments, block strings, escapes,
  // carriage returns or other control characters.
  if (/[#\\\r]|"""|[\u0000-\u0008\u000b-\u001f\u007f]/.test(query)) return null;
  const text = graphqlStructure(query);
  // Top-level definitions: exactly one operation, and it is a query (or the `{ … }` shorthand).
  let depth = 0, operations = 0, start = -1, end = -1, header = "";
  let buffer = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "{") { if (depth === 0) { operations++; start = i; header = buffer.trim(); buffer = ""; } depth++; }
    else if (char === "}") { depth--; if (depth < 0) return null; if (depth === 0) end = i; }
    else if (depth === 0) buffer += char;
  }
  if (depth !== 0 || operations !== 1 || buffer.trim() || start < 0 || end < 0) return null;
  const operation = /^query(?:\s+([_A-Za-z][_0-9A-Za-z]*))?\s*(?:\([^)]*\))?$/.exec(header);
  if (header && !operation) return null;
  // GitHub runs the operation `operationName` names: it must be this one.
  if (operationName !== undefined && operationName !== null && operationName !== operation?.[1]) return null;
  // The root selection set: one field, `repository`, with no alias, spread or directive.
  const root = text.slice(start + 1, end);
  let inner = 0, fields = "";
  for (const char of root) {
    if (char === "{" || char === "(") inner++;
    if (inner === 0) fields += char;
    if (char === "}" || char === ")") inner--;
  }
  if (!/^\s*repository\s*$/.test(fields)) return null;
  // Below the root, no field may reach another repository, owner or the
  // account: the grant names repositories, not what the token can traverse to.
  if (selectedFields(root.slice(root.indexOf("repository") + "repository".length)).some(name => CROSS_REPOSITORY_FIELDS.has(name))) return null;
  const open = root.indexOf("("), close = root.indexOf(")");
  if (!/^\s*repository\s*$/.test(root.slice(0, open)) || open < 0 || close < open) return null;
  // The argument text itself, from the original query (blanking keeps every offset).
  const args = query.slice(start + 1, end).slice(open + 1, close);
  const values = variables && typeof variables === "object" && !Array.isArray(variables) ? variables as Record<string, unknown> : {};
  // GraphQL commas are optional: the arguments are exactly two `name: value`
  // pairs, separated by whitespace and/or commas, with nothing else between.
  const pair = /([_A-Za-z][_0-9A-Za-z]*)\s*:\s*(\$[_A-Za-z][_0-9A-Za-z]*|"[^"\\]*")/g;
  const pairs = [...args.matchAll(pair)];
  if (pairs.length !== 2 || args.replace(pair, "").replace(/[\s,]/g, "") !== "") return null;
  const parsed = new Map<string, string>();
  for (const match of pairs) {
    const value = match[2]!.startsWith("$") ? values[match[2]!.slice(1)] : match[2]!.slice(1, -1);
    if (typeof value !== "string" || !NAME.test(value)) return null;
    parsed.set(match[1]!, value);
  }
  const owner = parsed.get("owner"), name = parsed.get("name");
  return owner && name ? `${owner}/${name}` : null;
}

/**
 * Fields that select another repository, owner or account by name, wherever
 * they appear below the granted root. Not every traversal GitHub's schema
 * offers: the token's own scope bounds the rest (docs/modules.md).
 */
const CROSS_REPOSITORY_FIELDS = new Set(["repository", "repositories", "repositoryOwner", "owner", "organization", "organizations", "user", "viewer",
  "forks", "parent", "templateRepository", "headRepository", "baseRepository", "headRepositoryOwner", "search", "resource",
  "enterprise", "sponsorable", "pinnedItems", "starredRepositories", "watching", "repositoriesContributedTo", "topRepositories", "gists"]);

/**
 * Every selected field name in GraphQL selection text whose strings are
 * blanked: identifiers outside argument lists that are not alias or argument
 * names (`name:`), variables, fragment spreads or directives.
 */
function selectedFields(text: string): string[] {
  const names: string[] = [];
  let args = 0;
  const token = /\$?[_A-Za-z][_0-9A-Za-z]*|\.\.\.|@|[(){}:]/g;
  const tokens = [...text.matchAll(token)].map(match => match[0]);
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i]!;
    if (current === "(") { args++; continue; }
    if (current === ")") { args--; continue; }
    if (args > 0 || current.startsWith("$") || /^[(){}:@]$|^\.\.\.$/.test(current)) continue;
    if (tokens[i - 1] === "@" || tokens[i - 1] === "...") continue;
    if (tokens[i + 1] === ":") continue;
    names.push(current);
  }
  return names;
}

/** A stream's bytes, read chunk by chunk and abandoned as soon as they pass `limit`: never held past the bound. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function boundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_MODULE_GITHUB_REQUEST_BYTES) refuse(413, "too_large", `A relayed request body is at most ${MAX_MODULE_GITHUB_REQUEST_BYTES} bytes.`);
  const bytes = await readBounded(request.body, MAX_MODULE_GITHUB_REQUEST_BYTES);
  if (!bytes) refuse(413, "too_large", `A relayed request body is at most ${MAX_MODULE_GITHUB_REQUEST_BYTES} bytes.`);
  return new TextDecoder().decode(bytes!);
}

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse(400, "invalid_body", "The relayed request body must be a JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(400, "invalid_body", "The relayed request body must be a JSON object.");
  return value as Record<string, unknown>;
}

export function startModuleGitHubRelay(options: ModuleGitHubRelayOptions): ModuleGitHubRelay {
  const origin = options.origin ?? GITHUB_API_ORIGIN;
  const granted = new Map(options.repositories.map(repository => [lower(repository), repository]));
  const maxCalls = options.maxCalls ?? MAX_MODULE_GITHUB_CALLS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_MODULE_GITHUB_RESPONSE_BYTES;
  const maxConcurrent = options.maxConcurrent ?? MAX_MODULE_GITHUB_CONCURRENT;
  let calls = 0;
  // Private to this server user; the one worker of this run sees only the bound socket.
  const dir = mkdtempSync(join(tmpdir(), "brain-module-github-"));
  const separateIdentity = Boolean(workerIdentityHelper());
  chmodSync(dir, separateIdentity ? 0o750 : 0o700);
  const socketPath = join(dir, MODULE_GITHUB_RELAY_SOCKET_NAME);
  const repositoryOf = (owner: string, name: string): string => {
    const key = lower(`${owner}/${name}`);
    if (!granted.has(key)) refuse(403, "repository_not_granted", `${owner}/${name} is not granted to this job: list it in the module's repositories and in BRAIN_UI_MODULE_REPOSITORIES.`);
    return key;
  };
  const writeAllowed = (repository: string, operation: ModuleGitHubWrite) => {
    if (!options.writes.get(repository)?.has(operation))
      refuse(403, "write_not_enabled", `${operation} on ${granted.get(repository)} is not enabled: add https://github.com/${granted.get(repository)}#${operation} to BRAIN_UI_MODULE_GITHUB_WRITES.`);
  };

  /** A path segment, decoded; a malformed escape is refused as an invalid path, never mistaken for an upstream failure. */
  const segment = (raw: string): string => {
    try { return decodeURIComponent(raw); }
    catch { return refuse(400, "invalid_path", "The relayed path has a malformed escape: reads are GET under a /repos/<owner>/<repo>/ granted through BRAIN_UI_MODULE_REPOSITORIES."); }
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    if (path.split("/").some(part => part === "." || part === "..") || path.includes("//")) refuse(400, "invalid_path", "The relayed path is not a plain GitHub API path.");
    let body: string | undefined;
    let write: { repository: string; operation: ModuleGitHubWrite; number: number } | undefined;
    const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (method === "GET" && repo) {
      repositoryOf(segment(repo[1]!), segment(repo[2]!));
    } else if (method === "POST" && path === "/graphql" && !url.search) {
      body = await boundedBody(request);
      const value = jsonObject(body);
      if (typeof value.query !== "string" || Object.keys(value).some(key => !["query", "variables", "operationName"].includes(key)))
        refuse(400, "invalid_body", "A relayed GraphQL request is { query, variables?, operationName? }.");
      const target = graphqlQueryRepository(value.query as string, value.variables, value.operationName);
      if (!target) refuse(403, "graphql_not_allowed", "Only one GraphQL query whose one root field is repository(owner:, name:), without comments, block strings or escapes, is relayed; mutations and other roots are refused. The repository must be granted through the module's repositories and BRAIN_UI_MODULE_REPOSITORIES.");
      repositoryOf(...(target!.split("/") as [string, string]));
    } else if (method === "POST" && repo && /^\/issues\/[1-9][0-9]{0,9}\/comments$/.test(repo[3] ?? "") && !url.search) {
      const repository = repositoryOf(segment(repo[1]!), segment(repo[2]!));
      writeAllowed(repository, "issue_comment");
      body = await boundedBody(request);
      const value = jsonObject(body);
      if (typeof value.body !== "string" || !value.body.trim() || Object.keys(value).length !== 1) refuse(400, "invalid_body", "An issue comment is { body } with nonempty text.");
      write = { repository, operation: "issue_comment", number: Number(repo[3]!.split("/")[2]) };
    } else if (method === "PATCH" && repo && /^\/issues\/[1-9][0-9]{0,9}$/.test(repo[3] ?? "") && !url.search) {
      const repository = repositoryOf(segment(repo[1]!), segment(repo[2]!));
      writeAllowed(repository, "issue_state");
      body = await boundedBody(request);
      const value = jsonObject(body);
      const keys = Object.keys(value);
      if (!["open", "closed"].includes(value.state as string) || keys.some(key => key !== "state" && key !== "state_reason")
        || (value.state_reason !== undefined && !["completed", "not_planned", "reopened", null].includes(value.state_reason as string | null)))
        refuse(400, "invalid_body", "An issue state change is { state: open|closed, state_reason? } and nothing else.");
      write = { repository, operation: "issue_state", number: Number(repo[3]!.split("/")[2]) };
    } else {
      refuse(403, "not_relayed", `${method} ${path} is not relayed: reads are GET under a /repos/<owner>/<repo>/ granted through BRAIN_UI_MODULE_REPOSITORIES, or a repository GraphQL query; the only writes are issue_comment and issue_state, enabled in BRAIN_UI_MODULE_GITHUB_WRITES.`);
    }
    const token = options.token();
    if (!token) refuse(503, "unavailable", "The module GitHub relay has no credential: set BRAIN_UI_MODULE_GITHUB_TOKEN on the host.");
    if (++calls > maxCalls) refuse(429, "budget_exceeded", `This run made its ${maxCalls} relayed GitHub calls.`);
    const upstream = await (options.fetch ?? fetch)(new URL(`${path}${url.search}`, origin), {
      method, redirect: "manual", ...(body !== undefined ? { body } : {}),
      headers: { authorization: `Bearer ${token}`, accept: request.headers.get("accept")?.startsWith("application/vnd.github") ? request.headers.get("accept")! : "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "user-agent": "brain-ui-module", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    });
    // GitHub has answered: a write it may have performed is recorded now, whatever happens to its body.
    if (write) { try { options.observe?.({ ...write, repository: granted.get(write.repository)!, status: upstream.status }); } catch { /* Recording never fails the call. */ } }
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); refuse(502, "redirect", "GitHub redirected; the relay never follows a redirect."); }
    if (Number(upstream.headers.get("content-length") ?? "0") > maxResponseBytes) { await upstream.body?.cancel(); refuse(502, "response_too_large", `A relayed response is at most ${MAX_MODULE_GITHUB_RESPONSE_BYTES} bytes.`); }
    const bytes = await readBounded(upstream.body, maxResponseBytes);
    if (!bytes) refuse(502, "response_too_large", `A relayed response is at most ${MAX_MODULE_GITHUB_RESPONSE_BYTES} bytes.`);
    const headers = new Headers();
    for (const name of RESPONSE_HEADERS) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
    return new Response(Buffer.from(bytes!), { status: upstream.status, headers });
  }

  let active = 0;
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      // Refused before any byte is read: at most this many requests are held at once.
      if (active >= maxConcurrent) {
        return Response.json({ message: `The module GitHub relay serves at most ${maxConcurrent} calls at once; retry after one finishes.`, brain_relay_refusal: "relay_busy" }, { status: 503 });
      }
      active++;
      try { return await handle(request); }
      catch (error) {
        if (error instanceof Refusal) return Response.json({ message: error.message, brain_relay_refusal: error.code }, { status: error.status });
        return Response.json({ message: "The module GitHub relay could not reach GitHub.", brain_relay_refusal: "upstream_unreachable" }, { status: 502 });
      } finally { active--; }
    },
  });
  chmodSync(socketPath, separateIdentity ? 0o660 : 0o600);
  let stopping: Promise<void> | undefined;
  return {
    dir, socketPath,
    stop() {
      return stopping ??= (async () => {
        await server.stop(true);
        rmSync(dir, { recursive: true, force: true });
      })();
    },
  };
}
