import { APIFY_TOOL_NAMES, ASK_USER_TOOL_NAME, BRIDGE_TOOL_POSTURE, WEB_TOOL_NAME_LIST } from "@schlessera/brain-ui-sdk/server";
/**
 * The curated brain tool surface for the pi backend.
 *
 * Instead of pi's built-in read/bash/edit/write (disabled via
 * `noTools: "builtin"`), the agent gets a brain-repo-scoped set mirroring
 * what the Claude backend exposes:
 *
 *   read_file, grep — repo-scoped file access
 *   brain_search, brain_context, brain_read, brain_list, brain_graph,
 *   brain_read_many — read paths of the brain MCP surface, in-process
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

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KeyedLock, KeyedLockAcquireOptions, WriteLock } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createPiBridgeTools } from "./bridge-tools.js";
import { brainReadBaseTool, routedApplicationTools } from "./application-tools.js";
import { brainAddTool, brainArchiveTool, brainContextTool, brainGraphTool, brainListTool, brainReadManyTool, brainReadTool, brainSearchTool, brainUpdateTool } from "./brain-tools.js";
import { bashTool, editFileTool, grepTool, readFileTool, writeFileTool } from "./file-tools.js";
import { createBrainToolKit } from "./tool-kit.js";
import type { BrainAccess } from "./brain-access.js";
import type { TurnContext } from "./turn-context.js";

/** Risk class — documentation of which tools can mutate the working tree. */
export type RiskClass = "read" | "mutate";


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
  /** Resolved host wrapper. Explicit {} disables wrapping; omission retains ambient compatibility. */
  exec?: import("@schlessera/brain-ui-sdk/server").ExecWrapperConfig;
  /** Worker shell writes stay in fresh scratch; never a privileged cwd. */
  shellCwd?: string;
  directWrites?: boolean;
  /** Trusted worker entry reports observation phases; it never supplies a hash or grant. */
  nativeFileObservation?: (phase: "read_start" | "read_end" | "write_check" | "write_end", path: string, toolCallId: string) => Promise<void>;
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
    inbox?: boolean;
    mask?: boolean;
    policyChange?: boolean;
    turnTemp?: boolean;
    reference?: boolean;
    compute?: boolean;
    apify?: boolean;
    attachments?: boolean;
    web?: boolean;
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
  // A bounded read of several documents (#3642): each member as brain_read reads it.
  brain_read_many: "read",
  ask_user: "read",
  ask_user_list: "read",
  ask_user_rank: "read",
  ask_user_form: "read",
  get_current_location: "read",
  query_activity: "read",
  inbox_list: "read", inbox_get: "read", inbox_add: "mutate", resolve_action: "mutate", complete_share: "mutate",
  // Shared source is read-only; a worktree request, access, renewal or release changes host state (#2432).
  reference_source: "read", reference_worktree: "mutate",
  // External compute (#3108): a run starts paid remote work and a cancel
  // releases it; health, plan, status and collect change nothing the agent owns.
  brain_compute_health: "read", brain_compute_plan: "read", brain_compute_run: "mutate",
  brain_compute_status: "read", brain_compute_cancel: "mutate", brain_compute_collect: "read",
  // Apify (#3162): reads of the catalog and of owned runs; prepare spends
  // no Actor run; run and abort change remote and ledger state.
  brain_apify_availability: "read", brain_apify_approvals: "read", brain_apify_revoke: "mutate",
  brain_apify_discover: "read", brain_apify_inspect: "read", brain_apify_prepare: "read",
  brain_apify_run: "mutate", brain_apify_status: "read", brain_apify_results: "read", brain_apify_abort: "mutate",
  // Attachment reads (#3154): the host authorizes each id against the session's own references.
  read_attachment: "read",
  // Host-owned web tools (#3685): the host's executor reads the web; nothing
  // the agent owns changes.
  web_search: "read", fetch_content: "read", get_search_content: "read", source_check: "read",
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
  // turn_temp reaches only the worker's own /tmp; an approved policy proposal writes governance.md (#2801).
  turn_temp: "read", propose_policy_change: "mutate",
};

/**
 * Tools that run WITHOUT an approval card, mirroring the Claude backend's
 * DEFAULT_ALLOWED_TOOLS posture: every curated tool is auto-allowed except
 * `brain_archive` (a visibility change — see the shared confirm-pattern
 * rationale), and destructive bash shapes still confirm via
 * DEFAULT_CONFIRM_BASH_PATTERNS inside the tool_call gate.
 *
 * The host-owned web tools run prompt-free like Claude's WebSearch /
 * WebFetch. `subagent` stays listed for an operator who turns extension
 * discovery back on; any OTHER extension-registered tool (e.g. a third-party
 * MCP server through pi-mcp-adapter) raises an approval card, exactly like a
 * non-allowlisted MCP tool does on the Claude backend.
 */
export const DEFAULT_PI_ALLOWED_TOOLS: readonly string[] = [
  "read_file",
  "grep",
  "brain_search",
  "brain_context",
  "brain_read",
  "brain_read_base",
  "brain_list",
  "brain_graph",
  "brain_read_many",
  "brain_add",
  "brain_update",
  "write_file",
  "edit_file",
  "bash",
  ...BRIDGE_TOOL_POSTURE.allowedTools("pi"),
  // Apify (#3162): the host decides every call and asks per exact run; a tool
  // card would add a rememberable grant that authorizes nothing.
  ...Object.values(APIFY_TOOL_NAMES),
  // Attachment reads (#3154): the host authorizes each id against the
  // session's own references; a card would ask to read what the user sent.
  "read_attachment",
  // The host-owned web tools (#3685), parity with Claude's auto-allowed
  // WebSearch/WebFetch: the host binds and bounds every call.
  ...WEB_TOOL_NAME_LIST,
  // pi-subagents (recommended fan-out extension) — parity with Claude's
  // auto-allowed Agent tool. NOTE: a child agent's own tool calls run inside
  // pi's child session with that agent's declared tools, NOT through this
  // backend's gate — same trust domain as Claude's subagents, minus the
  // bash confirm patterns. Delegation itself is the reviewed act.
  "subagent",
];

export { PI_BRAIN_UPDATE_TOOL_NAME } from "./tool-kit.js";

/** Name of pi's tappable-choice tool — also stated in the agent surface brief. From its contract, not a roster position (#2800). */
export const PI_ASK_USER_TOOL_NAME = ASK_USER_TOOL_NAME;

/**
 * The curated roster in its provider-facing order: the file and brain tools,
 * the host's bridge tools, then each application operation routed to the
 * server (replacing the legacy tool of the same name) and `brain_read_base`.
 */
export function createBrainTools(deps: BrainToolDeps): ToolDefinition[] {
  const kit = createBrainToolKit(deps);
  const tools: ToolDefinition[] = [
    readFileTool(kit),
    grepTool(kit),
    brainSearchTool(kit),
    brainContextTool(kit),
    brainReadTool(kit),
    brainListTool(kit),
    brainGraphTool(kit),
    brainReadManyTool(kit),
    writeFileTool(kit),
    editFileTool(kit),
    bashTool(kit),
    brainAddTool(kit),
    brainUpdateTool(kit),
    brainArchiveTool(kit),
    ...createPiBridgeTools({
      brainPath: deps.brain.root,
      turn: deps.turn,
      capabilities: deps.capabilities,
    }),
  ];
  const routed = routedApplicationTools(kit, tools);
  const readBase = brainReadBaseTool(kit);
  return [...tools.filter(t => !routed.some(r => r.name === t.name)), ...routed, readBase];
}
