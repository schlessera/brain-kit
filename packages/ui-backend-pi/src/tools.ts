/**
 * The curated brain tool surface for the pi backend.
 *
 * Instead of pi's built-in read/bash/edit/write (disabled via
 * `noTools: "builtin"`), the agent gets a small, brain-repo-scoped set:
 *
 *   read_file, grep, brain_search, brain_context   — read-only, auto-allowed
 *   write_file, edit_file, bash, brain_add          — mutating, gated on approval
 *   ask_user                                        — interactive, auto-allowed
 *
 * The permission gate lives INSIDE each tool's execute(): read-only tools run
 * with no round-trip; mutating tools first await bridge.requestPermission() and
 * throw on denial. A thrown error becomes an `isError` tool result fed back to
 * the model (pi's agent loop catches tool throws), so a denial never crashes
 * the turn. File tools use @endoxa/core's safeResolve for repo containment;
 * bash is pinned to the repo cwd.
 */

import { spawn } from "bun";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Type } from "typebox";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AskUserQuestion, WriteLock } from "@endoxa/ui-sdk/server";

import type { BrainAccess } from "./brain-access.js";
import type { TurnContext } from "./turn-context.js";

/** Risk class → whether execute() must round-trip through requestPermission. */
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
 * Await approval for a mutating tool. Returns the effective input (the host may
 * return an edited `updatedInput`). Throws on denial — pi turns the throw into
 * an error tool result, so the turn survives.
 */
async function gateMutation(
  turn: TurnContext,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  description: string
): Promise<Record<string, unknown>> {
  const bridge = turn.bridge;
  if (!bridge) throw new Error("No active turn: tool called outside startTurn.");
  const decision = await bridge.requestPermission({
    toolUseId: toolCallId,
    toolName,
    input,
    description,
  });
  if (decision.behavior === "deny") {
    throw new Error(decision.message || `Permission denied for ${toolName}.`);
  }
  return decision.updatedInput ?? input;
}

export interface BrainToolDeps {
  brain: BrainAccess;
  turn: TurnContext;
  /**
   * Serializes MUTATING tool executions across all sessions that share this
   * backend's working tree. Read-class tools never take it. One lock instance
   * is shared by every per-session toolset (see backend.ts).
   */
  writeLock: WriteLock;
}

/** Static risk-class table (also documented in the package README). */
export const TOOL_RISK: Record<string, RiskClass> = {
  read_file: "read",
  grep: "read",
  brain_search: "read",
  brain_context: "read",
  ask_user: "read",
  write_file: "mutate",
  edit_file: "mutate",
  bash: "mutate",
  brain_add: "mutate",
};

export function createBrainTools(deps: BrainToolDeps): ToolDefinition[] {
  const { brain, turn, writeLock } = deps;

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
      "Create or overwrite a UTF-8 text file in the brain repository. Requires user " +
      "approval. Path is relative to the repo root.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
      content: Type.String({ description: "Full file contents to write." }),
    }),
    async execute(id: string, params: { path: string; content: string }) {
      const input = await gateMutation(turn, id, "write_file", params, `Write ${params.path}`);
      const p = input as { path: string; content: string };
      // Post-permission mutation runs under the shared write lock so concurrent
      // sessions never interleave writes in the same working tree.
      return writeLock.withLock(() => {
        const abs = resolveOrThrow(p.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, p.content, "utf-8");
        return textResult(`Wrote ${p.content.length} bytes to ${p.path}.`, { path: p.path });
      });
    },
  } satisfies ToolDefinition;

  const edit_file = {
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact, unique string in a brain-repo file. Requires user approval. " +
      "old_string must occur exactly once.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
      old_string: Type.String({ description: "Exact text to replace (must be unique)." }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    async execute(
      id: string,
      params: { path: string; old_string: string; new_string: string }
    ) {
      const input = await gateMutation(turn, id, "edit_file", params, `Edit ${params.path}`);
      const p = input as { path: string; old_string: string; new_string: string };
      // Read-modify-write is atomic under the shared write lock.
      return writeLock.withLock(() => {
        const abs = resolveOrThrow(p.path);
        const raw = readFileSync(abs, "utf-8");
        const occurrences = raw.split(p.old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${p.path}.`);
        if (occurrences > 1) {
          throw new Error(
            `old_string is not unique in ${p.path} (${occurrences} matches); add more context.`
          );
        }
        writeFileSync(abs, raw.replace(p.old_string, p.new_string), "utf-8");
        return textResult(`Edited ${p.path}.`, { path: p.path });
      });
    },
  } satisfies ToolDefinition;

  const bash = {
    name: "bash",
    label: "Run bash",
    description:
      "Run a bash command in the brain repository root. Requires user approval. " +
      "Combined stdout+stderr is returned.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command line to execute." }),
    }),
    async execute(id: string, params: { command: string }, signal?: AbortSignal) {
      const input = await gateMutation(turn, id, "bash", params, params.command);
      const cmd = (input as { command: string }).command;
      // A shell command may touch git/index/hooks, so the whole execution runs
      // under the shared write lock — cross-session bash is serialized.
      return writeLock.withLock(async () => {
        const proc = spawn(["bash", "-lc", cmd], {
          cwd: brain.root,
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
      "Requires user approval. Prefer this over write_file for new notes.",
    parameters: Type.Object({
      content: Type.String({ description: "The note content (first line becomes the title)." }),
      type: Type.Optional(Type.String({ description: "Explicit document type." })),
      title: Type.Optional(Type.String({ description: "Explicit title." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags." })),
    }),
    async execute(
      id: string,
      params: { content: string; type?: string; title?: string; tags?: string[] }
    ) {
      const input = await gateMutation(
        turn,
        id,
        "brain_add",
        params,
        `Add note: ${params.title ?? params.content.slice(0, 60)}`
      );
      const p = input as { content: string; type?: string; title?: string; tags?: string[] };
      // brain.add writes a markdown file and reindexes — serialize under the lock.
      return writeLock.withLock(async () => {
        const outcome = await brain.add({
          content: p.content,
          type: p.type,
          title: p.title,
          tags: p.tags,
        });
        const warn = outcome.indexed ? "" : ` (warning: reindex failed — ${outcome.indexError})`;
        return textResult(`${outcome.action}: ${outcome.path}${warn}`, outcome);
      });
    },
  } satisfies ToolDefinition;

  const ask_user = {
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user 1-4 clarifying questions with selectable options. Use when a " +
      "request is ambiguous. Returns the user's answers.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          header: Type.String({ description: "Short label for the question group." }),
          multiSelect: Type.Optional(Type.Boolean()),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.String(),
            })
          ),
        }),
        { description: "1-4 questions to ask." }
      ),
    }),
    async execute(id: string, params: { questions: AskUserQuestionInput[] }) {
      const bridge = turn.bridge;
      if (!bridge?.askUser) {
        throw new Error("The host does not support ask_user in this session.");
      }
      const questions: AskUserQuestion[] = params.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
      }));
      const result = await bridge.askUser(id, questions);
      return textResult(JSON.stringify(result.answers, null, 2), result);
    },
  } satisfies ToolDefinition;

  return [
    read_file,
    grep,
    brain_search,
    brain_context,
    write_file,
    edit_file,
    bash,
    brain_add,
    ask_user,
  ];
}

interface AskUserQuestionInput {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}
