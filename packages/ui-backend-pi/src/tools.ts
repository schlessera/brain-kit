import { z } from "zod";
import { createHash } from "node:crypto";
import { brainApplicationInput, BRAIN_APPLICATION_TOOLS, BRAIN_APPLICATION_DESCRIPTIONS, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { toPiParameters } from "./bridge-tools.js";
/**
 * The curated brain tool surface for the pi backend.
 *
 * Instead of pi's built-in read/bash/edit/write (disabled via
 * `noTools: "builtin"`), the agent gets a brain-repo-scoped set mirroring
 * what the Claude backend exposes:
 *
 *   read_file, grep — repo-scoped file access
 *   brain_search, brain_context, brain_read, brain_list, brain_graph —
 *     read paths of the brain MCP surface, in-process
 *   write_file, edit_file, bash, brain_add, brain_update, brain_archive —
 *     mutating; serialized under the shared write lock
 *   ask_user, get_current_location, query_activity, request_image_mask —
 *     bridge-backed interactive tools (registered per host capability)
 *
 * PERMISSIONS ARE NOT DECIDED HERE. The tool_call gate (permission-gate.ts)
 * fires before every tool execution — curated AND extension-registered — and
 * implements the same policy as the Claude backend: everything on the
 * allowlist runs without a round-trip, destructive bash shapes and
 * non-allowlisted tools raise an approval card. A denial surfaces as an
 * error tool result fed back to the model, so it never crashes the turn.
 * File tools use @schlessera/brain's safeResolve for repo containment; bash
 * is pinned to the repo cwd.
 */

import { spawn } from "bun";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Type } from "typebox";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KeyedLock, KeyedLockAcquireOptions, WriteLock } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { killWrapped } from "@schlessera/brain-ui-sdk/server";
import { execWrapperSpawnOptions } from "@schlessera/brain-ui-sdk/internal";
import {
  BRIDGE_TOOL_POSTURE,
  bashLockKey,
  BRAIN_LOCK_KEY,
  rtkRewriteCommand,
  wrapCommand,
} from "@schlessera/brain-ui-sdk/server";

import { isIsoDate, readDocumentPart, SEARCH_SORTS, type SearchOptions } from "@schlessera/brain/internal";

import { createPiBridgeTools } from "./bridge-tools.js";
import {
  resolveEnabledWebSearchEnvNames,
  resolveExecConfig,
  subprocessEnv,
} from "./config/env.js";
import type { BrainAccess } from "./brain-access.js";
import type { TurnContext } from "./turn-context.js";

/** Risk class — documentation of which tools can mutate the working tree. */
export type RiskClass = "read" | "mutate";

const MAX_READ_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 30_000;

/** Result helper: pi tools return content parts + arbitrary details. */
interface BrainSearchParams {
  query: string;
  type?: string;
  tag?: string;
  limit?: number;
  updated_since?: string;
  updated_before?: string;
  deadline_from?: string;
  deadline_to?: string;
  sort?: SearchOptions["sort"];
  upcoming?: boolean;
}

function textResult(text: string, details: unknown = null) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * The longest JSON a listing or a graph returns: the budget text output is
 * clipped at. JSON is never clipped as text, which would not parse; it is
 * cut by structure instead, whole rows or whole edges at a time.
 */
const MAX_JSON_CHARS = MAX_OUTPUT_BYTES;

/** Width of the largest omission count, so the reserved size is never short. */
const COUNT_PLACEHOLDER = Number.MAX_SAFE_INTEGER;

/**
 * A listing within MAX_JSON_CHARS: the rows in order while they fit, then
 * `truncated: true` and how many rows were left out.
 */
function fitListing<T>(documents: T[]): { documents: T[]; truncated?: true; omitted?: number } {
  const whole = { documents };
  if (JSON.stringify(whole).length <= MAX_JSON_CHARS) return whole;
  let size = JSON.stringify({ documents: [], truncated: true, omitted: COUNT_PLACEHOLDER }).length;
  const kept: T[] = [];
  for (const doc of documents) {
    const cost = JSON.stringify(doc).length + (kept.length > 0 ? 1 : 0);
    if (size + cost > MAX_JSON_CHARS) break;
    kept.push(doc);
    size += cost;
  }
  return { documents: kept, truncated: true, omitted: documents.length - kept.length };
}

/**
 * A graph within MAX_JSON_CHARS: edges in walk order while they and the
 * nodes of their endpoints fit, then `truncated: true` and how many edges
 * were left out. Every returned edge keeps its endpoint nodes; nodes stay in
 * path order.
 */
function fitGraph<E extends { source: string; target: string; resolved: boolean }, N extends { path: string }>(
  edges: E[],
  nodes: N[]
): { edges: E[]; nodes: N[]; truncated?: true; omitted_edges?: number } {
  const whole = { edges, nodes };
  if (JSON.stringify(whole).length <= MAX_JSON_CHARS) return whole;
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  let size = JSON.stringify({ edges: [], nodes: [], truncated: true, omitted_edges: COUNT_PLACEHOLDER }).length;
  const kept: E[] = [];
  const keptNodes = new Set<string>();
  for (const edge of edges) {
    const fresh = [edge.source, ...(edge.resolved ? [edge.target] : [])].filter(
      (p, i, all) => !keptNodes.has(p) && byPath.has(p) && all.indexOf(p) === i
    );
    let cost = JSON.stringify(edge).length + (kept.length > 0 ? 1 : 0);
    for (const path of fresh) cost += JSON.stringify(byPath.get(path)).length + (keptNodes.size > 0 || path !== fresh[0] ? 1 : 0);
    if (size + cost > MAX_JSON_CHARS) break;
    kept.push(edge);
    for (const path of fresh) keptNodes.add(path);
    size += cost;
  }
  return {
    edges: kept,
    nodes: nodes.filter((n) => keptNodes.has(n.path)),
    truncated: true,
    omitted_edges: edges.length - kept.length,
  };
}

function clip(text: string, max = MAX_OUTPUT_BYTES): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} bytes]`;
}

/**
 * The serialization seam the tools run their mutating bodies through. `key`
 * partitions contention (see ui-sdk's lock-keys); null means "no contention
 * class — run immediately". One instance is shared by every per-session
 * toolset (see backend.ts).
 */
export interface ToolLock {
  withKey<T>(key: string | null, fn: () => Promise<T> | T, admission?: KeyedLockAcquireOptions): Promise<T>;
}

/**
 * Keyed partitioning (the default): same-key calls serialize FIFO, different
 * keys — and key-less calls — run concurrently. This is what lets parallel
 * sibling tool calls actually BE parallel.
 */
export function toolLockFromKeyed(keyed: KeyedLock): ToolLock {
  return {
    withKey(key, fn, admission) {
      if (admission?.signal?.aborted) return Promise.reject(new DOMException("Tool cancelled", "AbortError"));
      return key === null ? Promise.resolve(fn()) : keyed.withLock(key, fn, admission);
    },
  };
}

/**
 * Legacy whole-lock semantics for an injected WriteLock: EVERY mutating body
 * serializes on the one mutex, key or no key — exactly the pre-keyed
 * behavior a deployment sharing a lock with another writer opted into.
 */
export function toolLockFromWriteLock(writeLock: WriteLock): ToolLock {
  const keyed = createKeyedLock();
  return {
    withKey(key, fn, admission) {
      const body = () => writeLock.withLock(() => {
        if (admission?.signal?.aborted) throw new DOMException("Tool cancelled", "AbortError");
        return fn();
      });
      return keyed.withLock(key ?? "legacy-keyless", body, admission);
    },
  };
}

export interface BrainToolDeps {
  brain: BrainAccess;
  turn: TurnContext;
  /**
   * Serializes MUTATING tool executions that contend on the same resource
   * across all sessions of this backend. Read-class tools never take it.
   */
  lock: ToolLock;
  /**
   * Which bridge-backed tools to register, mirroring the host's
   * BackendBridge capability surface. Absent = ask_user only (it degrades at
   * execute time when the host lacks it).
   */
  capabilities?: {
    location?: boolean;
    activity?: boolean;
    mask?: boolean;
  };
}

/** Static risk-class table (also documented in the package README). */
export const TOOL_RISK: Record<string, RiskClass> = {
  brain_read_base: "read",
  apply_staged_changes: "mutate",
  read_file: "read",
  grep: "read",
  brain_search: "read",
  brain_context: "read",
  brain_read: "read",
  brain_list: "read",
  brain_graph: "read",
  ask_user: "read",
  ask_user_list: "read",
  ask_user_rank: "read",
  ask_user_form: "read",
  get_current_location: "read",
  query_activity: "read",
  // Echoes the block it was given; the surface draws it. Touches nothing.
  show_block: "read",
  // Writes a mask PNG next to its image, but the approval is the mask editor
  // itself — nothing happens unless the user paints and confirms.
  request_image_mask: "mutate",
  write_file: "mutate",
  edit_file: "mutate",
  bash: "mutate",
  brain_add: "mutate",
  brain_update: "mutate",
  brain_archive: "mutate",
};

/**
 * Tools that run WITHOUT an approval card, mirroring the Claude backend's
 * DEFAULT_ALLOWED_TOOLS posture: every curated tool is auto-allowed except
 * `brain_archive` (a visibility change — see the shared confirm-pattern
 * rationale), and destructive bash shapes still confirm via
 * DEFAULT_CONFIRM_BASH_PATTERNS inside the tool_call gate.
 *
 * The well-known extension tools are listed here too so the recommended
 * extensions (pi-web-access) run prompt-free like Claude's WebSearch /
 * WebFetch; any OTHER extension-registered tool (e.g. a third-party MCP
 * server through pi-mcp-adapter) raises an approval card, exactly like a
 * non-allowlisted MCP tool does on the Claude backend.
 */
export const DEFAULT_PI_ALLOWED_TOOLS: readonly string[] = [
  "read_file",
  "grep",
  "brain_search",
  "brain_context",
  "brain_read",
  "brain_list",
  "brain_graph",
  "brain_add",
  "brain_update",
  "write_file",
  "edit_file",
  "bash",
  ...BRIDGE_TOOL_POSTURE.allowedTools("pi"),
  // pi-web-access (recommended web extension) — parity with Claude's
  // auto-allowed WebSearch/WebFetch.
  "web_search",
  "fetch_content",
  // pi-subagents (recommended fan-out extension) — parity with Claude's
  // auto-allowed Agent tool. NOTE: a child agent's own tool calls run inside
  // pi's child session with that agent's declared tools, NOT through this
  // backend's gate — same trust domain as Claude's subagents, minus the
  // bash confirm patterns. Delegation itself is the reviewed act.
  "subagent",
];

/**
 * Name of the document update tool. Auto-allowed above, and gated on one
 * input shape (`status: "archived"`) by the permission gate — the two must
 * agree, so they read the same constant.
 */
export const PI_BRAIN_UPDATE_TOOL_NAME = "brain_update";

/** Name of pi's tappable-choice tool — also stated in the agent surface brief. */
export const PI_ASK_USER_TOOL_NAME = BRIDGE_TOOL_POSTURE.names[0];

export function createBrainTools(deps: BrainToolDeps): ToolDefinition[] {
  const { brain, turn, capabilities } = deps;
  const lock: ToolLock = {
    withKey: (key, body) => {
      const pending = turn.pendingMutations;
      const work = deps.lock.withKey(key, body, {
        signal: turn.signal ?? undefined,
        priority: turn.autonomous ? "autonomous" : "interactive",
        onYield: turn.autonomous?.onYield,
        yieldAfterMs: turn.autonomous?.yieldAfterMs,
        timeoutMs: 30_000,
      });
      pending?.add(work);
      void work.then(() => pending?.delete(work), () => pending?.delete(work));
      return work;
    },
  };

  const resolveOrThrow = (rel: string): string => {
    const abs = brain.resolveInRepo(rel);
    if (!abs) {
      throw new Error(
        `Path "${rel}" escapes the brain repository and was refused.`
      );
    }
    return abs;
  };

  const bases = new WeakMap<BackendBridge, Map<string, string>>();
  const rememberBase = (path: string, raw: string): string => {
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    if (turn.bridge?.applyBrain) {
      let entries = bases.get(turn.bridge);
      if (!entries) { entries = new Map(); bases.set(turn.bridge, entries); }
      entries.set(path, hash);
    }
    return hash;
  };
  const read_file = {
    name: "read_file",
    label: "Read file",
    description:
      "Read a UTF-8 text file from the brain repository. Path is relative to the repo root.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
    }),
    async execute(_id: string, params: { path: string }) {
      const abs = resolveOrThrow(params.path);
      const raw = readFileSync(abs, "utf-8");
      const hash = rememberBase(params.path, raw);
      return textResult(clip(raw, MAX_READ_BYTES), { path: params.path, ...(turn.bridge?.applyBrain ? { expectedBaseHash: hash } : {}) });
    },
  } satisfies ToolDefinition;

  const grep = {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents in the brain repository with a regular expression. " +
      "Returns matching lines as `path:line: text`.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search for." }),
      path: Type.Optional(
        Type.String({ description: "Repo-relative subtree to search (default: whole repo)." })
      ),
    }),
    async execute(_id: string, params: { pattern: string; path?: string }, signal?: AbortSignal) {
      // Containment: scope the search path to the repo; grep runs with cwd=repo.
      const rel = params.path ?? ".";
      resolveOrThrow(rel);
      const exec = resolveExecConfig();
      const proc = spawn(wrapCommand(["grep", "-rInE", "--", params.pattern, rel], exec.wrapper), {
        cwd: brain.root,
        env: subprocessEnv(resolveEnabledWebSearchEnvNames()),
        stdout: "pipe",
        stderr: "pipe",
        ...execWrapperSpawnOptions(exec.wrapper),
      });
      const onAbort = () => killWrapped(proc, exec);
      signal?.addEventListener("abort", onAbort, { once: true });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      signal?.removeEventListener("abort", onAbort);
      const text = out.trim();
      return textResult(text ? clip(text) : "No matches.", { pattern: params.pattern });
    },
  } satisfies ToolDefinition;

  const brain_search = {
    name: "brain_search",
    label: "Search brain",
    description:
      "Hybrid (full-text + vector) search across the knowledge base. Prefer this " +
      "over grep for finding notes by meaning. Returns ranked results with snippets. " +
      "For questions about time (\"what is due next\", \"what changed this week\"), turn the " +
      "dates into the date filters yourself (YYYY-MM-DD, inclusive) and pick a sort; " +
      "upcoming is a shortcut for deadline_from today, sort deadline.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or keyword query." }),
      type: Type.Optional(Type.String({ description: "Filter by document type." })),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
      updated_since: Type.Optional(Type.String({ description: "Only documents updated on or after this date (YYYY-MM-DD)." })),
      updated_before: Type.Optional(Type.String({ description: "Only documents updated on or before this date (YYYY-MM-DD)." })),
      deadline_from: Type.Optional(Type.String({ description: "Only documents with a deadline on or after this date (YYYY-MM-DD)." })),
      deadline_to: Type.Optional(Type.String({ description: "Only documents with a deadline on or before this date (YYYY-MM-DD)." })),
      sort: Type.Optional(
        Type.Union(SEARCH_SORTS.map((s) => Type.Literal(s)), {
          description: "Result order: score (default), updated (newest first) or deadline (earliest first, undated last).",
        })
      ),
      upcoming: Type.Optional(
        Type.Boolean({ description: "Same as deadline_from today and sort deadline; an explicit deadline_from or sort wins." })
      ),
    }),
    async execute(_id: string, params: BrainSearchParams) {
      // Core also refuses a bad date or sort; checking the dates here names the
      // input the model sent (deadline_from, not deadlineFrom).
      for (const key of ["updated_since", "updated_before", "deadline_from", "deadline_to"] as const) {
        const value = params[key];
        if (value !== undefined && (typeof value !== "string" || !isIsoDate(value))) {
          throw new Error(`${key} must be a date written YYYY-MM-DD, got ${JSON.stringify(value)}`);
        }
      }
      const { results, warnings } = await brain.search({
        query: params.query,
        type: params.type,
        tag: params.tag,
        limit: params.limit ?? 10,
        updatedSince: params.updated_since,
        updatedBefore: params.updated_before,
        deadlineFrom: params.deadline_from ?? (params.upcoming ? new Date().toISOString().slice(0, 10) : undefined),
        deadlineTo: params.deadline_to,
        sort: params.sort ?? (params.upcoming ? "deadline" : undefined),
      });
      const lines: string[] = [];
      for (const w of warnings) lines.push(`> ${w}`);
      if (results.length === 0) lines.push("No results found.");
      for (const r of results) {
        lines.push(
          `- ${r.path} — ${r.title} [${r.type}]` +
            (r.snippet ? `\n    ${r.snippet}` : "")
        );
      }
      return textResult(clip(lines.join("\n")), { count: results.length });
    },
  } satisfies ToolDefinition;

  const brain_context = {
    name: "brain_context",
    label: "Assemble context",
    description:
      "Assemble a token-limited markdown context block of the most relevant notes " +
      "for a query. Use to ground an answer in the knowledge base.",
    parameters: Type.Object({
      query: Type.String({ description: "What to gather context about." }),
      maxTokens: Type.Optional(Type.Number({ description: "Token budget (default 4000)." })),
    }),
    async execute(_id: string, params: { query: string; maxTokens?: number }) {
      const block = await brain.context(params.query, params.maxTokens ?? 4000);
      return textResult(block || "No relevant context found.", { query: params.query });
    },
  } satisfies ToolDefinition;

  const write_file = {
    name: "write_file",
    label: "Write file",
    description:
      "Create or overwrite a UTF-8 text file in the brain repository. Path is relative to the repo root.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
      content: Type.String({ description: "Full file contents to write." }),
    }),
    async execute(_id: string, params: { path: string; content: string }) {
      // Per-path lock: writes to the same file serialize, different files run
      // in parallel. Approval (when the gate requires one) already happened
      // in the tool_call event.
      const abs = resolveOrThrow(params.path);
      return lock.withKey(`path:${abs}`, () => {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, params.content, "utf-8");
        return textResult(`Wrote ${params.content.length} bytes to ${params.path}.`, {
          path: params.path,
        });
      });
    },
  } satisfies ToolDefinition;

  const edit_file = {
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact, unique string in a brain-repo file. old_string must occur exactly once.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
      old_string: Type.String({ description: "Exact text to replace (must be unique)." }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    async execute(
      _id: string,
      params: { path: string; old_string: string; new_string: string }
    ) {
      // Read-modify-write is atomic under the file's own lock key.
      const abs = resolveOrThrow(params.path);
      return lock.withKey(`path:${abs}`, () => {
        const raw = readFileSync(abs, "utf-8");
        const occurrences = raw.split(params.old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${params.path}.`);
        if (occurrences > 1) {
          throw new Error(
            `old_string is not unique in ${params.path} (${occurrences} matches); add more context.`
          );
        }
        writeFileSync(abs, raw.replace(params.old_string, params.new_string), "utf-8");
        return textResult(`Edited ${params.path}.`, { path: params.path });
      });
    },
  } satisfies ToolDefinition;

  const bash = {
    name: "bash",
    label: "Run bash",
    description:
      "Run a bash command in the brain repository root. Combined stdout+stderr is " +
      "returned. Destructive command shapes (recursive delete, history rewrites, " +
      "brain archive) raise a confirmation card before running.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command line to execute." }),
    }),
    async execute(_id: string, params: { command: string }, signal?: AbortSignal) {
      signal = signal && turn.signal ? AbortSignal.any([signal, turn.signal]) : signal ?? turn.signal ?? undefined;
      // The tool_call gate has already confirmed a destructive-pattern match
      // by now (and may have edited the command via updatedInput). The rtk
      // rewrite runs AFTER the gate, so confirm patterns see the command as
      // the model wrote it; when rtk is absent or declines, it is untouched.
      const childEnv = subprocessEnv(resolveEnabledWebSearchEnvNames());
      const cmd = await rtkRewriteCommand(params.command, childEnv);
      if (signal?.aborted) throw new DOMException("Tool cancelled before lock admission", "AbortError");
      // Only commands that touch git staging/history or the brain CLI's
      // write path take a lock (shared bashLockKey policy) — builds, greps,
      // curls and other reads run in parallel, across sessions and across
      // sibling tool calls in one message.
      return lock.withKey(bashLockKey(params.command), async () => {
        if (signal?.aborted) throw new DOMException("Tool cancelled before subprocess execution", "AbortError");
        const exec = resolveExecConfig();
        const proc = spawn(wrapCommand(["bash", "-lc", cmd], exec.wrapper), {
          cwd: brain.root,
          env: childEnv,
          stdout: "pipe",
          stderr: "pipe",
          ...execWrapperSpawnOptions(exec.wrapper),
        });
        const onAbort = () => killWrapped(proc, exec);
        signal?.addEventListener("abort", onAbort, { once: true });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        signal?.removeEventListener("abort", onAbort);
        const body = [stdout, stderr].filter(Boolean).join("\n").trim();
        return textResult(
          clip(`$ ${cmd}\n${body}${code === 0 ? "" : `\n[exit ${code}]`}`),
          { exitCode: code }
        );
      });
    },
  } satisfies ToolDefinition;

  const brain_add = {
    name: "brain_add",
    label: "Add to brain",
    description:
      "Capture content into the brain (classifies, writes a markdown file, reindexes). " +
      "Prefer this over write_file for new notes.",
    parameters: Type.Object({
      content: Type.String({ description: "The note content (first line becomes the title)." }),
      type: Type.Optional(Type.String({ description: "Explicit document type." })),
      title: Type.Optional(Type.String({ description: "Explicit title." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags." })),
    }),
    async execute(
      _id: string,
      params: { content: string; type?: string; title?: string; tags?: string[] }
    ) {
      // brain.add writes a markdown file and reindexes — brain-docs key.
      return lock.withKey(BRAIN_LOCK_KEY, async () => {
        const outcome = await brain.add({
          content: params.content,
          type: params.type,
          title: params.title,
          tags: params.tags,
        });
        const warn = outcome.indexed ? "" : ` (warning: reindex failed — ${outcome.indexError})`;
        return textResult(`${outcome.action}: ${outcome.path}${warn}`, outcome);
      });
    },
  } satisfies ToolDefinition;

  const brain_read = {
    name: "brain_read",
    label: "Read brain document",
    description:
      "Read a specific document from the brain knowledge base by its relative path. " +
      "By default returns the whole file, frontmatter included, clipped only at the tool's output limit. " +
      "Pass `section` to get one section by its heading (matched on its visible text, ignoring case; " +
      "the first of two equal headings wins), or `max_tokens` to get the frontmatter and an outline of " +
      "headings with their token counts instead of a file larger than that. `max_tokens` is the threshold " +
      "for switching to the outline, not a cap on the output.",
    parameters: Type.Object({
      path: Type.String({ description: 'Repo-relative document path, e.g. "me/identity.md".' }),
      section: Type.Optional(
        Type.String({
          description:
            "Heading text of one section to return, from its heading to the next heading of the same or higher level.",
        })
      ),
      max_tokens: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Threshold, not a cap: when the result would be larger than this, return the frontmatter and an outline instead.",
        })
      ),
    }),
    async execute(_id: string, params: { path: string; section?: string; max_tokens?: number }) {
      const abs = resolveOrThrow(params.path);
      // The same reader as the MCP tool and `brain read`; with neither option
      // it returns the file untouched, so the default read is unchanged. The
      // byte clip applies to what it selected, so a section past the clip
      // point of the whole file is still reachable.
      const raw = readFileSync(abs, "utf-8");
      rememberBase(params.path, raw);
      const text = readDocumentPart(raw, {
        section: params.section,
        maxTokens: params.max_tokens,
        sectionHint: 'section: "<heading>"',
      });
      return textResult(clip(text, MAX_READ_BYTES), { path: params.path });
    },
  } satisfies ToolDefinition;

  const brain_list = {
    name: "brain_list",
    label: "List brain documents",
    description:
      "List documents in the brain knowledge base with optional filters for type, tag, " +
      "status, and relevance. Returns metadata (path, title, type, relevance, status, tags).",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Filter by document type." })),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      status: Type.Optional(
        Type.String({ description: "Filter by status (active, archived, draft)." })
      ),
      relevance: Type.Optional(
        Type.String({ description: "Filter by relevance (primary, secondary, historical)." })
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)." })),
    }),
    async execute(
      _id: string,
      params: { type?: string; tag?: string; status?: string; relevance?: string; limit?: number }
    ) {
      const documents = await brain.list(params);
      // Compact, and cut by whole rows to MAX_JSON_CHARS: a byte-clipped JSON
      // document would not parse.
      return textResult(JSON.stringify(fitListing(documents)), {
        count: documents.length,
      });
    },
  } satisfies ToolDefinition;

  const brain_graph = {
    name: "brain_graph",
    label: "Brain link graph",
    description:
      "Traverse the wiki-link graph from a starting document. Returns edges " +
      "(source, target, resolved) showing how documents are connected via [[wiki-links]], " +
      "and nodes (path, title, type, summary, updated) for every document an edge touches. " +
      "A graph too large to return whole keeps its first edges with their nodes and says " +
      "`truncated: true` with `omitted_edges`.",
    parameters: Type.Object({
      path: Type.String({ description: "Starting document path." }),
      depth: Type.Optional(Type.Number({ description: "How many hops to traverse (default 1)." })),
      direction: Type.Optional(
        Type.String({
          description: 'Link direction: "outgoing", "incoming", or "both" (default).',
        })
      ),
    }),
    async execute(
      _id: string,
      params: { path: string; depth?: number; direction?: string }
    ) {
      const direction =
        params.direction === "outgoing" || params.direction === "incoming"
          ? params.direction
          : "both";
      const { edges, nodes } = await brain.graph({ path: params.path, depth: params.depth, direction });
      // Compact, and cut by whole edges to MAX_JSON_CHARS: a byte-clipped
      // JSON document would not parse, and every returned edge keeps its
      // endpoint nodes.
      return textResult(JSON.stringify(fitGraph(edges, nodes)), { count: edges.length });
    },
  } satisfies ToolDefinition;

  const brain_update = {
    name: PI_BRAIN_UPDATE_TOOL_NAME,
    label: "Update brain document",
    description:
      "Update an existing brain document: set frontmatter fields (summary, status, " +
      "relevance, tags, deadline, next_review) and/or append a markdown section to the " +
      "body. Bumps the `updated` field and reindexes. Setting status to archived also " +
      "demotes a primary or unset relevance to historical, as brain_archive does, " +
      "including a primary passed in the same call. Does not create files — use " +
      "brain_add for that.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative document path." }),
      summary: Type.Optional(Type.String({ description: "New one-line summary." })),
      status: Type.Optional(
        Type.String({ description: "New status: active, archived, or draft." })
      ),
      relevance: Type.Optional(
        Type.String({ description: "New relevance: primary, secondary, or historical." })
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags (replaces existing tags)." })
      ),
      deadline: Type.Optional(
        Type.String({ description: "Deadline date (ISO 8601), or empty string to remove." })
      ),
      next_review: Type.Optional(
        Type.String({ description: "Next review date (ISO 8601), or empty string to remove." })
      ),
      append_content: Type.Optional(
        Type.String({ description: "Markdown appended to the end of the document body." })
      ),
    }),
    async execute(
      _id: string,
      params: {
        path: string;
        summary?: string;
        status?: string;
        relevance?: string;
        tags?: string[];
        deadline?: string;
        next_review?: string;
        append_content?: string;
      }
    ) {
      const status =
        params.status === "active" || params.status === "archived" || params.status === "draft"
          ? params.status
          : undefined;
      if (params.status !== undefined && status === undefined) {
        throw new Error(`Invalid status "${params.status}" — use active, archived, or draft.`);
      }
      const relevance =
        params.relevance === "primary" ||
        params.relevance === "secondary" ||
        params.relevance === "historical"
          ? params.relevance
          : undefined;
      if (params.relevance !== undefined && relevance === undefined) {
        throw new Error(
          `Invalid relevance "${params.relevance}" — use primary, secondary, or historical.`
        );
      }
      // Write + reindex — brain-docs key, like the other document writers.
      return lock.withKey(BRAIN_LOCK_KEY, async () => {
        const outcome = await brain.update({
          path: params.path,
          summary: params.summary,
          status,
          relevance,
          tags: params.tags,
          deadline: params.deadline,
          nextReview: params.next_review,
          appendContent: params.append_content,
        });
        return textResult(JSON.stringify(outcome, null, 2), outcome);
      });
    },
  } satisfies ToolDefinition;

  const brain_archive = {
    name: "brain_archive",
    label: "Archive brain document",
    description:
      "Archive a brain document: sets status to archived, sets a primary or unset relevance " +
      "to historical, moves projects/active/ files to projects/archive/, and reindexes. " +
      "Requires user approval (an archived document drops out of search and briefings). " +
      "Use dry_run to preview.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative document path." }),
      dry_run: Type.Optional(Type.Boolean({ description: "Preview without changing anything." })),
    }),
    async execute(_id: string, params: { path: string; dry_run?: boolean }) {
      return lock.withKey(BRAIN_LOCK_KEY, async () => {
        const outcome = await brain.archive(params.path, params.dry_run ?? false);
        return textResult(JSON.stringify(outcome, null, 2), outcome);
      });
    },
  } satisfies ToolDefinition;

  const tools: ToolDefinition[] = [
    read_file,
    grep,
    brain_search,
    brain_context,
    brain_read,
    brain_list,
    brain_graph,
    write_file,
    edit_file,
    bash,
    brain_add,
    brain_update,
    brain_archive,
    ...createPiBridgeTools({
      brainPath: brain.root,
      turn,
      capabilities,
    }),
  ];
  const routed = brainApplicationInput.options.map(schema => {
    const operation = schema.shape.operation.value;
    const name = BRAIN_APPLICATION_TOOLS[operation];
    const legacy = tools.find(t => t.name === name);
    const shape = (schema as z.ZodObject).omit({ operation: true });
    // Existing pi inputs gain an optional base; a preceding read in this
    // same turn supplies it when absent. No read receipt crosses turns.
    const parameters = "expectedBaseHash" in shape.shape
      ? shape.extend({ expectedBaseHash: brainApplicationInput.options[0].shape.expectedBaseHash.optional() }) : shape;
    return {
      name, label: legacy?.label ?? "Apply staged changes", description: BRAIN_APPLICATION_DESCRIPTIONS[operation],
      parameters: toPiParameters(parameters),
      async execute(id: string, params: Record<string, unknown>, signal, onUpdate, ctx) {
        const bridge = turn.bridge;
        if (!bridge?.applyBrain) {
          if (!legacy) throw new Error("No authoritative server application route is available for this turn.");
          return legacy.execute(id, params, signal, onUpdate, ctx);
        }
        const input = { ...params, operation };
        if ("expectedBaseHash" in schema.shape && params.expectedBaseHash === undefined && typeof params.path === "string") {
          const receipt = bases.get(bridge)?.get(params.path);
          if (receipt === undefined && operation !== "write") throw new Error("Read brain_read_base or read_file first and use that document's exact base hash.");
          Object.assign(input, { expectedBaseHash: receipt ?? null });
        }
        const pending = bridge.applyBrain(input as Parameters<NonNullable<BackendBridge["applyBrain"]>>[0]);
        turn.pendingMutations?.add(pending);
        let result;
        try { result = await pending; }
        finally { turn.pendingMutations?.delete(pending); }
        if (!result.ok) throw new Error(JSON.stringify(result));
        return textResult(JSON.stringify(result), result);
      },
    } satisfies ToolDefinition;
  });
  const readBase = {
    name: "brain_read_base", label: "Read document base",
    description: "Read a Markdown document and its exact SHA-256 base for a hosted edit.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id: string, params: { path: string }) {
      if (!turn.bridge?.readBrainBase) throw new Error("No server document-base reader is available.");
      const base = await turn.bridge.readBrainBase(params.path);
      rememberBase(params.path, base.content);
      return textResult(JSON.stringify(base), base);
    },
  } satisfies ToolDefinition;
  return [...tools.filter(t => !routed.some(r => r.name === t.name)), ...routed, readBase];
}
