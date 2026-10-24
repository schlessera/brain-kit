/**
 * Shared reference source and managed worktrees (#2432). Inputs carry the
 * repository, revision or worktree identity only: principal, profile, brain,
 * session and worker generation come from the authenticated turn on the host,
 * and a tool argument never widens them. Results report live facts once, in
 * the result itself; names, descriptions and briefs are fixed.
 */
import { z } from "zod";
import { defineToolContract } from "./contract.js";

export const REFERENCE_SOURCE_TOOL_NAME = "reference_source";
export const REFERENCE_WORKTREE_TOOL_NAME = "reference_worktree";
/** Worktrees one `list` result names; `truncated` says when there are more. */
export const REFERENCE_WORKTREE_LIST_LIMIT = 20;

const repository = z.string().trim().min(1).max(2048)
  .describe("Repository location: an https URL without credentials, a loopback http URL, or an absolute file:// path.");
const revision = z.string().trim().min(1).max(200)
  .describe("Branch or tag name. A raw commit id is refused; for one fixed commit, request a worktree.");
const worktreeId = z.string().trim().min(1).max(64).describe("Worktree identity from an earlier result.");

export const REFERENCE_SOURCE_INPUT_SCHEMA = z.strictObject({ repository, revision });
export type ReferenceSourceInput = z.infer<typeof REFERENCE_SOURCE_INPUT_SCHEMA>;

export const REFERENCE_WORKTREE_ACTIONS = ["request", "access", "renew", "release", "list"] as const;
export type ReferenceWorktreeAction = (typeof REFERENCE_WORKTREE_ACTIONS)[number];
/** One strict object for every action; which fields an action takes is checked here, not by the host. */
export const REFERENCE_WORKTREE_INPUT_SCHEMA = z.strictObject({
  action: z.enum(REFERENCE_WORKTREE_ACTIONS).describe("request: a new worktree. access: make one available to this turn, resuming it if it expired. renew: reset its inactivity clock. release: give it up for good. list: your worktrees."),
  repository: repository.optional().describe("request only. Repository location: an https URL without credentials, a loopback http URL, or an absolute file:// path."),
  revision: revision.optional().describe("request only. Branch or tag whose current commit the worktree starts from."),
  worktreeId: worktreeId.optional().describe("access, renew and release only."),
}).superRefine((input, context) => {
  const wants = input.action === "request" ? ["repository", "revision"] : input.action === "list" ? [] : ["worktreeId"];
  for (const key of ["repository", "revision", "worktreeId"] as const) {
    if (wants.includes(key) && input[key] === undefined) context.addIssue({ code: "custom", path: [key], message: `action "${input.action}" needs ${key}` });
    if (!wants.includes(key) && input[key] !== undefined) context.addIssue({ code: "custom", path: [key], message: `action "${input.action}" takes no ${key}` });
  }
});
export type ReferenceWorktreeInput = z.infer<typeof REFERENCE_WORKTREE_INPUT_SCHEMA>;

/** One shared source as this turn sees it. Times are ISO 8601. */
export interface ReferenceSourceView {
  repository: string;
  revision: string;
  domain: "public" | "private";
  /** The commit published now; a later read of the same path may see a newer one. */
  commit: string;
  /** Read-only path in this turn's workers, or null when no worker of this turn can reach it. */
  path: string | null;
  freshness: "fresh" | "stale";
  /** Last successful refresh; a failed refresh never advances it. */
  refreshedAt: string;
  /** Last successful authority check of `commit`. */
  validatedAt: string;
  /** Why the latest refresh failed, when `freshness` is `stale`. */
  error: string | null;
}

/** One managed worktree. Times are ISO 8601. */
export interface ReferenceWorktreeView {
  id: string;
  repository: string;
  revision: string;
  domain: "public" | "private";
  /** Fixed: the worktree never moves with its source. */
  startingCommit: string;
  state: "active" | "expired" | "released";
  /** Writable path in this turn's workers, or null when this turn does not hold it. */
  path: string | null;
  /** Last explicit request, access or renewal. */
  lastActivityAt: string;
  /** When it expires without another explicit access or renewal. */
  expiresAt: string;
  releasedAt: string | null;
  /** Disk allowance of the worktree's own changes, in bytes. */
  allowanceBytes: number;
}

export type ReferenceToolRefusalCode = "unavailable" | "unauthorized" | "missing" | "invalid" | "capacity" | "busy" | "released" | "cancelled";

export type ReferenceToolResult =
  | { ok: true; source: ReferenceSourceView; guidance: string }
  | { ok: true; action: Exclude<ReferenceWorktreeAction, "list">; worktree: ReferenceWorktreeView; guidance: string }
  | { ok: true; action: "list"; worktrees: ReferenceWorktreeView[]; truncated: boolean; guidance: string }
  | { ok: false; code: ReferenceToolRefusalCode; message: string };

/** What a backend hands the host: the tool and its parsed input, nothing else. */
export type ReferenceToolCall =
  | { tool: typeof REFERENCE_SOURCE_TOOL_NAME; input: ReferenceSourceInput }
  | { tool: typeof REFERENCE_WORKTREE_TOOL_NAME; input: ReferenceWorktreeInput };

export const REFERENCE_SOURCE_CONTRACT = defineToolContract({
  name: REFERENCE_SOURCE_TOOL_NAME,
  input: REFERENCE_SOURCE_INPUT_SCHEMA,
  description: "Read another repository's branch or tag as shared reference source, under the reference grants you hold. The result gives the commit published now, whether it is fresh or stale (a refresh failed; the error and last refresh time are reported), and the read-only path where this turn's workers read it, or null when they cannot. Shared source is read-only and moves: a later read may see a newer commit. To edit it, or to read one fixed commit across several steps, request a managed worktree instead. A refusal says why; do not clone the repository yourself instead.",
  brief: name => `- **Reference source is shared and moves.** Read another repository with \`${name}\`; read only under the path it returns. Its files are read-only and a later read may see a newer commit.`,
});

export const REFERENCE_WORKTREE_CONTRACT = defineToolContract({
  name: REFERENCE_WORKTREE_TOOL_NAME,
  input: REFERENCE_WORKTREE_INPUT_SCHEMA,
  description: "Managed writable worktrees of reference source. Use one before editing reference source or to read one fixed commit across several steps. `request` (repository, revision) creates a worktree at the source's current commit and makes it available to this turn; its starting commit never moves. `access` (worktreeId) makes one of your worktrees available to this turn, resuming it if it expired. `renew` (worktreeId) resets its three-day inactivity clock. `release` (worktreeId) gives it up for good; unfinished work is kept for the user to decide. `list` names your worktrees. Only request, access and renew reset the clock: reading, writing and commands do not. Edits are journaled and count toward this turn's scope limits. A refusal says why; do not work around it with an unmanaged clone.",
  brief: name => `- **Edit reference source only in a managed worktree.** Use \`${name}\` to request, access, renew, release or list one; work only under the path it returns, and release it when you are done.`,
});

export const REFERENCE_TOOL_CONTRACTS = [REFERENCE_SOURCE_CONTRACT, REFERENCE_WORKTREE_CONTRACT] as const;
