import { toolAvailabilityRefusal } from "./tool-availability.js";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { createWorkerFileObserver, NativeFileVersions, WORKER_AREA_ROOT, type ObservedWorkerFile } from "@schlessera/brain-ui-sdk/internal";
import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { type AdmissionSafetySnapshot, type CompiledWorkerCommandPolicy, compileWorkerCommandPolicy, denyWorkerCommand, requestPolicyPermission, prepareOutwardPlan, commitOutwardPlan, safetyAdmissionRefusal, observeOutwardPlan, OUTWARD_VOICE_REFUSAL } from "@schlessera/brain-ui-sdk/internal";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import {
  checkEditedApproval,
  createToolPermissionRequest,
  decideToolPermission,
  requestToolPermission,
  isCompletedAutonomousToolCall,
} from "@schlessera/brain-ui-sdk/server";

import {
  BRAIN_UPDATE_TOOL,
  lockKeyForTool,
  MUTATING_TOOL_MATCHER,
} from "./tool-policy.js";
import type { TurnLockBinding } from "./turn-lock.js";
import { createAgentHook, createRtkHook } from "./input-rewrite-hooks.js";
import type { BackendLogFn } from "./options.js";

const NO_ALLOWED_TOOLS: ReadonlySet<string> = new Set();

/** Structural translation of a bridge PermissionDecision into the SDK's PermissionResult. */
function toPermissionResult(
  decision: Awaited<ReturnType<typeof requestToolPermission>>
): PermissionResult {
  if (decision.behavior === "allow") {
    // Omit updatedInput when the user approved unchanged so the SDK runs the
    // tool with its original input. Claude requires structural replacement;
    // pi's binding mutates in place.
    return decision.updatedInput !== undefined
      ? { behavior: "allow", updatedInput: decision.updatedInput }
      : { behavior: "allow" };
  }
  return { behavior: "deny", message: decision.message };
}

/** What one turn's permission wiring is built from (#2519). */
export interface PermissionWiringOptions {
  req: StartTurnRequest;
  /** Hosted strict/voice natives stay registered but cannot gain execution authority. */
  denyNativeWrites?: boolean;
  allowedTools: readonly string[];
  confirmPatterns: readonly RegExp[];
  brainPath: string;
  turnLock: TurnLockBinding;
  /** The filtered environment this turn's subprocesses run with. */
  childEnv: NodeJS.ProcessEnv;
  /** Optional rewrite proven against this live worker, never the host PATH. */
  rewriteRtk?: (command: string) => Promise<string>;
  /** Where a withheld re-admission is recorded. */
  log: BackendLogFn;
  /** Host-held actual startup view, never worker-supplied authority. */
  configurationRoot?: () => string | undefined;
  /** Trusted host ledger and limits; never copied to worker initialization. */
  maintenance?: import("@schlessera/brain-ui-sdk/internal").MaintenanceHost;
  fileVersions?: NativeFileVersions;
  observeFile?: (path: string) => ObservedWorkerFile | undefined;
}

/**
 * A tool the enforced allowlist left out (StartTurnRequest.enforceAllowedTools):
 * no shortcut may admit it. Neither a rewrite hook's auto-allow nor a grant the
 * host remembered on a wider posture answers it; it needs its own decision.
 */
export function outsideEnforcedAllowlist(enforced: boolean, allowed: ReadonlySet<string>, toolName: string): boolean {
  return enforced && !allowed.has(toolName);
}

/**
 * The allowlist the PreToolUse confirmation gate evaluates against.
 *
 * PreToolUse historically checks confirm patterns even when a deployment
 * removes Bash from its allowlist (canUseTool then performs the tool grant).
 * Model that hook path as command-allowed to preserve the two runtime gates.
 *
 * BRAIN_UPDATE_TOOL is here for the same reason, and the reason is sharper:
 * the fallback card from canUseTool is kind "tool", which a remembered
 * "always allow" answers without showing anything (ws/bridge.ts refuses to
 * do that only for kind "command"). Without this line, a deployment that
 * NARROWED its allowlist would lose the archiving confirmation entirely
 * after one such grant — the tool removed from the allowlist behaving more
 * permissively than the tool left on it, which is the shape of #124.
 */
export function commandGateTools(allowed: Iterable<string>): Set<string> {
  const commandAllowed = new Set(allowed);
  commandAllowed.add("Bash");
  commandAllowed.add(BRAIN_UPDATE_TOOL);
  commandAllowed.add("mcp__brain__brain_update");
  return commandAllowed;
}

type PolicyDecision = Awaited<ReturnType<typeof requestPolicyPermission>>;

/**
 * The per-use command decision answers the tool grant as well only for a tool
 * the turn allowlisted; anything else still needs its own grantable card.
 */
export function reusablePerUseDecision(perUse: PolicyDecision | undefined, allowed: ReadonlySet<string>, toolName: string): PolicyDecision | undefined {
  return perUse && allowed.has(toolName) ? perUse : undefined;
}

/** A grant that kept the input a per-use approval edited still applies that edit. */
export function carryPerUseEdit(decision: PolicyDecision, perUse: PolicyDecision | undefined, input: Record<string, unknown>): PolicyDecision {
  return decision.behavior === "allow" && decision.updatedInput === undefined && perUse?.behavior === "allow" && perUse.updatedInput !== undefined
    ? { behavior: "allow", updatedInput: input } : decision;
}

/** Native file observation: refusing a stale write, and recording what a read or write saw. */
export function createNativeFileGuards(options: PermissionWiringOptions) {
  const { req, brainPath } = options;
  const fileVersions = options.fileVersions ?? new NativeFileVersions();
  const legacyObserve = req.workerSandbox?.profile === "governed" ? createWorkerFileObserver({ brain: brainPath, configurationRoot: brainPath, areas: [], maskPaths: req.workerSandbox.maskPaths }) : undefined;
  const filePath = (toolName: string, input: unknown): string | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const value = input as Record<string, unknown>;
    const path = toolName === "NotebookEdit" ? value.notebook_path : value.file_path;
    return typeof path === "string" ? path : undefined;
  };
  const observation = (path: string): ObservedWorkerFile | undefined => {
    const result = (options.observeFile ?? legacyObserve)?.(path);
    if (result) return result;
    const absolute = resolve(brainPath, path), rel = relative(brainPath, absolute);
    if (rel && rel !== ".." && !rel.startsWith("../")) return { key: rel, version: { status: "unavailable" } };
    for (const area of req.workerSandbox?.areas ?? []) {
      const alias = resolve(WORKER_AREA_ROOT, area.name), suffix = relative(alias, absolute);
      if (suffix && suffix !== ".." && !suffix.startsWith("../")) return { key: `${area.rel}/${suffix}`, version: { status: "unavailable" } };
    }
    return undefined;
  };
  const nativeRefusal = async (toolName: string, input: unknown): Promise<string | null> => {
    if (req.autonomous || !["Write", "Edit", "NotebookEdit"].includes(toolName)) return null;
    const path = filePath(toolName, input), current = path ? observation(path) : undefined;
    if (!current) return null;
    const refusal = fileVersions.check(current.key, current.version);
    if (refusal) return refusal;
    try { await fileVersions.beginWrite(current.key); }
    catch { return "The host could not retain this write observation. Nothing was written; retry when host storage is available."; }
    return null;
  };
  const beginNativeRead: HookCallback = async hookInput => {
    if (req.autonomous || req.signal.aborted || hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "Read") return { continue: true };
    const path = filePath(hookInput.tool_name, hookInput.tool_input), current = path ? observation(path) : undefined;
    if (current) {
      try { await fileVersions.beginRead(hookInput.tool_use_id, current.key, current.version); }
      catch { return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: "The host could not retain this read observation. Nothing was read; retry when host storage is available." } }; }
    }
    return { continue: true };
  };
  const finishNativeFile: HookCallback = async hookInput => {
    if (req.autonomous || (hookInput.hook_event_name !== "PostToolUse" && hookInput.hook_event_name !== "PostToolUseFailure")) return { continue: true };
    const path = filePath(hookInput.tool_name, hookInput.tool_input), current = path ? observation(path) : undefined;
    if (hookInput.tool_name === "Read") {
      await fileVersions.finishRead(hookInput.tool_use_id, current?.version ?? { status: "unavailable" }, hookInput.hook_event_name === "PostToolUse" && !req.signal.aborted && ["text", "image", "notebook", "pdf", "parts"].includes((hookInput.tool_response as { type?: string } | null)?.type ?? ""));
    } else if (current && hookInput.hook_event_name === "PostToolUse" && ["Write", "Edit", "NotebookEdit"].includes(hookInput.tool_name)) {
      const response = hookInput.tool_response as { content?: unknown; originalFile?: unknown; oldString?: unknown; newString?: unknown; replaceAll?: unknown; staged?: unknown } | null;
      if (response?.staged === true) return { continue: true };
      // The installed native Write/Edit response names the bytes it wrote.
      // Do not substitute a newer peer version observed after its result.
      let written: string | undefined;
      if (hookInput.tool_name === "Write" && typeof response?.content === "string") written = response.content;
      if (hookInput.tool_name === "Edit" && typeof response?.originalFile === "string" && typeof response.oldString === "string" && typeof response.newString === "string") {
        if (response.originalFile.includes(response.oldString)) written = response.replaceAll ? response.originalFile.replaceAll(response.oldString, response.newString) : response.originalFile.replace(response.oldString, response.newString);
      }
      if (written !== undefined) await fileVersions.remember(current.key, createHash("sha256").update(written, "utf8").digest("hex"));
      else await fileVersions.finishWrite(current.key, current.version);
    }
    return { continue: true };
  };
  return { nativeRefusal, beginNativeRead, finishNativeFile };
}

/** Everything the permission callbacks below share for one turn. */
export type PermissionContext = ReturnType<typeof createPermissionContext>;

export function createPermissionContext(options: PermissionWiringOptions, nativeRefusal: (toolName: string, input: unknown) => Promise<string | null>) {
  const { req, allowedTools, brainPath, turnLock, log } = options;
  const nativeAuthorityRefusal = (name: string): string | undefined =>
    options.denyNativeWrites && ["Write", "Edit", "NotebookEdit"].includes(name)
      ? "Native file writes are unavailable in this turn's profile or voice posture. Use the permitted server application tools instead."
      : undefined;
  const commandPolicy: CompiledWorkerCommandPolicy = compileWorkerCommandPolicy(req.autonomous ? undefined : req.workerSandbox?.commandPolicy);
  const confirmPatterns = [...options.confirmPatterns, ...commandPolicy.confirm];
  const outward = (toolName: string, input: unknown) => prepareOutwardPlan({ toolName, shellToolName: "Bash", input,
    allow: req.workerSandbox?.commandPolicy?.outwardAllow, taint: req.workerSandbox?.commandPolicy?.taint, safety: req.bridge.admissionSafety, autonomous: Boolean(req.autonomous), voice: req.posture === "voice",
    configurationRoot: options.configurationRoot?.() ?? (req.workerSandbox?.profile === "governed" ? brainPath : undefined), maskPaths: req.workerSandbox?.maskPaths, maintenance: options.maintenance });
  const observe = (plan: ReturnType<typeof outward>, toolName: string, input: unknown, toolUseId: string,
    decision: Parameters<typeof observeOutwardPlan>[1]["decision"]) => observeOutwardPlan(plan, { bridge: req.bridge, toolName, input, toolUseId, decision });
  // Only a host-completed per-use admission, with exact input identity, may
  // suppress the same command card when the runtime subsequently asks for its
  // separate tool grant. Never borrowed across turns, retries or edited input.
  const shownOutward = new Map<string, string>();
  const denyCommand = (toolName: string, input: unknown, toolUseId: string) => {
    const refusal = backgroundBashRefusal(toolName, input) ?? denyWorkerCommand(commandPolicy, { bridge: req.bridge, toolName, shellToolName: "Bash", input, toolUseId });
    if (refusal) observe(prepareOutwardPlan({ toolName, shellToolName: "Bash", input, taint: req.workerSandbox?.commandPolicy?.taint, autonomous: Boolean(req.autonomous) }), toolName, input, toolUseId, "refused");
    return refusal;
  };
  const allowed = new Set(allowedTools);
  const updateName = (name: string) => name === "mcp__brain__brain_update" ? name : BRAIN_UPDATE_TOOL;
  const routed = (name: string) => Boolean(req.bridge.applyBrain) && ["brain_add", "brain_update", "brain_archive", "write_file", "edit_file", "apply_staged_changes"].some(tool => name === `mcp__brain-ui__${tool}`);
  // The turn declared its allowlist is a boundary, not merely an auto-allow
  // list (StartTurnRequest.enforceAllowedTools). Everything below that would
  // otherwise admit a tool WITHOUT a permission decision is evaluated against
  // this first — the two rewrite hooks here, and the host's remembered-grant
  // lookup, which is told through the request rather than guessed at.
  const enforced = req.enforceAllowedTools === true;
  // Nothing in this turn can answer a card (StartTurnRequest.noGrantSurface),
  // so every request the paths below raise is refused where it is raised
  // rather than put to the bridge, which would park it until the turn budget
  // expires. Passed to the shared gate rather than decided here: both request
  // kinds go through it, and the refusal is the same fact in both.
  const permissionOptions = { noGrantSurface: req.noGrantSurface === true };
  const withheld = (toolName: string): void => {
    log("warn", "allowlist enforced: withheld an input-rewrite auto-allow", {
      "tool.name": toolName,
    });
  };
  const commandAllowed = commandGateTools(allowed);

  /** Re-run the shared policy on an approval's edited input (#145). */
  const recheckEdit = (
    toolName: string,
    originalInput: unknown,
    editedInput: unknown,
    toolUseId: string
  ): string | null => {
    const denied = denyCommand(toolName, editedInput, toolUseId);
    if (denied) return denied;
    const originalPlan = outward(toolName, originalInput), editedPlan = outward(toolName, editedInput);
    if (editedPlan.voiceRefusal) { observe(editedPlan, toolName, editedInput, toolUseId, "refused"); return OUTWARD_VOICE_REFUSAL; }
    const refusal = checkEditedApproval({
      toolName,
      shellToolName: "Bash",
      updateToolName: updateName(toolName),
      confirmPatterns: [...confirmPatterns, ...[originalPlan.pattern, editedPlan.pattern].filter(pattern => pattern !== undefined)],
      originalInput,
      editedInput,
    });
    if (refusal) {
      observe(editedPlan, toolName, editedInput, toolUseId, "refused");
      log("warn", "approval edited into a call its card did not confirm; refused", {
        "tool.name": toolName,
      });
    }
    return refusal;
  };
  return { req, brainPath, turnLock, log, nativeAuthorityRefusal, nativeRefusal, commandPolicy, confirmPatterns, outward, observe,
    shownOutward, denyCommand, allowed, updateName, routed, enforced, permissionOptions, withheld, commandAllowed, recheckEdit };
}

// DO NOT WEAKEN THIS INTO A FALLTHROUGH. Withholding OUR shortcuts is not
// enough: AT LEAST three things outside this file admit a tool before
// canUseTool is reached, so "it is off the allowlist, the callback will
// catch it" is false. Three is what has been measured, not a closed set —
// an ordinal here would go stale the next time someone probes. Each is
// measured against the runtime MEASURED_RUNTIME names (measured-runtime.ts),
// with an EMPTY allowedTools, by scripts/measure-claude-runtime.ts; what is
// NOT a bypass is recorded too, because guessing at this once already put a
// wrong mechanism here.
//
// 1. The runtime's safe-command classifier, on the command's SHAPE. `echo
//    hi` ran and the callback was never consulted; `touch <path>`, same
//    harness, went through it. Picking the wrong probe command hides this.
// 2. A built-in tool permitted without the callback at all. `ToolSearch`
//    executed twice with nothing on the allowlist and no hook registered.
// 3. A PreToolUse hook in the PROJECT SETTINGS this backend loads
//    (`settingSources: ["project"]` in sdk-options.ts) returning
//    `permissionDecision: "allow"`. That file lives in the brain repo,
//    which is the turn's cwd, and Write/Edit are on the default allowlist —
//    so a wide-posture turn can write it and re-widen every later narrow
//    one. Enforcement therefore cannot be a property of configuration.
//    It is a GRANTING vector only: an in-process PreToolUse deny still wins
//    over it, measured, so a hook that refuses cannot be talked out of it.
//
// What does NOT skip the callback, in those same project settings:
// `permissions.allow` rules, and `permissions.defaultMode:
// "bypassPermissions"`. Both were tried; canUseTool was still consulted.
//
// An explicit "ask" beats all three — measured for each, and for the
// settings hook with a canUseTool deny then holding — and it leaves another
// hook's updatedInput intact, so the rewrites still reach the decision.
// Allowlist escalation remains declaration-scoped. Interactive calls also
// receive unconditional availability refusals, including auto-allowed tools.
export function enforcementHookFor(ctx: PermissionContext): HookCallback {
  const { req, allowed, enforced } = ctx;
  return async (hookInput) => {
    const snapshot = req.bridge.admissionSafety?.read();
    if (hookInput.hook_event_name === "PreToolUse") {
      const unavailable = toolAvailabilityRefusal(req, hookInput.tool_name);
      if (unavailable) return { continue: true, hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: unavailable,
      } };
    }
    if (hookInput.hook_event_name === "PreToolUse" &&
      (req.signal.aborted || isCompletedAutonomousToolCall(req.autonomous, hookInput.tool_name, hookInput.tool_input))) {
      return { continue: true, hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: req.signal.aborted ? "Turn cancelled before tool admission." :
          "This call already completed before yielding; inspect its retained result instead of replaying it.",
      } };
    }
    // An index reader runs only once the host has indexed every application
    // committed before it; a failed update refuses it rather than serve stale results.
    const mutating = hookInput.hook_event_name === "PreToolUse" && !ctx.routed(hookInput.tool_name) && new RegExp(MUTATING_TOOL_MATCHER).test(hookInput.tool_name);
    if (hookInput.hook_event_name === "PreToolUse" && !mutating && req.bridge.awaitIndex) {
      try { await req.bridge.awaitIndex(hookInput.tool_name, hookInput.tool_input as Record<string, unknown> | undefined); }
      catch (error) {
        return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: error instanceof Error ? error.message : "The search index could not be brought up to date." } };
      }
    }
    if(hookInput.hook_event_name==="PreToolUse"&&!mutating&&req.bridge.inputSafety){
      try { await req.bridge.inputSafety.begin(hookInput.tool_use_id,hookInput.tool_name,hookInput.tool_input as Record<string,unknown>); }
      catch(error){return {continue:true,hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:error instanceof Error?error.message:"Safety recording unavailable"}};}
    }
    const stale = safetyAdmissionRefusal(req.bridge.admissionSafety, snapshot);
    if (stale) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stale } };
    if (
      hookInput.hook_event_name !== "PreToolUse" ||
      !outsideEnforcedAllowlist(enforced, allowed, hookInput.tool_name)
    ) {
      return { continue: true };
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Tool "${hookInput.tool_name}" is outside this turn's enforced allowlist, so it cannot run until someone decides it.`,
      },
    };
  };
}

/** The SDK callback for a call nothing auto-allowed: the grantable card, then the write lock. */
export function canUseToolFor(ctx: PermissionContext): NonNullable<Options["canUseTool"]> {
  const { req, brainPath, turnLock, nativeAuthorityRefusal, nativeRefusal, commandPolicy, confirmPatterns, outward, observe,
    shownOutward, denyCommand, allowed, routed, enforced, permissionOptions, recheckEdit } = ctx;
  return async (
    toolName,
    input,
    opts
  ) => {
    if (req.signal.aborted || isCompletedAutonomousToolCall(req.autonomous, toolName, input))
      return { behavior: "deny", message: "Cancelled or already completed autonomous call; no replay." };
    const nativeDenied = nativeAuthorityRefusal(toolName);
    if (nativeDenied) return { behavior: "deny", message: nativeDenied };
    const unavailable = toolAvailabilityRefusal(req, toolName);
    if (unavailable) return { behavior: "deny", message: unavailable };
    const denied = denyCommand(toolName, input, opts.toolUseID);
    if (denied) return { behavior: "deny", message: denied };
    if (routed(toolName)) return { behavior: "allow" };
    // The PreToolUse hook below may already hold the write lock for this tool
    // use (it fires before permission evaluation). Don't keep the lock across
    // the (possibly long) approval wait — release it now and re-acquire only
    // once the tool is actually approved.
    turnLock.releaseForTool(opts.toolUseID);
    const outwardPlan = outward(toolName, input);
    const snapshot = req.bridge.admissionSafety?.read();
    if (outwardPlan.voiceRefusal) { observe(outwardPlan, toolName, input, opts.toolUseID, "refused"); return { behavior: "deny", message: OUTWARD_VOICE_REFUSAL }; }
    const shown = shownOutward.get(opts.toolUseID) === JSON.stringify(input);
    shownOutward.delete(opts.toolUseID);
    let perUseDecision: Awaited<ReturnType<typeof requestPolicyPermission>> | undefined;
    if (outwardPlan.pattern && !shown) {
      const approval = { kind: "command" as const, reason: outwardPlan.pattern.effect! };
      const request = createToolPermissionRequest({ toolUseId: opts.toolUseID, toolName, input, description: approval.reason, approval });
      perUseDecision = await requestPolicyPermission(commandPolicy, { bridge: req.bridge, request, permission: permissionOptions, shellToolName: "Bash", signal: req.signal });
      if (perUseDecision.behavior === "deny") { observe(outwardPlan, toolName, input, opts.toolUseID, perUseDecision); return toPermissionResult(perUseDecision); }
      if (perUseDecision.updatedInput !== undefined) {
        const refusal = recheckEdit(toolName, input, perUseDecision.updatedInput, opts.toolUseID);
        if (refusal) return { behavior: "deny", message: refusal };
        input = perUseDecision.updatedInput;
      }
    }
    const approval = decideToolPermission({
      toolName,
      shellToolName: "Bash",
      input,
      // Reaching canUseTool is itself Claude's signal that this call was not
      // auto-allowed. Model that runtime fact explicitly so direct callback
      // invocation has the same behaviour as the SDK path.
      allowedTools: NO_ALLOWED_TOOLS,
      confirmPatterns,
    });
    // The empty runtime allowlist above always produces a tool approval.
    if (!approval) throw new Error("unreachable permission decision");
    const request = createToolPermissionRequest({
      toolUseId: opts.toolUseID,
      toolName,
      input,
      description: opts.description,
      approval,
      // The host answers this one on its own merits: reaching here means the
      // turn's allowlist left the tool out, and under enforcement a grant
      // remembered on a wider posture is not an answer to it.
      outsideEnforcedAllowlist: outsideEnforcedAllowlist(enforced, allowed, toolName),
    });
    const decision = carryPerUseEdit(reusablePerUseDecision(perUseDecision, allowed, toolName)
      ?? await requestPolicyPermission(commandPolicy, { bridge: req.bridge, request, permission: permissionOptions, shellToolName: "Bash", signal: req.signal }), perUseDecision, input);
    // An edit is re-checked before it is applied: the card was a grant for
    // the input it showed, and an edit into a call that needs a per-use
    // confirmation — one the PreToolUse hook raised for nothing, because it
    // saw the original — must not ride in on that grant.
    if (decision.behavior === "allow" && decision.updatedInput !== undefined) {
      const refusal = recheckEdit(toolName, input, decision.updatedInput, opts.toolUseID);
      if (refusal) return { behavior: "deny", message: refusal };
    }
    // A mutating tool runs inside this subprocess the moment we return
    // "allow", so take its lock BEFORE allowing and hold it until the tool's
    // result frame is observed (see the stream loop) or the turn ends. Denials
    // and lock-free tools take nothing. The approved input is what will
    // execute, so the key is computed from it.
    if (decision.behavior === "allow") {
      const effectiveInput = decision.updatedInput ?? input;
      const acquired = await turnLock.acquireForTool(
        opts.toolUseID,
        lockKeyForTool(toolName, effectiveInput, brainPath)
      );
      if (!acquired.ok) return { behavior: "deny", message: acquired.reason };
      const stale = await nativeRefusal(toolName, effectiveInput);
      if(!stale){try{await req.bridge.inputSafety?.begin(opts.toolUseID,toolName,effectiveInput);}catch(error){turnLock.releaseForTool(opts.toolUseID);return {behavior:"deny",message:error instanceof Error?error.message:"Safety recording unavailable"};}}
      if (stale) { turnLock.releaseForTool(opts.toolUseID); return { behavior: "deny", message: stale }; }
      const finalPlan = outward(toolName, effectiveInput);
      const refusal = commitOutwardPlan(finalPlan, { bridge: req.bridge, before: snapshot,
        approved: shown || outwardPlan.needsApproval && perUseDecision?.behavior === "allow", signal: req.signal });
      observe(finalPlan, toolName, effectiveInput, opts.toolUseID, refusal ? "refused" : decision);
      if (refusal) { turnLock.releaseForTool(opts.toolUseID); return { behavior: "deny", message: refusal }; }
    } else {
      observe(outward(toolName, input), toolName, input, opts.toolUseID, decision);
    }
    return toPermissionResult(decision);
  };
}

// The write lock CANNOT live in canUseTool alone: the SDK auto-allows every
// tool listed in `allowedTools` without invoking the callback (it warns
// CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and the default allowlist contains all
// mutating tools. PreToolUse fires before every tool execution — auto-allowed
// or approved — and the SDK awaits it, so acquiring here serializes writes
// across turns no matter which permission path admitted the tool.
export function mutatingHookFor(ctx: PermissionContext): HookCallback {
  const { req, brainPath, turnLock, nativeAuthorityRefusal, nativeRefusal, commandPolicy, confirmPatterns, outward, observe,
    shownOutward, denyCommand, updateName, routed, permissionOptions, commandAllowed, recheckEdit } = ctx;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }
    if (req.signal.aborted) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Turn cancelled before tool admission." } };
    const nativeDenied = nativeAuthorityRefusal(hookInput.tool_name);
    if (nativeDenied) return { continue: true, hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: nativeDenied,
    } };
    const unavailable = toolAvailabilityRefusal(req, hookInput.tool_name);
    if (unavailable) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: unavailable } };
    const denied = denyCommand(hookInput.tool_name, hookInput.tool_input, hookInput.tool_use_id);
    if (denied) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denied } };
    if (routed(hookInput.tool_name)) return { continue: true };
    // The registered matcher includes every brain MCP name. The classifier
    // decides the actual key, including null for named read-only tools.

    // Confirmation for an auto-allowed call that is destructive anyway: a Bash
    // command matching a configured pattern, or a brain_update that archives.
    // It happens HERE, not in canUseTool, because both tools are auto-allowed,
    // so canUseTool is never consulted for them — this hook is the only place
    // such a call is seen before it runs. The decision itself is the shared
    // one; this is just its runtime binding.
    //
    // Allowlisting is not the only reason it belongs here. This backend loads
    // the brain repo's project settings (`settingSources`, `sdk-options.ts:388`),
    // and a hook
    // declared in those can answer a call before canUseTool is reached at all
    // — #124 has the measurements. This hook fires either way. None of that
    // makes the confirmation containment: an agent that can write the repo
    // can always reach the same effect another way, which is the posture
    // DEFAULT_CONFIRM_BASH_PATTERNS states in full.
    //
    // Any OTHER call that is not auto-allowed yields kind "tool" here and is
    // left alone: canUseTool raises its grantable card, and asking twice for
    // one tool use would be worse than either card on its own. Bash and
    // brain_update are the two exceptions above, deliberately: for them a
    // narrowed allowlist gets both gates, because the grantable card alone is
    // rememberable and the per-use one is not.
    //
    // Asked BEFORE the lock is taken — a user deliberating for ten minutes
    // must not hold the write lock against every other session that whole time.
    const outwardPlan = outward(hookInput.tool_name, hookInput.tool_input);
    const snapshot = req.bridge.admissionSafety?.read();
    if (outwardPlan.voiceRefusal) {
      observe(outwardPlan, hookInput.tool_name, hookInput.tool_input, hookInput.tool_use_id, "refused");
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: OUTWARD_VOICE_REFUSAL } };
    }
    const approval = decideToolPermission({
      toolName: hookInput.tool_name,
      shellToolName: "Bash",
      updateToolName: updateName(hookInput.tool_name),
      input: hookInput.tool_input,
      allowedTools: commandAllowed,
      confirmPatterns: [...confirmPatterns, ...(outwardPlan.pattern ? [outwardPlan.pattern] : [])],
    });
    /** The input an approved edit replaced the call's with, if any. */
    let edited: Record<string, unknown> | undefined;
    if (approval?.kind === "command") {
      // A per-use confirmation, not a tool grant — the host must never
      // remember it as "always allow Bash" or "always allow brain_update".
      const request = createToolPermissionRequest({
        toolUseId: hookInput.tool_use_id,
        toolName: hookInput.tool_name,
        input: hookInput.tool_input as Record<string, unknown>,
        description: approval.reason,
        approval,
      });
      const decision = await requestPolicyPermission(commandPolicy, { bridge: req.bridge, request, permission: permissionOptions, shellToolName: "Bash", signal: req.signal });
      if (decision.behavior !== "allow") {
        observe(outwardPlan, hookInput.tool_name, hookInput.tool_input, hookInput.tool_use_id, decision);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.message ?? "Denied by the user.",
          },
        };
      }
      if (decision.updatedInput !== undefined) {
        // The host approved an EDITED call. The edit is put back through the
        // shared policy first: one that needs a confirmation this card did not
        // show is refused whole, so an approval cannot redirect the call it
        // confirmed.
        const refusal = recheckEdit(
          hookInput.tool_name,
          hookInput.tool_input,
          decision.updatedInput,
          hookInput.tool_use_id
        );
        if (refusal) {
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: refusal,
            },
          };
        }
        edited = decision.updatedInput;
      }
    }

    const finalInput = edited ?? hookInput.tool_input;
    // Only a card this hook actually showed answers canUseTool's: a policy
    // allowance is re-evaluated there, against taint recorded meanwhile (G6).

    // The input that will execute decides the key, as in canUseTool.
    const acquired = await turnLock.acquireForTool(
      hookInput.tool_use_id,
      lockKeyForTool(hookInput.tool_name, edited ?? hookInput.tool_input, brainPath)
    );
    if (!acquired.ok) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: acquired.reason,
        },
      };
    }
    const stale = await nativeRefusal(hookInput.tool_name, edited ?? hookInput.tool_input);
    if (stale) { turnLock.releaseForTool(hookInput.tool_use_id); return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stale } }; }
    try{await req.bridge.inputSafety?.begin(hookInput.tool_use_id,hookInput.tool_name,(edited??hookInput.tool_input) as Record<string,unknown>);}
    catch(error){turnLock.releaseForTool(hookInput.tool_use_id);return {continue:true,hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:error instanceof Error?error.message:"Safety recording unavailable"}};}
    if (req.bridge.awaitIndex) {
      try { await req.bridge.awaitIndex(hookInput.tool_name, finalInput as Record<string, unknown>); }
      catch (error) { turnLock.releaseForTool(hookInput.tool_use_id); return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: String(error) } }; }
    }
    const finalPlan = outward(hookInput.tool_name, finalInput);
    const approved = outwardPlan.needsApproval && approval?.kind === "command";
    const refusal = commitOutwardPlan(finalPlan, { bridge: req.bridge, before: snapshot, approved, signal: req.signal });
    observe(finalPlan, hookInput.tool_name, finalInput, hookInput.tool_use_id, refusal ? "refused" : { behavior: "allow" });
    if (refusal) { turnLock.releaseForTool(hookInput.tool_use_id); return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal } }; }
    if (approved) shownOutward.set(hookInput.tool_use_id, JSON.stringify(finalInput));
    if (edited !== undefined) {
      // Applied by returning `updatedInput` with NO permissionDecision. A
      // PreToolUse hook's rewrite takes effect without one — measured for #124
      // and #145, and re-measured against MEASURED_RUNTIME by
      // scripts/measure-claude-runtime.ts — so the edit gains no `allow`, and a tool the
      // turn's allowlist left out still goes on to canUseTool, which is then
      // consulted with the edited input. Do not add a decision here: an
      // `allow` skips canUseTool and would re-admit such a tool.
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: edited },
      };
    }
    return { continue: true };
  };
}

/** The Agent and RTK input rewrites, restricted so a rewrite cannot re-admit what the gates refused. */
function createRewriteHooks(ctx: PermissionContext, options: PermissionWiringOptions) {
  const { req, enforced, allowed, withheld, outward, commandPolicy, commandAllowed, confirmPatterns, recheckEdit } = ctx;
  // Runtime hooks see the original input in parallel. A completed receipt may
  // contain the foreground/RTK rewrite, so restrict that final form too: a
  // rewrite's auto-allow must not re-admit an already completed effect.
  const restrictRewrite = (hook: HookCallback, toolName: string): HookCallback => async (...args) => {
    const snapshot = req.bridge.admissionSafety?.read();
    const output = await hook(...args);
    const admissionRefusal = safetyAdmissionRefusal(req.bridge.admissionSafety);
    if (admissionRefusal) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: admissionRefusal } };
    if (req.signal.aborted) return { continue: true, hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Turn cancelled during input rewrite.",
    } };
    if ("hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      output.hookSpecificOutput.updatedInput !== undefined &&
      isCompletedAutonomousToolCall(req.autonomous, toolName, output.hookSpecificOutput.updatedInput)) {
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: "The rewritten call already completed before yielding; no replay." } };
    }
    if ("hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      output.hookSpecificOutput.updatedInput !== undefined && args[0].hook_event_name === "PreToolUse") {
      const refusal = recheckEdit(toolName, args[0].tool_input, output.hookSpecificOutput.updatedInput, args[0].tool_use_id);
      if (refusal) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal } };
      try{await req.bridge.inputSafety?.begin(args[0].tool_use_id,toolName,output.hookSpecificOutput.updatedInput as Record<string,unknown>);}
      catch(error){return {continue:true,hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:error instanceof Error?error.message:"Safety recording unavailable"}};}
      // Recording the rewritten input is another wait. Recompute its standing
      // authority afterwards; parallel hooks only checked the original input.
      const finalPlan = outward(toolName, output.hookSpecificOutput.updatedInput);
      const finalRefusal = commitOutwardPlan(finalPlan, { bridge: req.bridge, before: snapshot, approved: false, signal: req.signal });
      if (finalRefusal) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: finalRefusal } };
    }
    return output;
  };
  const agentHook = restrictRewrite(createAgentHook({
    mayGrant: !outsideEnforcedAllowlist(enforced, allowed, "Agent"),
    onGrantWithheld: withheld,
  }), "Agent");
  const rtkHook = restrictRewrite(createRtkHook(options.childEnv, {
    rewriteCommand: options.rewriteRtk,
    mayGrant: !outsideEnforcedAllowlist(enforced, allowed, "Bash"),
    onGrantWithheld: withheld,
    // A confirmed command belongs to mutatingHook, which may apply an edit
    // of it; rtk proxying is opportunistic and gives way.
    leaveAlone: (input) =>
      outward("Bash", input).classification.actions.length > 0 ||
      // Match without observing: mutatingHook owns the denial receipt.
      (typeof (input as { command?: unknown })?.command === "string" && commandPolicy.deny.some(pattern => pattern.test((input as { command: string }).command))) ||
      decideToolPermission({
        toolName: "Bash",
        shellToolName: "Bash",
        input,
        allowedTools: commandAllowed,
        confirmPatterns,
      })?.kind === "command",
  }), "Bash");
  return { agentHook, rtkHook };
}

export function createPermissionWiring(options: PermissionWiringOptions): Pick<Options, "canUseTool" | "hooks"> {
  const { req, turnLock } = options;
  const { nativeRefusal, beginNativeRead, finishNativeFile } = createNativeFileGuards(options);
  const ctx = createPermissionContext(options, nativeRefusal);
  const { enforced } = ctx;
  const enforcementHook = enforcementHookFor(ctx);
  // A deny this backend returns refuses the call's id at the collector, so
  // no later admission or allow under it succeeds. It discharges nothing:
  // the runtime can admit two calls under one id, and runs a bare
  // `allowedTools` entry or a rewrite hook's allow without asking, so a deny
  // never proves an admitted call did not run. Every call `begin()` admitted
  // stays owed until its result is recorded, whatever the runtime then
  // delivers (#3812).
  const refuse = async (toolUseId: string | undefined) => { if (toolUseId) await req.bridge.inputSafety?.refused?.(toolUseId).catch(() => {}); };
  const decideToolUse = canUseToolFor(ctx);
  // The callback's allow is the runtime's last gate: the call runs. The
  // collector checks it first; one it can no longer let run is denied
  // instead.
  const canUseTool: typeof decideToolUse = async (toolName, input, opts) => {
    const result = await decideToolUse(toolName, input, opts);
    if (result?.behavior === "deny") await refuse(opts.toolUseID);
    else if (result?.behavior === "allow" && req.bridge.inputSafety?.allowed) {
      try { await req.bridge.inputSafety.allowed(opts.toolUseID); }
      catch (error) {
        turnLock.releaseForTool(opts.toolUseID);
        await refuse(opts.toolUseID);
        return { behavior: "deny", message: error instanceof Error ? error.message : "Safety recording refused this call." };
      }
    }
    return result;
  };
  const mutatingHook = mutatingHookFor(ctx);
  const { agentHook, rtkHook } = createRewriteHooks(ctx, options);
  // Claude runs matching hooks in parallel. Every hook, including a read
  // observation or rewrite that finishes last, must fence its own final wait.
  // Outward gates still recompute standing/per-use authority in their bodies.
  const fence: (hook: HookCallback) => HookCallback = hook => async (...args) => {
    const output = await fenced(hook, args);
    if (args[0].hook_event_name === "PreToolUse" && "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse"
      && output.hookSpecificOutput.permissionDecision === "deny") await refuse(args[0].tool_use_id);
    return output;
  };
  async function fenced(hook: HookCallback, args: Parameters<HookCallback>): Promise<Awaited<ReturnType<HookCallback>>> {
    let snapshot: AdmissionSafetySnapshot | undefined;
    let output: Awaited<ReturnType<HookCallback>>;
    try {
      snapshot = req.bridge.admissionSafety?.read();
      output = await hook(...args);
    } catch (error) {
      if (args[0].hook_event_name === "PreToolUse") turnLock.releaseForTool(args[0].tool_use_id);
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: error instanceof Error ? error.message : "Host tool admission is unavailable." } };
    }
    const refusal = safetyAdmissionRefusal(req.bridge.admissionSafety, snapshot)
      ?? (req.signal.aborted || args[2].signal.aborted ? "Turn cancelled before tool admission." : null);
    if (refusal) {
      if (args[0].hook_event_name === "PreToolUse") turnLock.releaseForTool(args[0].tool_use_id);
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal } };
    }
    return output;
  }
  const safetyResult: HookCallback = async input => {
    if((input.hook_event_name==="PostToolUse"||input.hook_event_name==="PostToolUseFailure")&&req.bridge.inputSafety){
      const response=input.hook_event_name==="PostToolUse"?input.tool_response:input.error;
      const parts=response&&typeof response==="object"&&Array.isArray((response as {content?:unknown}).content)
        ? ((response as {content:{type?:string;text?:string}[]}).content).filter(part=>part.type==="text"&&typeof part.text==="string").map(part=>part.text!):undefined;
      try { await req.bridge.inputSafety.result(input.tool_use_id,input.tool_name,typeof response==="string"?response:JSON.stringify(response)??"",true,parts); }
      catch { return {continue:false,stopReason:"Safety input recording failed; stop before another provider request."}; }
    }
    return {continue:true};
  };

  return {
    canUseTool,
    hooks: {
      PreToolUse: [
        // First, and over every tool (no matcher): nothing the runtime would
        // otherwise wave through gets to skip the decision, including a
        // subagent's own tool calls, which surface here under their own names.
        // First rather than last because that is the order the merge was
        // measured in. Note that tests index this array positionally, so a
        // test for an enforced turn must match on the matcher, not the index.
        ...(enforced ? [{ hooks: [fence(enforcementHook)] }] : []),
        { matcher: MUTATING_TOOL_MATCHER, hooks: [fence(mutatingHook)] },
        { matcher: "^Agent$", hooks: [fence(agentHook)] },
        { matcher: "^Bash$", hooks: [fence(rtkHook)] },
        ...(!req.autonomous ? [{ matcher: "^Read$", hooks: [fence(beginNativeRead)] }] : []),
        ...(!enforced && (!req.autonomous || req.bridge.inputSafety) ? [{ hooks: [fence(enforcementHook)] }] : []),
      ],
      ...(!req.autonomous || req.bridge.inputSafety ? {
        PostToolUse: [...(!req.autonomous ? [{ matcher: "^(Read|Write|Edit|NotebookEdit)$", hooks: [finishNativeFile] }] : []),{ hooks: [safetyResult] }],
        PostToolUseFailure: [...(!req.autonomous ? [{ matcher: "^(Read|Write|Edit|NotebookEdit)$", hooks: [finishNativeFile] }] : []),{ hooks: [safetyResult] }],
      } : {}),
      PermissionDenied: [
        {
          // A deny decided outside canUseTool (settings deny rules, other
          // hooks) must still free a lock the PreToolUse hook took; our own
          // canUseTool deny releases up front.
          hooks: [
            async (_hookInput, toolUseID) => {
              if (toolUseID) turnLock.releaseForTool(toolUseID);
              return { continue: true };
            },
          ],
        },
      ],
    },
  };
}

/** A deny composes with parallel RTK rewrites, allowlists and approval edits. */
function backgroundBashRefusal(toolName: string, input: unknown): string | null {
  // A query's worker dies at turn end. Rewriting in another parallel hook
  // could overwrite a command edit or itself be overwritten by RTK.
  return toolName === "Bash" && (input as { run_in_background?: unknown } | null)?.run_in_background === true
    ? "Background shell tasks cannot survive this turn's worker teardown. Re-run this Bash call with run_in_background: false and collect its result within the turn."
    : null;
}
