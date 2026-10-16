import { toolAvailabilityRefusal } from "./tool-availability.js";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { createWorkerFileObserver, NativeFileVersions, WORKER_AREA_ROOT, type ObservedWorkerFile } from "@schlessera/brain-ui-sdk/internal";
import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { compileWorkerCommandPolicy, denyWorkerCommand, requestPolicyPermission, prepareOutwardPlan, observeOutwardPlan, OUTWARD_VOICE_REFUSAL } from "@schlessera/brain-ui-sdk/internal";
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

export function createPermissionWiring(options: {
  req: StartTurnRequest;
  allowedTools: readonly string[];
  confirmPatterns: readonly RegExp[];
  brainPath: string;
  turnLock: TurnLockBinding;
  /** The filtered environment this turn's subprocesses run with. */
  childEnv: NodeJS.ProcessEnv;
  /** Where a withheld re-admission is recorded. */
  log: BackendLogFn;
  /** Host-held actual startup view, never worker-supplied authority. */
  configurationRoot?: () => string | undefined;
  /** Trusted host ledger and limits; never copied to worker initialization. */
  maintenance?: import("@schlessera/brain-ui-sdk/internal").MaintenanceHost;
  fileVersions?: NativeFileVersions;
  observeFile?: (path: string) => ObservedWorkerFile | undefined;
}): Pick<Options, "canUseTool" | "hooks"> {
  const { req, allowedTools, brainPath, turnLock, childEnv, log } = options;
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
  const nativeRefusal = (toolName: string, input: unknown): string | null => {
    if (req.autonomous || !["Write", "Edit", "NotebookEdit"].includes(toolName)) return null;
    const path = filePath(toolName, input), current = path ? observation(path) : undefined;
    return current ? fileVersions.check(current.key, current.version) : null;
  };
  const beginNativeRead: HookCallback = async hookInput => {
    if (req.autonomous || req.signal.aborted || hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "Read") return { continue: true };
    const path = filePath(hookInput.tool_name, hookInput.tool_input), current = path ? observation(path) : undefined;
    if (current) fileVersions.beginRead(hookInput.tool_use_id, current.key, current.version);
    return { continue: true };
  };
  const finishNativeFile: HookCallback = async hookInput => {
    if (req.autonomous || (hookInput.hook_event_name !== "PostToolUse" && hookInput.hook_event_name !== "PostToolUseFailure")) return { continue: true };
    const path = filePath(hookInput.tool_name, hookInput.tool_input), current = path ? observation(path) : undefined;
    if (hookInput.tool_name === "Read") {
      fileVersions.finishRead(hookInput.tool_use_id, current?.version ?? { status: "unavailable" }, hookInput.hook_event_name === "PostToolUse" && !req.signal.aborted && ["text", "image", "notebook", "pdf", "parts"].includes((hookInput.tool_response as { type?: string } | null)?.type ?? ""));
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
      if (written !== undefined) fileVersions.remember(current.key, createHash("sha256").update(written, "utf8").digest("hex"));
      else fileVersions.finishWrite(current.key, current.version);
    }
    return { continue: true };
  };
  const commandPolicy = compileWorkerCommandPolicy(req.autonomous ? undefined : req.workerSandbox?.commandPolicy);
  const confirmPatterns = [...options.confirmPatterns, ...commandPolicy.confirm];
  const outward = (toolName: string, input: unknown) => prepareOutwardPlan({ toolName, shellToolName: "Bash", input,
    allow: req.workerSandbox?.commandPolicy?.outwardAllow, autonomous: Boolean(req.autonomous), voice: req.posture === "voice",
    configurationRoot: options.configurationRoot?.() ?? (req.workerSandbox?.profile === "governed" ? brainPath : undefined), maskPaths: req.workerSandbox?.maskPaths, maintenance: options.maintenance });
  const observe = (plan: ReturnType<typeof outward>, toolName: string, input: unknown, toolUseId: string,
    decision: Parameters<typeof observeOutwardPlan>[1]["decision"]) => observeOutwardPlan(plan, { bridge: req.bridge, toolName, input, toolUseId, decision });
  // Only a host-completed per-use admission, with exact input identity, may
  // suppress the same command card when the runtime subsequently asks for its
  // separate tool grant. Never borrowed across turns, retries or edited input.
  const shownOutward = new Map<string, string>();
  const denyCommand = (toolName: string, input: unknown, toolUseId: string) => {
    const refusal = denyWorkerCommand(commandPolicy, { bridge: req.bridge, toolName, shellToolName: "Bash", input, toolUseId });
    if (refusal) observe(prepareOutwardPlan({ toolName, shellToolName: "Bash", input, autonomous: Boolean(req.autonomous) }), toolName, input, toolUseId, "refused");
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
  /** A tool the enforced allowlist left out: no shortcut may admit it. */
  const outsideEnforcedAllowlist = (toolName: string): boolean =>
    enforced && !allowed.has(toolName);
  const withheld = (toolName: string): void => {
    log("warn", "allowlist enforced: withheld an input-rewrite auto-allow", {
      "tool.name": toolName,
    });
  };

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
  const enforcementHook: HookCallback = async (hookInput) => {
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
    if (
      hookInput.hook_event_name !== "PreToolUse" ||
      !enforced || allowed.has(hookInput.tool_name)
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
  // PreToolUse historically checks confirm patterns even when a deployment
  // removes Bash from its allowlist (canUseTool then performs the tool grant).
  // Model that hook path as command-allowed to preserve the two runtime gates.
  //
  // BRAIN_UPDATE_TOOL is here for the same reason, and the reason is sharper:
  // the fallback card from canUseTool is kind "tool", which a remembered
  // "always allow" answers without showing anything (ws/bridge.ts refuses to
  // do that only for kind "command"). Without this line, a deployment that
  // NARROWED its allowlist would lose the archiving confirmation entirely
  // after one such grant — the tool removed from the allowlist behaving more
  // permissively than the tool left on it, which is the shape of #124.
  const commandAllowed = new Set(allowed);
  commandAllowed.add("Bash");
  commandAllowed.add(BRAIN_UPDATE_TOOL);
  commandAllowed.add("mcp__brain__brain_update");

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

  const canUseTool: NonNullable<Options["canUseTool"]> = async (
    toolName,
    input,
    opts
  ) => {
    if (req.signal.aborted || isCompletedAutonomousToolCall(req.autonomous, toolName, input))
      return { behavior: "deny", message: "Cancelled or already completed autonomous call; no replay." };
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
      outsideEnforcedAllowlist: outsideEnforcedAllowlist(toolName),
    });
    let decision = perUseDecision && allowed.has(toolName) ? perUseDecision : await requestPolicyPermission(commandPolicy, { bridge: req.bridge, request, permission: permissionOptions, shellToolName: "Bash", signal: req.signal });
    if (decision.behavior === "allow" && decision.updatedInput === undefined && perUseDecision?.behavior === "allow" && perUseDecision.updatedInput !== undefined) {
      decision = { behavior: "allow", updatedInput: input };
    }
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
    if (!shown || decision.behavior === "deny" || decision.updatedInput !== undefined) observe(outward(toolName, decision.behavior === "allow" ? decision.updatedInput ?? input : input), toolName, decision.behavior === "allow" ? decision.updatedInput ?? input : input, opts.toolUseID, decision);
    if (decision.behavior === "allow") {
      const effectiveInput = decision.updatedInput ?? input;
      const acquired = await turnLock.acquireForTool(
        opts.toolUseID,
        lockKeyForTool(toolName, effectiveInput, brainPath)
      );
      if (!acquired.ok) return { behavior: "deny", message: acquired.reason };
      const stale = nativeRefusal(toolName, effectiveInput);
      if (stale) { turnLock.releaseForTool(opts.toolUseID); return { behavior: "deny", message: stale }; }
    }
    return toPermissionResult(decision);
  };

  // The write lock CANNOT live in canUseTool alone: the SDK auto-allows every
  // tool listed in `allowedTools` without invoking the callback (it warns
  // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and the default allowlist contains all
  // mutating tools. PreToolUse fires before every tool execution — auto-allowed
  // or approved — and the SDK awaits it, so acquiring here serializes writes
  // across turns no matter which permission path admitted the tool.
  const mutatingHook: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }
    const unavailable = toolAvailabilityRefusal(req, hookInput.tool_name);
    if (unavailable) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: unavailable } };
    if (req.signal.aborted) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Turn cancelled before tool admission." } };
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
    // the brain repo's project settings (`settingSources`, sdk-options.ts:232),
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
    observe(outward(hookInput.tool_name, finalInput), hookInput.tool_name, finalInput, hookInput.tool_use_id, { behavior: "allow" });
    if (outwardPlan.classification.actions.length) shownOutward.set(hookInput.tool_use_id, JSON.stringify(finalInput));

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
    const stale = nativeRefusal(hookInput.tool_name, edited ?? hookInput.tool_input);
    if (stale) { turnLock.releaseForTool(hookInput.tool_use_id); return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stale } }; }
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

  // Runtime hooks see the original input in parallel. A completed receipt may
  // contain the foreground/RTK rewrite, so restrict that final form too: a
  // rewrite's auto-allow must not re-admit an already completed effect.
  const restrictRewrite = (hook: HookCallback, toolName: string): HookCallback => async (...args) => {
    const output = await hook(...args);
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
    }
    return output;
  };
  const agentHook = restrictRewrite(createAgentHook({
    mayGrant: !outsideEnforcedAllowlist("Agent"),
    onGrantWithheld: withheld,
  }), "Agent");
  const rtkHook = restrictRewrite(createRtkHook(childEnv, {
    mayGrant: !outsideEnforcedAllowlist("Bash"),
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
        ...(enforced ? [{ hooks: [enforcementHook] }] : []),
        { matcher: MUTATING_TOOL_MATCHER, hooks: [mutatingHook] },
        { matcher: "^Agent$", hooks: [agentHook] },
        { matcher: "^Bash$", hooks: [rtkHook] },
        ...(!req.autonomous ? [{ matcher: "^Read$", hooks: [beginNativeRead] }] : []),
        ...(!enforced && !req.autonomous ? [{ hooks: [enforcementHook] }] : []),
      ],
      ...(!req.autonomous ? {
        PostToolUse: [{ matcher: "^(Read|Write|Edit|NotebookEdit)$", hooks: [finishNativeFile] }],
        PostToolUseFailure: [{ matcher: "^(Read|Write|Edit|NotebookEdit)$", hooks: [finishNativeFile] }],
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
