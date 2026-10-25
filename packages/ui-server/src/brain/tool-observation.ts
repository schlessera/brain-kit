/**
 * What a completed call's proven execution path lets the journal skip (#2834).
 * The classification and its completeness argument are in
 * docs/decisions/governed-writable-workers.md ("Per-result observation schedule").
 */
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

export type ToolExecutionPath = Parameters<NonNullable<StartTurnRequest["toolExecution"]>>[1];

/**
 * - `read`: proven to change nothing in the brain root and to leave nothing
 *   running; its result needs no observation of its own.
 * - `write`: may have changed the brain root, but only before its result; it
 *   is observed after it.
 * - `unproven`: anything else. It is observed after its result, and its turn
 *   may still be writing in the background until it ends.
 */
export type ToolObservation = "read" | "write" | "unproven";

/**
 * Host bridge handlers that read only host-private state (the UI database,
 * Activity, a Git object) or ask the client, and write nothing in the brain
 * root. None of them reads the index, so no index barrier flushes before them.
 */
const HOST_READS: ReadonlySet<string> = new Set(["brain_read_base", "query_activity", "inbox_list", "inbox_get", "show_block",
  "ask_user", "ask_user_list", "ask_user_rank", "ask_user_form", "get_current_location"]);

/**
 * Host bridge handlers that write, all before their result returns: the
 * application route (strict `write_file` and `edit_file` too), inbox, mask,
 * policy and reference tools. Evidence for any other name, whatever the
 * backend reports, proves nothing about what the call ran.
 */
const HOST_WRITES: ReadonlySet<string> = new Set(["brain_add", "brain_update", "brain_archive", "apply_staged_changes", "write_file", "edit_file",
  "inbox_add", "resolve_action", "complete_share", "request_image_mask", "propose_policy_change", "reference_source", "reference_worktree"]);

export function toolObservation(name: string | null, path: ToolExecutionPath | undefined): ToolObservation {
  if (name === null || path === undefined) return "unproven";
  if (path === "host_bridge") return HOST_READS.has(name) ? "read" : HOST_WRITES.has(name) ? "write" : "unproven";
  if (path === "worker_read") return name === "read_file" ? "read" : "unproven";
  return name === "write_file" || name === "edit_file" ? "write" : "unproven";
}
