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
    // Only the approval row: the original call's row shows its result instead.
    if (tool.status !== "pending_approval" && tool.status !== "approved" && tool.status !== "denied") return null;
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
