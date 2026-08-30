/**
 * The pi backend's permission gate: one `tool_call` handler, registered as an
 * inline extension on each session's resource loader, that fires before EVERY
 * tool execution — curated tools and extension-registered tools alike.
 *
 * It implements the same approval posture as the Claude backend:
 *
 * - Tools on the allowlist run with no round-trip (DEFAULT_PI_ALLOWED_TOOLS
 *   mirrors Claude's DEFAULT_ALLOWED_TOOLS: all curated tools except
 *   `brain_archive`, plus the recommended web extension's tools).
 * - A `bash` command matching a confirm pattern raises an approval card even
 *   though bash itself is allowlisted (destructive shapes: recursive delete,
 *   history rewrites, `brain archive`).
 * - Any tool NOT on the allowlist raises an approval card — the safe
 *   direction for third-party extension/MCP tools, and exactly how a
 *   non-allowlisted MCP tool behaves on the Claude backend.
 *
 * A denial returns `{ block: true, reason }`, which pi feeds back to the
 * model as an error tool result — the turn survives. An approval with
 * `updatedInput` mutates `event.input` in place (pi's documented mechanism
 * for patching tool arguments), so the edited input is what executes.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { bashCommand } from "@schlessera/brain-ui-sdk/server";

import type { TurnContext } from "./turn-context.js";

export interface PermissionGateOptions {
  /** The session's turn holder — the gate reads the CURRENT turn's bridge. */
  turn: TurnContext;
  /** Tool names that run without an approval card. */
  allowedTools: ReadonlySet<string>;
  /** Compiled confirm patterns for bash commands (may be empty). */
  confirmPatterns: readonly RegExp[];
}

/** Why a tool call needs approval, or null when it can run immediately. */
export function approvalReason(
  toolName: string,
  input: unknown,
  allowedTools: ReadonlySet<string>,
  confirmPatterns: readonly RegExp[]
): string | null {
  if (!allowedTools.has(toolName)) {
    return `Tool "${toolName}" is not auto-allowed in this deployment.`;
  }
  if (toolName === "bash" && confirmPatterns.length > 0) {
    const command = bashCommand(input);
    if (command && confirmPatterns.some((re) => re.test(command))) {
      return "This command matches a pattern configured to require confirmation.";
    }
  }
  return null;
}

export function createPermissionGate(options: PermissionGateOptions): InlineExtension {
  const { turn, allowedTools, confirmPatterns } = options;
  return {
    name: "brain-permission-gate",
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        const reason = approvalReason(
          event.toolName,
          event.input,
          allowedTools,
          confirmPatterns
        );
        if (!reason) return undefined;

        const bridge = turn.bridge;
        if (!bridge) {
          // A gated tool with no live turn has no one to ask. Refuse — the
          // safe direction — instead of running unapproved.
          return {
            block: true,
            reason: `No active turn to approve ${event.toolName}.`,
          };
        }

        const decision = await bridge.requestPermission({
          toolUseId: event.toolCallId,
          toolName: event.toolName,
          input: (event.input ?? {}) as Record<string, unknown>,
          description: reason,
          // An allowlisted tool that still needed approval hit a confirm
          // pattern (bash) — a per-use confirmation the host must never
          // remember. A non-allowlisted tool is a grantable "tool" request.
          kind: allowedTools.has(event.toolName) ? "command" : "tool",
        });
        if (decision.behavior === "deny") {
          return {
            block: true,
            reason: decision.message || `Permission denied for ${event.toolName}.`,
          };
        }
        if (decision.updatedInput && event.input && typeof event.input === "object") {
          // In-place mutation is pi's contract for patching tool arguments.
          const target = event.input as Record<string, unknown>;
          for (const key of Object.keys(target)) {
            if (!(key in decision.updatedInput)) delete target[key];
          }
          Object.assign(target, decision.updatedInput);
        }
        return undefined;
      });
    },
  };
}
