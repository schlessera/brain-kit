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
 * `updatedInput` is re-checked against the shared policy first
 * (`checkEditedApproval`) and refused if it needs a confirmation the card did
 * not show; otherwise it mutates `event.input` in place (pi's documented
 * mechanism for patching tool arguments), so the edited input is what
 * executes.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  checkEditedApproval,
  createToolPermissionRequest,
  decideToolPermission,
  isCompletedAutonomousToolCall,
} from "@schlessera/brain-ui-sdk/server";

import { compileWorkerCommandPolicy, denyWorkerCommand, requestPolicyPermission, prepareOutwardPlan, observeOutwardPlan, OUTWARD_VOICE_REFUSAL } from "@schlessera/brain-ui-sdk/internal";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
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
  const { turn } = options;
  return {
    name: "brain-permission-gate",
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        if (turn.signal?.aborted) return { block: true, reason: "Turn cancelled before tool admission." };
        if (isCompletedAutonomousToolCall(turn.autonomous, event.toolName, event.input))
          return { block: true, reason: "This call already completed before yielding; inspect its retained result instead of replaying it." };
        // The server route rechecks the exact operation, live principal,
        // membership and approval. Avoid a second runtime approval card.
        if (turn.bridge?.applyBrain && ["brain_add", "brain_update", "brain_archive", "write_file", "edit_file", "apply_staged_changes"].includes(event.toolName)) return undefined;
        const decision = await decidePiToolPermission(options, event.toolName, (event.input ?? {}) as Record<string, unknown>, event.toolCallId);
        if (decision.behavior === "deny") return { block: true, reason: decision.message || `Permission denied for ${event.toolName}.` };
        if (decision.updatedInput && event.input && typeof event.input === "object") {
          // In-place mutation is pi's runtime contract for patching tool
          // arguments. Claude must instead return a structural updatedInput;
          // this runtime-specific difference deliberately stays in the binding.
          // The tool then executes with the patched arguments, so its lock key
          // is taken from the edited input.
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

/** Host admission shared by the native worker RPC and the in-process binding. */
export async function decidePiToolPermission(options: PermissionGateOptions, toolName: string,
  input: Record<string, unknown>, toolUseId: string): Promise<PermissionDecision> {
  const { turn, allowedTools } = options;
  const policy = compileWorkerCommandPolicy(turn.autonomous ? undefined : turn.commandPolicy);
  const outward = (value: unknown) => prepareOutwardPlan({ toolName, shellToolName: "bash", input: value,
    allow: turn.commandPolicy?.outwardAllow, autonomous: Boolean(turn.autonomous), voice: turn.posture === "voice", configurationRoot: turn.configurationRoot });
  const observe = (value: unknown, decision: Parameters<typeof observeOutwardPlan>[1]["decision"]) => observeOutwardPlan(outward(value), { bridge: turn.bridge, toolName, input: value, toolUseId, decision });
  const denied = denyWorkerCommand(policy, { bridge: turn.bridge, toolName, shellToolName: "bash", input, toolUseId });
  if (denied) { observeOutwardPlan(prepareOutwardPlan({ toolName, shellToolName: "bash", input, autonomous: Boolean(turn.autonomous) }), { bridge: turn.bridge, toolName, input, toolUseId, decision: "refused" }); return { behavior: "deny", message: denied }; }
  if (turn.signal?.aborted) return { behavior: "deny", message: "Turn cancelled before tool admission." };
  const outwardPlan = outward(input);
  const confirmPatterns = [...options.confirmPatterns, ...policy.confirm, ...(outwardPlan.pattern ? [outwardPlan.pattern] : [])];
  if (outwardPlan.voiceRefusal) { observe(input, "refused"); return { behavior: "deny", message: OUTWARD_VOICE_REFUSAL }; }
  let effective = input;
  // Per-use confirmation precedes any rememberable tool grant, including bash
  // omitted from an operator's allowlist. Neither card can answer the other.
  const commandAllowed = new Set(allowedTools); commandAllowed.add("bash");
  const perUse = decideToolPermission({ toolName, shellToolName: "bash", updateToolName: PI_BRAIN_UPDATE_TOOL_NAME,
    input, allowedTools: commandAllowed, confirmPatterns });
  const approvals = [perUse?.kind === "command" ? perUse : null,
    !allowedTools.has(toolName) ? decideToolPermission({ toolName, shellToolName: "bash", updateToolName: PI_BRAIN_UPDATE_TOOL_NAME,
      input, allowedTools, confirmPatterns }) : null];
  for (const approval of approvals) {
    if (!approval) continue;
    const original = effective;
    const request = createToolPermissionRequest({ toolUseId, toolName, input: original, description: approval.reason,
      approval, outsideEnforcedAllowlist: turn.enforceAllowedTools && approval.kind === "tool" });
    const decision = await requestPolicyPermission(policy, { bridge: turn.bridge, request, shellToolName: "bash",
      permission: { noGrantSurface: turn.noGrantSurface }, signal: turn.signal });
    if (decision.behavior === "deny") { observe(original, decision); return decision; }
    if (decision.updatedInput !== undefined) {
      const refusal = denyWorkerCommand(policy, { bridge: turn.bridge, toolName, shellToolName: "bash", input: decision.updatedInput, toolUseId }) ||
        checkEditedApproval({ toolName, shellToolName: "bash", updateToolName: PI_BRAIN_UPDATE_TOOL_NAME,
          confirmPatterns: [...confirmPatterns, ...(outward(decision.updatedInput).pattern ? [outward(decision.updatedInput).pattern!] : [])], originalInput: original, editedInput: decision.updatedInput });
      if (refusal) { observe(decision.updatedInput, "refused"); return { behavior: "deny", message: refusal }; }
      effective = decision.updatedInput;
    }
  }
  observe(effective, { behavior: "allow" });
  return effective === input ? { behavior: "allow" } : { behavior: "allow", updatedInput: effective };
}
