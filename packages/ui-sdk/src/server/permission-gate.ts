import type {
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
} from "./backend.js";
import {
  ARCHIVING_UPDATE_REASON,
  archivesDocument,
  bashCommand,
  type CompiledConfirmPattern,
} from "./confirm-patterns.js";

/** @experimental */
export interface ToolPermissionDecisionInput {
  toolName: string;
  /** Exact tool name this runtime uses for shell commands. */
  shellToolName: string;
  /**
   * Exact tool name this runtime uses for the brain document update tool, if
   * it exposes one. Runtimes spell it differently — `brain_update` as a
   * curated tool, `mcp__brain__brain_update` through the brain MCP server —
   * and it is matched exactly, for the same reason `shellToolName` is.
   */
  updateToolName?: string;
  input: unknown;
  allowedTools: ReadonlySet<string>;
  /** Plain RegExps work; one compiled with an effect names it (#112). */
  confirmPatterns: readonly CompiledConfirmPattern[];
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
 * allowlisted call that is destructive in its own right needs a per-use
 * command approval, which the host must never remember as a tool grant: a
 * bash command matching a confirm pattern, or a document update that
 * archives. `shellToolName` and `updateToolName` are matched exactly because
 * runtime tool names are case-sensitive and may collide with
 * extension-provided names.
 *
 * @experimental
 */
export function decideToolPermission(
  options: ToolPermissionDecisionInput
): ToolPermissionApproval | null {
  const { toolName, shellToolName, updateToolName, input, allowedTools, confirmPatterns } =
    options;
  if (!allowedTools.has(toolName)) {
    return {
      kind: "tool",
      reason: `Tool "${toolName}" is not auto-allowed in this deployment.`,
    };
  }
  if (toolName === shellToolName && confirmPatterns.length > 0) {
    const command = bashCommand(input);
    const matched = command ? confirmPatterns.find((re) => re.test(command)) : undefined;
    if (matched) {
      // The first matching pattern's effect, so the card says what will
      // happen. A deployment's bare-string pattern has none, and says only
      // that a rule matched.
      return {
        kind: "command",
        reason:
          matched.effect ?? "This command matches a pattern configured to require confirmation.",
      };
    }
  }
  if (updateToolName !== undefined && toolName === updateToolName && archivesDocument(input)) {
    return { kind: "command", reason: ARCHIVING_UPDATE_REASON };
  }
  return null;
}

/** @experimental */
export interface EditedApprovalCheckInput
  extends Omit<ToolPermissionDecisionInput, "input" | "allowedTools"> {
  /** The input the card showed. */
  originalInput: unknown;
  /** The input the approval came back with (`PermissionDecision.updatedInput`). */
  editedInput: unknown;
}

/**
 * The per-use confirmations one call needs, each named by what it confirms:
 * the command a confirm pattern matched, or the document an update archives.
 * Two inputs that produce the same name need the same confirmation. A
 * command's name carries its full text, not just the pattern: the pattern
 * names a kind of effect, and `brain archive a.md` and `brain archive b.md`
 * match the same one.
 */
function confirmationsFor(options: EditedApprovalCheckInput, input: unknown): string[] {
  const names: string[] = [];
  if (options.toolName === options.shellToolName) {
    const command = bashCommand(input);
    if (command) {
      for (const re of options.confirmPatterns) {
        if (re.test(command)) names.push(`pattern:${re.source}:${JSON.stringify(command)}`);
      }
    }
  }
  if (
    options.updateToolName !== undefined &&
    options.toolName === options.updateToolName &&
    archivesDocument(input)
  ) {
    names.push(`archive:${JSON.stringify((input as { path?: unknown }).path)}`);
  }
  return names;
}

/**
 * Re-check an approval that came back with an edited input, before the edit
 * is applied. Returns null when it may be applied, or the message to refuse
 * the call with.
 *
 * The card confirmed one input; an edit must not turn the approval into a
 * confirmation nobody gave. So {@link decideToolPermission} is run again on
 * the edited input, with the tool treated as allowed — a tool grant is a
 * property of the tool's name, which an edit cannot change, and treating it
 * as allowed is what exposes a per-use confirmation hiding behind a tool
 * card. An edit that needs no confirmation passes. One that does passes only
 * if every confirmation it needs was needed by the input the card showed: the
 * same command, the same archived document. Anything else — including a
 * narrower command on the same pattern — is refused whole, never applied in
 * part, and can be re-issued to be confirmed as it is.
 *
 * @experimental
 */
export function checkEditedApproval(options: EditedApprovalCheckInput): string | null {
  const needed = decideToolPermission({
    toolName: options.toolName,
    shellToolName: options.shellToolName,
    ...(options.updateToolName !== undefined ? { updateToolName: options.updateToolName } : {}),
    input: options.editedInput,
    allowedTools: new Set([options.toolName]),
    confirmPatterns: options.confirmPatterns,
  });
  if (!needed) return null;
  const shown = new Set(confirmationsFor(options, options.originalInput));
  if (confirmationsFor(options, options.editedInput).every((name) => shown.has(name))) {
    return null;
  }
  return (
    `The approval for ${options.toolName} changed its input into a call that needs a confirmation the card did not show, so it did not run. ` +
    `${needed.reason} Re-issue the call as you want it, so it can be confirmed as it is.`
  );
}

/** @experimental */
export interface CreateToolPermissionRequestInput {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string | undefined;
  approval: ToolPermissionApproval;
  /**
   * The turn declared `enforceAllowedTools` and this tool is not on its
   * allowlist. Computed by the binding rather than here: a runtime that
   * evaluates `decideToolPermission` against an empty allowlist on purpose
   * (the Claude backend's `canUseTool` does) cannot have it derived from the
   * arguments to this call.
   */
  outsideEnforcedAllowlist?: boolean;
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
    // Only when true: an explicit `false` would change the shape every
    // existing host and test asserts on for a turn that declared nothing.
    ...(options.outsideEnforcedAllowlist ? { outsideEnforcedAllowlist: true } : {}),
  };
}

/** @experimental */
export interface RequestToolPermissionOptions {
  /**
   * The turn declared `StartTurnRequest.noGrantSurface`: no card can be
   * answered, so the request is refused here rather than handed to a bridge
   * that would park it until the turn budget expires.
   */
  noGrantSurface?: boolean;
}

/**
 * What the model is told when a turn with no grant surface refuses a request.
 *
 * It names the tool, because the model has to know which call failed, and it
 * is written to be read aloud: no payload, no punctuation a listener has to
 * spell out, and the reason before the instruction.
 */
function noGrantSurfaceMessage(request: PermissionRequest): string {
  const what =
    request.kind === "command"
      ? `the ${request.toolName} call it wanted to confirm`
      : request.toolName;
  return (
    `This turn has no way to ask anyone for permission, so ${what} cannot be approved here and did not run. ` +
    "Carry on with what this turn already allows, or say what you needed and why."
  );
}

/**
 * Ask the live turn bridge for approval, failing closed when there is nobody
 * to ask — no bridge at all, or a turn that declared it has no grant surface.
 *
 * @experimental
 */
export function requestToolPermission(
  bridge: Pick<BackendBridge, "requestPermission" | "activity"> | null | undefined,
  request: PermissionRequest,
  options: RequestToolPermissionOptions = {}
): Promise<PermissionDecision> {
  if (options.noGrantSurface) {
    const message = noGrantSurfaceMessage(request);
    // Reported on the activity side channel because this decision never
    // reaches the host's requestPermission, which is where a user's denial is
    // recorded. Without it the span would close later as the backend's error
    // tool result — a call that errored rather than one that was denied.
    // Guarded: observability must not break the observed turn, and least of
    // all must a throwing reporter swallow the refusal it is reporting.
    try {
      bridge?.activity?.({
        kind: "permission_denied",
        toolUseId: request.toolUseId,
        requestKind: request.kind ?? "tool",
        reason: message,
      });
    } catch {
      // The decision stands whether or not anyone recorded it.
    }
    return Promise.resolve({ behavior: "deny", message });
  }
  if (!bridge) {
    return Promise.resolve({
      behavior: "deny",
      message: `No active turn to approve ${request.toolName}.`,
    });
  }
  return bridge.requestPermission(request);
}
