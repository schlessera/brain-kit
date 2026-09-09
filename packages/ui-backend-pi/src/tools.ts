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
import type { KeyedLock, WriteLock } from "@schlessera/brain-ui-sdk/server";
import {
  BRIDGE_TOOL_POSTURE,
  bashLockKey,
  BRAIN_LOCK_KEY,
  rtkRewriteCommand,
} from "@schlessera/brain-ui-sdk/server";

import { createPiBridgeTools } from "./bridge-tools.js";
import { resolveEnabledWebSearchEnvNames, subprocessEnv } from "./config/env.js";
import type { BrainAccess } from "./brain-access.js";
import type { TurnContext } from "./turn-context.js";

/** Risk class — documentation of which tools can mutate the working tree. */
export type RiskClass = "read" | "mutate";

const MAX_READ_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 30_000;

/** Result helper: pi tools return content parts + arbitrary details. */
function textResult(text: string, details: unknown = null) {
  return { content: [{ type: "text" as const, text }], details };
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
  withKey<T>(key: string | null, fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Keyed partitioning (the default): same-key calls serialize FIFO, different
 * keys — and key-less calls — run concurrently. This is what lets parallel
 * sibling tool calls actually BE parallel.
 */
export function toolLockFromKeyed(keyed: KeyedLock): ToolLock {
  return {
    withKey(key, fn) {
      return key === null ? Promise.resolve(fn()) : keyed.withLock(key, fn);
    },
  };
}

/**
 * Legacy whole-lock semantics for an injected WriteLock: EVERY mutating body
 * serializes on the one mutex, key or no key — exactly the pre-keyed
 * behavior a deployment sharing a lock with another writer opted into.
 */
export function toolLockFromWriteLock(writeLock: WriteLock): ToolLock {
  return {
    withKey(_key, fn) {
      return writeLock.withLock(fn);
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
  read_file: "read",
  grep: "read",
  brain_search: "read",
  brain_context: "read",
  brain_read: "read",
  brain_list: "read",
  brain_graph: "read",
  ask_user: "read",
  get_current_location: "read",
  query_activity: "read",
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

/** Name of pi's tappable-choice tool — also stated in the agent surface brief. */
export const PI_ASK_USER_TOOL_NAME = BRIDGE_TOOL_POSTURE.names[0];

export function createBrainTools(deps: BrainToolDeps): ToolDefinition[] {
  const { brain, turn, lock, capabilities } = deps;

  const resolveOrThrow = (rel: string): string => {
    const abs = brain.resolveInRepo(rel);
    if (!abs) {
      throw new Error(
        `Path "${rel}" escapes the brain repository and was refused.`
      );
    }
    return abs;
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
      return textResult(clip(raw, MAX_READ_BYTES), { path: params.path });
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
      const proc = spawn(["grep", "-rInE", "--", params.pattern, rel], {
        cwd: brain.root,
        env: subprocessEnv(resolveEnabledWebSearchEnvNames()),
        stdout: "pipe",
        stderr: "pipe",
      });
      const onAbort = () => proc.kill();
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
      "over grep for finding notes by meaning. Returns ranked results with snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or keyword query." }),
      type: Type.Optional(Type.String({ description: "Filter by document type." })),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
    }),
    async execute(
      _id: string,
      params: { query: string; type?: string; tag?: string; limit?: number }
    ) {
      const { results, warnings } = await brain.search({
        query: params.query,
        type: params.type,
        tag: params.tag,
        limit: params.limit ?? 10,
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
      // The tool_call gate has already confirmed a destructive-pattern match
      // by now (and may have edited the command via updatedInput). The rtk
      // rewrite runs AFTER the gate, so confirm patterns see the command as
      // the model wrote it; when rtk is absent or declines, it is untouched.
      const childEnv = subprocessEnv(resolveEnabledWebSearchEnvNames());
      const cmd = await rtkRewriteCommand(params.command, childEnv);
      // Only commands that touch git staging/history or the brain CLI's
      // write path take a lock (shared bashLockKey policy) — builds, greps,
      // curls and other reads run in parallel, across sessions and across
      // sibling tool calls in one message.
      return lock.withKey(bashLockKey(params.command), async () => {
        const proc = spawn(["bash", "-lc", cmd], {
          cwd: brain.root,
          env: childEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const onAbort = () => proc.kill();
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
      "Returns the full file contents including frontmatter.",
    parameters: Type.Object({
      path: Type.String({ description: 'Repo-relative document path, e.g. "me/identity.md".' }),
    }),
    async execute(_id: string, params: { path: string }) {
      const abs = resolveOrThrow(params.path);
      const raw = readFileSync(abs, "utf-8");
      return textResult(clip(raw, MAX_READ_BYTES), { path: params.path });
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
      return textResult(clip(JSON.stringify({ documents }, null, 2)), {
        count: documents.length,
      });
    },
  } satisfies ToolDefinition;

  const brain_graph = {
    name: "brain_graph",
    label: "Brain link graph",
    description:
      "Traverse the wiki-link graph from a starting document. Returns edges " +
      "(source, target, resolved) showing how documents are connected via [[wiki-links]].",
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
      const edges = await brain.graph({ path: params.path, depth: params.depth, direction });
      return textResult(clip(JSON.stringify({ edges }, null, 2)), { count: edges.length });
    },
  } satisfies ToolDefinition;

  const brain_update = {
    name: "brain_update",
    label: "Update brain document",
    description:
      "Update an existing brain document: set frontmatter fields (summary, status, " +
      "relevance, tags, deadline, next_review) and/or append a markdown section to the " +
      "body. Bumps the `updated` field and reindexes. Does not create files — use " +
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
      "Archive a brain document: sets status to archived, moves projects/active/ files " +
      "to projects/archive/, and reindexes. Requires user approval (an archived document " +
      "drops out of search and briefings). Use dry_run to preview.",
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
  return tools;
}
