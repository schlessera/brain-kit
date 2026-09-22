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
 * - A `brain_update` that sets `status: "archived"` raises one too, for the
 *   same reason `brain_archive` is off the allowlist: it is the same
 *   visibility change, through a tool that is on it.
 * - Any tool NOT on the allowlist raises an approval card — the safe
 *   direction for third-party extension/MCP tools, and exactly how a
 *   non-allowlisted MCP tool behaves on the Claude backend.
 * - When the turn declared `enforceAllowedTools`, that card is marked
 *   `outsideEnforcedAllowlist` so the host decides it on its own merits
 *   instead of answering from a grant remembered under a wider posture.
 * - When the turn declared `noGrantSurface`, no card is raised at all: there
 *   is nothing that could answer one, so the shared gate refuses the request
 *   and the model is told why.
 *
 * A denial returns `{ block: true, reason }`, which pi feeds back to the
 * model as an error tool result — the turn survives. An approval with
 * `updatedInput` mutates `event.input` in place (pi's documented mechanism
 * for patching tool arguments), so the edited input is what executes.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  createToolPermissionRequest,
  decideToolPermission,
  requestToolPermission,
} from "@schlessera/brain-ui-sdk/server";

import type { TurnContext } from "./turn-context.js";
import { PI_BRAIN_UPDATE_TOOL_NAME } from "./tools.js";

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
  return (
    decideToolPermission({
      toolName,
      shellToolName: "bash",
      updateToolName: PI_BRAIN_UPDATE_TOOL_NAME,
      input,
      allowedTools,
      confirmPatterns,
    })?.reason ?? null
  );
}

export function createPermissionGate(options: PermissionGateOptions): InlineExtension {
  const { turn, allowedTools, confirmPatterns } = options;
  return {
    name: "brain-permission-gate",
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        const approval = decideToolPermission({
          toolName: event.toolName,
          shellToolName: "bash",
          updateToolName: PI_BRAIN_UPDATE_TOOL_NAME,
          input: event.input,
          allowedTools,
          confirmPatterns,
        });
        if (!approval) return undefined;

        const request = createToolPermissionRequest({
          toolUseId: event.toolCallId,
          toolName: event.toolName,
          input: (event.input ?? {}) as Record<string, unknown>,
          description: approval.reason,
          approval,
          // Kind "tool" here means exactly "not on `allowedTools`" — the
          // decision above was taken against the turn's real allowlist. Under
          // an enforced posture the host must not answer it from a grant
          // remembered on a wider one.
          outsideEnforcedAllowlist:
            turn.enforceAllowedTools && approval.kind === "tool",
        });
        const decision = await requestToolPermission(turn.bridge, request, {
          noGrantSurface: turn.noGrantSurface,
        });
        if (decision.behavior === "deny") {
          return {
            block: true,
            reason: decision.message || `Permission denied for ${event.toolName}.`,
          };
        }
        if (decision.updatedInput && event.input && typeof event.input === "object") {
          // In-place mutation is pi's runtime contract for patching tool
          // arguments. Claude must instead return a structural updatedInput;
          // this runtime-specific difference deliberately stays in the binding.
          //
          // The edit is applied as given and NOT re-run through
          // decideToolPermission, so an approval can redirect a confirmed call
          // — an archiving update approved against document A can execute
          // against document B, with the card having shown A. The Claude
          // backend cannot apply an edit at all from its hook and refuses one
          // instead, so the two backends genuinely differ here rather than
          // mirroring. #145 holds the question for both.
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
