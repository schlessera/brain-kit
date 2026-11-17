// The host GitHub tools (#3791), rendered as the ui-kit GitHub components
// (#3795, design #3795 revision 2, components #3800).
//
// GLOBAL like the chat UI's own tools: every backend exposes the same
// contracts under its own spelling, so `bind()` registers the Pi name, the
// Claude MCP name and the legacy spelling for each. A refusal is part of the
// result schema, so it reaches the card and is drawn in the result's own
// words. Only output that is not a result envelope at all (an exception's
// message) reaches the fallback.

import type { RendererPack, ToolCallView } from "@schlessera/brain-ui-sdk/client";
import {
  GITHUB_ISSUE_COMMENT_CONTRACT,
  GITHUB_ISSUE_COMMENT_INPUT_SCHEMA,
  GITHUB_ISSUE_CREATE_CONTRACT,
  GITHUB_ISSUE_CREATE_INPUT_SCHEMA,
  GITHUB_ISSUE_READ_CONTRACT,
  GITHUB_ISSUE_SEARCH_CONTRACT,
  GITHUB_RESULT_SCHEMAS,
  GITHUB_TOOL_NAMES,
  type GithubToolResult,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import { GitPullRequest, Search, SquarePen, MessageSquarePlus } from "lucide-react";
import type { ComponentType } from "react";
import { ClampedPre } from "../tool-views.js";
import {
  GithubCommentCard,
  GithubCommentPreview,
  GithubCreateCard,
  GithubCreatePreview,
  GithubReadCard,
  GithubSearchCard,
} from "../tool-cards/github-cards.js";
import { bind } from "./bind.js";

/** Each contract with its result envelope as the payload `bind()` parses. */
const READ = { ...GITHUB_ISSUE_READ_CONTRACT, payload: GITHUB_RESULT_SCHEMAS[GITHUB_TOOL_NAMES.read] };
const SEARCH = { ...GITHUB_ISSUE_SEARCH_CONTRACT, payload: GITHUB_RESULT_SCHEMAS[GITHUB_TOOL_NAMES.search] };
const CREATE = { ...GITHUB_ISSUE_CREATE_CONTRACT, payload: GITHUB_RESULT_SCHEMAS[GITHUB_TOOL_NAMES.create] };
const COMMENT = { ...GITHUB_ISSUE_COMMENT_CONTRACT, payload: GITHUB_RESULT_SCHEMAS[GITHUB_TOOL_NAMES.comment] };

/** Output that is not a result envelope: the words as they came. */
const Fallback = ({ tool }: { tool: ToolCallView }) => (tool.output ? <ClampedPre text={tool.output} isError={tool.isError} /> : null);

/** The card a write tool's approval row shows: exactly what will be posted (W1, W4). */
function writeInput<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, Preview: ComponentType<{ input: T }>) {
  return function WriteInput({ tool }: { tool: ToolCallView }) {
    // Only while the approval waits. The approval row never receives an
    // output, so after a decision a draft would keep reading "not posted";
    // the original call's row shows what happened instead.
    if (tool.status !== "pending_approval") return null;
    const parsed = schema.safeParse(tool.input);
    return parsed.success && parsed.data ? <Preview input={parsed.data} /> : null;
  };
}

const okOnly = <R,>(payload: GithubToolResult, pick: (p: Extract<GithubToolResult, { ok: true }>) => R | null): R | null => (payload.ok ? pick(payload) : null);

export const githubToolPack: RendererPack = {
  renderers: [
    ...bind(READ, GithubReadCard, {
      icon: GitPullRequest,
      label: "GitHub",
      summary: (p) => okOnly(p, (r) => (r.tool === GITHUB_TOOL_NAMES.read ? `${r.result.repository} #${r.result.number}` : null)),
      meta: (p) => (p.ok ? null : p.error.message),
      Fallback,
    }),
    ...bind(SEARCH, GithubSearchCard, {
      icon: Search,
      label: "GitHub search",
      summary: (p) => okOnly(p, (r) => (r.tool === GITHUB_TOOL_NAMES.search ? `“${r.result.query}” in ${r.result.repository}` : null)),
      meta: (p) => (p.ok ? null : p.error.message),
      Fallback,
    }),
    ...bind(CREATE, GithubCreateCard, {
      icon: SquarePen,
      label: "GitHub issue",
      summary: (p) => okOnly(p, (r) => (r.tool === GITHUB_TOOL_NAMES.create ? `${r.result.repository} #${r.result.number}` : null)),
      Input: writeInput(GITHUB_ISSUE_CREATE_INPUT_SCHEMA, GithubCreatePreview),
      Fallback,
    }),
    ...bind(COMMENT, GithubCommentCard, {
      icon: MessageSquarePlus,
      label: "GitHub comment",
      summary: (p) => okOnly(p, (r) => (r.tool === GITHUB_TOOL_NAMES.comment ? `${r.result.repository} #${r.result.number}` : null)),
      Input: writeInput(GITHUB_ISSUE_COMMENT_INPUT_SCHEMA, GithubCommentPreview),
      Fallback,
    }),
  ],
};

/** The bare GitHub tool name behind any backend's spelling, or null. */
function githubToolName(name: string): string | null {
  const bare = name.replace(/^mcp__brain[-_]ui__/, "");
  return bare === GITHUB_TOOL_NAMES.create || bare === GITHUB_TOOL_NAMES.comment ? bare : null;
}

/**
 * A GitHub write's approval header: where it goes, never the draft as one
 * JSON line; the draft renders below as W1 or W4. The buttons say what
 * happens, in the design's words.
 */
export function githubApproval(tool: Pick<ToolCallView, "name" | "input">): { target: string; allowLabel: string; denyLabel: string } | null {
  const name = githubToolName(tool.name);
  if (!name) return null;
  const input = (tool.input ?? {}) as { repository?: unknown; number?: unknown };
  const repository = typeof input.repository === "string" ? input.repository : "GitHub";
  return name === GITHUB_TOOL_NAMES.create
    ? { target: repository, allowLabel: "Post issue", denyLabel: "Don't post" }
    : { target: typeof input.number === "number" ? `${repository} #${input.number}` : repository, allowLabel: "Post comment", denyLabel: "Don't post" };
}
