/**
 * Server-owned authority for exact operations that a human decision may
 * approve (#689). The predicate is evaluated fresh at escalation, resolution
 * and follow-up dispatch. A stored option, checkpoint fact or model proposal
 * only names a candidate; it never supplies the envelope that admits it.
 */
import type { Database } from "bun:sqlite";
import type { InboxOperation, InboxThread } from "@schlessera/brain-ui-sdk/protocol";
import { inboxOperationSchema } from "@schlessera/brain-ui-sdk/schemas";
import { BRAIN_APPLICATION_TOOLS, brainApplicationInput, type BrainApplicationOperation } from "@schlessera/brain-ui-sdk/server";

/** Non-destructive single-document operations an approval may name in v1. */
const FIRST_PARTY = ["claude", "pi"] as const;
const APPROVABLE = ["write", "edit", "add", "update"] as const satisfies readonly BrainApplicationOperation[];
/** A decision carries its exact proposal; larger effects need fresh intake. */
export const INBOX_OPERATION_MAX_BYTES = 65_536;

/** The runtime name of a hosted application tool for one first-party backend. */
export function applicationToolName(backendId: string, operation: BrainApplicationOperation): string {
  const name = BRAIN_APPLICATION_TOOLS[operation];
  return backendId === "claude" ? `mcp__brain-ui__${name}` : name;
}

/** The application operation a runtime tool name denotes, or null. */
export function applicationOperationOf(backendId: string, toolName: string): BrainApplicationOperation | null {
  for (const operation of Object.keys(BRAIN_APPLICATION_TOOLS) as BrainApplicationOperation[])
    if (applicationToolName(backendId, operation) === toolName) return operation;
  return null;
}

function policyOrHidden(path: string): boolean {
  const parts = path.split("/");
  // R35/R33: no agent effect reaches policies; dot directories hold staging,
  // Git and runtime configuration, which are never a decision's target.
  return parts.some(part => part.startsWith(".")) ||
    (parts[0]?.toLowerCase() === "context" && parts[1]?.toLowerCase() === "policies");
}

/**
 * Whether `operation` is inside the current server envelope for `backendId`:
 * one supported non-destructive application tool, its exact schema-valid
 * input, and a bounded Markdown target that the input itself names.
 */
export function inboxOperationAllowed(backendId: string, operation: InboxOperation): boolean {
  const parsed = inboxOperationSchema.safeParse(operation);
  if (!parsed.success) return false;
  const kind = applicationOperationOf(backendId, operation.toolName);
  if (!kind || !(APPROVABLE as readonly string[]).includes(kind)) return false;
  if (Buffer.byteLength(JSON.stringify(operation.input), "utf8") > INBOX_OPERATION_MAX_BYTES) return false;
  const input = brainApplicationInput.safeParse(operation.input);
  if (!input.success || input.data.operation !== kind) return false;
  const data = input.data;
  if (data.operation === "update" && data.status === "archived") return false;
  const target = data.operation === "add" ? data.target : "path" in data ? data.path : undefined;
  return target === operation.targetPath && operation.targetPath.endsWith(".md") && !policyOrHidden(operation.targetPath);
}

/** The exact operation a captured application proposal names, or null. */
export function inboxOperationFor(backendId: string, toolName: string, input: Record<string, unknown>): InboxOperation | null {
  const kind = applicationOperationOf(backendId, toolName);
  if (!kind) return null;
  const parsed = brainApplicationInput.safeParse(input);
  if (!parsed.success) return null;
  const data = parsed.data;
  const targetPath = data.operation === "add" ? data.target : "path" in data ? data.path : undefined;
  if (typeof targetPath !== "string") return null;
  const operation = { toolName, input: JSON.parse(JSON.stringify(input)) as Record<string, unknown>, targetPath };
  return inboxOperationAllowed(backendId, operation) ? operation : null;
}

/**
 * The resolver's current envelope for a thread: candidates named by the
 * thread's open decisions, admitted only by the fresh predicate above.
 */
export function createInboxOperationEnvelope(db: Database) {
  return (_principalId: string, thread: InboxThread): readonly InboxOperation[] => {
    const rows = db.query(`SELECT c.options_json FROM inbox_action_contexts c JOIN inbox_items i ON i.id = c.item_id
      WHERE i.thread_id = ? AND i.deleted_at IS NULL AND i.queue = 'actions' AND i.status IN ('pending', 'snoozed', 'resolved')`)
      .all(thread.id) as { options_json: string }[];
    const operations: InboxOperation[] = [];
    for (const row of rows) for (const option of JSON.parse(row.options_json) as { effect?: { kind?: string; payload?: { operation?: InboxOperation } } }[]) {
      const operation = option.effect?.kind === "enqueue" ? option.effect.payload?.operation : undefined;
      // The hosted tool name determines its first-party runtime; dispatch
      // rechecks the operation against the backend actually selected.
      if (operation && FIRST_PARTY.some(id => inboxOperationAllowed(id, operation))) operations.push(operation);
    }
    return operations;
  };
}
