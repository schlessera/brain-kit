/**
 * The curated brain tool surface for the Gemini backend.
 *
 * Gemini receives plain JSON Schema function declarations, while callTool()
 * owns execution:
 *
 *   read_file, grep, brain_search, brain_context   — read-only, auto-allowed
 *   write_file, edit_file, bash, brain_add          — mutating, gated on approval
 *   ask_user                                        — interactive, auto-allowed
 *
 * The permission gate lives INSIDE each mutating dispatch path. Read-only
 * tools run with no round-trip; mutating tools first await
 * bridge.requestPermission(), then execute under the shared WriteLock. Tool
 * failures become error function responses so the hand-rolled agent loop can
 * continue. File tools use @brainform/core's safeResolve for repo containment;
 * bash is pinned to the repo cwd.
 */

import { spawn } from "bun";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

import type { FunctionDeclaration } from "@google/genai";
import type { AskUserQuestion, WriteLock } from "@brainform/ui-sdk/server";

import type { BrainAccess } from "./brain-access";
import type { TurnContext } from "./turn-context";

/** Risk class → whether dispatch must round-trip through requestPermission. */
export type RiskClass = "read" | "mutate";

const MAX_READ_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 30_000;

interface JsonObjectSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * The SDK's FunctionDeclaration fields made concrete for this package.
 * parametersJsonSchema accepts ordinary JSON Schema without the SDK's enum-
 * based OpenAPI Schema conversion.
 */
export type GeminiFunctionDeclaration = FunctionDeclaration & {
  name: string;
  description: string;
  parametersJsonSchema: JsonObjectSchema;
};

export interface GeminiToolContext {
  brain: BrainAccess;
  turn: TurnContext;
  /**
   * Serializes MUTATING tool executions across all sessions that share this
   * backend's working tree. Read-class tools never take it.
   */
  writeLock: WriteLock;
  toolCallId: string;
}

export interface GeminiToolResult {
  text: string;
  isError: boolean;
}

interface AskUserQuestionInput {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}

function clip(text: string, max = MAX_OUTPUT_BYTES): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} bytes]`;
}

/**
 * Await approval for a mutating tool. Returns the effective input (the host may
 * return an edited `updatedInput`). Throws on denial; callTool catches it and
 * returns an error result to the model.
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

/** Static risk-class table, identical to the pi backend's curated surface. */
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

/** Function declarations passed to config.tools[0].functionDeclarations. */
export const GEMINI_FUNCTION_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the brain repository. Path is relative to the repo root.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path." },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents in the brain repository with a regular expression. " +
      "Returns matching lines as `path:line: text`.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: {
          type: "string",
          description: "Repo-relative subtree to search (default: whole repo).",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "brain_search",
    description:
      "Hybrid (full-text + vector) search across the knowledge base. Prefer this " +
      "over grep for finding notes by meaning. Returns ranked results with snippets.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword query." },
        type: { type: "string", description: "Filter by document type." },
        tag: { type: "string", description: "Filter by tag." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_context",
    description:
      "Assemble a token-limited markdown context block of the most relevant notes " +
      "for a query. Use to ground an answer in the knowledge base.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to gather context about." },
        maxTokens: { type: "number", description: "Token budget (default 4000)." },
      },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file in the brain repository. Requires user " +
      "approval. Path is relative to the repo root.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path." },
        content: { type: "string", description: "Full file contents to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact, unique string in a brain-repo file. Requires user approval. " +
      "old_string must occur exactly once.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path." },
        old_string: {
          type: "string",
          description: "Exact text to replace (must be unique).",
        },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "bash",
    description:
      "Run a bash command in the brain repository root. Requires user approval. " +
      "Combined stdout+stderr is returned.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command line to execute." },
      },
      required: ["command"],
    },
  },
  {
    name: "brain_add",
    description:
      "Capture content into the brain (classifies, writes a markdown file, reindexes). " +
      "Requires user approval. Prefer this over write_file for new notes.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The note content (first line becomes the title).",
        },
        type: { type: "string", description: "Explicit document type." },
        title: { type: "string", description: "Explicit title." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user 1-4 clarifying questions with selectable options. Use when a " +
      "request is ambiguous. Returns the user's answers.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 questions to ask.",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: {
                type: "string",
                description: "Short label for the question group.",
              },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label", "description"],
                },
              },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
];

/**
 * Execute one Gemini function call. Errors never escape the tool loop: denied
 * mutations, containment refusals, missing files, and unknown tools all become
 * isError=true responses that the model can inspect and recover from.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: GeminiToolContext
): Promise<GeminiToolResult> {
  try {
    return {
      text: await executeTool(name, args, ctx),
      isError: false,
    };
  } catch (err) {
    return {
      text: errorMessage(err),
      isError: true,
    };
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: GeminiToolContext
): Promise<string> {
  const { brain, turn, writeLock, toolCallId } = ctx;

  const resolveOrThrow = (rel: string): string => {
    const abs = brain.resolveInRepo(rel);
    if (!abs) {
      throw new Error(`Path "${rel}" escapes the brain repository and was refused.`);
    }
    return abs;
  };

  switch (name) {
    case "read_file": {
      const p = args as unknown as { path: string };
      const abs = resolveOrThrow(p.path);
      return clip(readFileSync(abs, "utf-8"), MAX_READ_BYTES);
    }

    case "grep": {
      const p = args as unknown as { pattern: string; path?: string };
      const rel = p.path ?? ".";
      resolveOrThrow(rel);
      const proc = spawn(["grep", "-rInE", "--", p.pattern, rel], {
        cwd: brain.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const onAbort = () => proc.kill();
      turn.signal?.addEventListener("abort", onAbort, { once: true });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      turn.signal?.removeEventListener("abort", onAbort);
      const text = out.trim();
      return text ? clip(text) : "No matches.";
    }

    case "brain_search": {
      const p = args as unknown as {
        query: string;
        type?: string;
        tag?: string;
        limit?: number;
      };
      const { results, warnings } = await brain.search({
        query: p.query,
        type: p.type,
        tag: p.tag,
        limit: p.limit ?? 10,
      });
      const lines: string[] = [];
      for (const warning of warnings) lines.push(`> ${warning}`);
      if (results.length === 0) lines.push("No results found.");
      for (const result of results) {
        lines.push(
          `- ${result.path} — ${result.title} [${result.type}]` +
            (result.snippet ? `\n    ${result.snippet}` : "")
        );
      }
      return clip(lines.join("\n"));
    }

    case "brain_context": {
      const p = args as unknown as { query: string; maxTokens?: number };
      const block = await brain.context(p.query, p.maxTokens ?? 4000);
      return block || "No relevant context found.";
    }

    case "write_file": {
      const initial = args as unknown as { path: string; content: string };
      const input = await gateMutation(
        turn,
        toolCallId,
        "write_file",
        args,
        `Write ${initial.path}`
      );
      const p = input as unknown as { path: string; content: string };
      return writeLock.withLock(() => {
        const abs = resolveOrThrow(p.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, p.content, "utf-8");
        return `Wrote ${p.content.length} bytes to ${p.path}.`;
      });
    }

    case "edit_file": {
      const initial = args as unknown as {
        path: string;
        old_string: string;
        new_string: string;
      };
      const input = await gateMutation(
        turn,
        toolCallId,
        "edit_file",
        args,
        `Edit ${initial.path}`
      );
      const p = input as unknown as {
        path: string;
        old_string: string;
        new_string: string;
      };
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
        return `Edited ${p.path}.`;
      });
    }

    case "bash": {
      const initial = args as unknown as { command: string };
      const input = await gateMutation(
        turn,
        toolCallId,
        "bash",
        args,
        initial.command
      );
      const command = (input as unknown as { command: string }).command;
      return writeLock.withLock(async () => {
        const proc = spawn(["bash", "-lc", command], {
          cwd: brain.root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const onAbort = () => proc.kill();
        turn.signal?.addEventListener("abort", onAbort, { once: true });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        turn.signal?.removeEventListener("abort", onAbort);
        const body = [stdout, stderr].filter(Boolean).join("\n").trim();
        return clip(
          `$ ${command}\n${body}${code === 0 ? "" : `\n[exit ${code}]`}`
        );
      });
    }

    case "brain_add": {
      const initial = args as unknown as {
        content: string;
        type?: string;
        title?: string;
        tags?: string[];
      };
      const input = await gateMutation(
        turn,
        toolCallId,
        "brain_add",
        args,
        `Add note: ${initial.title ?? initial.content.slice(0, 60)}`
      );
      const p = input as unknown as {
        content: string;
        type?: string;
        title?: string;
        tags?: string[];
      };
      return writeLock.withLock(async () => {
        const outcome = await brain.add({
          content: p.content,
          type: p.type,
          title: p.title,
          tags: p.tags,
        });
        const warning = outcome.indexed
          ? ""
          : ` (warning: reindex failed — ${outcome.indexError})`;
        return `${outcome.action}: ${outcome.path}${warning}`;
      });
    }

    case "ask_user": {
      const bridge = turn.bridge;
      if (!bridge?.askUser) {
        throw new Error("The host does not support ask_user in this session.");
      }
      const p = args as unknown as { questions: AskUserQuestionInput[] };
      const questions: AskUserQuestion[] = p.questions.map((question) => ({
        question: question.question,
        header: question.header,
        multiSelect: question.multiSelect ?? false,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
      }));
      const result = await bridge.askUser(toolCallId, questions);
      return JSON.stringify(result.answers, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
