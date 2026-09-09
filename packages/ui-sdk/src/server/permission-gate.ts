import type {
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
} from "./backend.js";
import { bashCommand } from "./confirm-patterns.js";

/** @experimental */
export interface ToolPermissionDecisionInput {
  toolName: string;
  /** Exact tool name this runtime uses for shell commands. */
  shellToolName: string;
  input: unknown;
  allowedTools: ReadonlySet<string>;
  confirmPatterns: readonly RegExp[];
}

/** @experimental */
export interface ToolPermissionApproval {
  kind: "tool" | "command";
  reason: string;
}

/**
 * Decide whether one tool call needs host approval.
 *
 * A tool outside the deployment allowlist needs a grantable tool approval. An
 * allowlisted bash command that matches a confirm pattern needs a per-use
 * command approval, which the host must never remember as a tool grant.
 * `shellToolName` is matched exactly because runtime tool names are
 * case-sensitive and may collide with extension-provided names.
 *
 * @experimental
 */
export function decideToolPermission(
  options: ToolPermissionDecisionInput
): ToolPermissionApproval | null {
  const { toolName, shellToolName, input, allowedTools, confirmPatterns } = options;
  if (!allowedTools.has(toolName)) {
    return {
      kind: "tool",
      reason: `Tool "${toolName}" is not auto-allowed in this deployment.`,
    };
  }
  if (toolName === shellToolName && confirmPatterns.length > 0) {
    const command = bashCommand(input);
    if (command && confirmPatterns.some((re) => re.test(command))) {
      return {
        kind: "command",
        reason: "This command matches a pattern configured to require confirmation.",
      };
    }
  }
  return null;
}

/** @experimental */
export interface CreateToolPermissionRequestInput {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string | undefined;
  approval: ToolPermissionApproval;
}

/**
 * Construct the host-facing request for a decision made by
 * {@link decideToolPermission}.
 *
 * `description` remains caller-supplied because runtimes differ: Claude
 * provides a richer SDK description for non-allowlisted tools, while pi uses
 * the shared policy reason. That is runtime presentation, not policy.
 *
 * @experimental
 */
export function createToolPermissionRequest(
  options: CreateToolPermissionRequestInput
): PermissionRequest {
  return {
    toolUseId: options.toolUseId,
    toolName: options.toolName,
    input: options.input,
    description: options.description,
    kind: options.approval.kind,
  };
}

/**
 * Ask the live turn bridge for approval, failing closed when there is no
 * bridge available to ask.
 *
 * @experimental
 */
export function requestToolPermission(
  bridge: Pick<BackendBridge, "requestPermission"> | null | undefined,
  request: PermissionRequest
): Promise<PermissionDecision> {
  if (!bridge) {
    return Promise.resolve({
      behavior: "deny",
      message: `No active turn to approve ${request.toolName}.`,
    });
  }
  return bridge.requestPermission(request);
}
