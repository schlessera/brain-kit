import type { BackendBridge, BrainApplicationPolicy } from "@schlessera/brain-ui-sdk/server";
import { createBrainApplication, readBrainApplicationBase, validatePlan } from "../../brain/application.js";
import type { IndexBatch } from "../../brain/index-batch.js";
import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";

/** A tool name per application operation, as the backend registers it. */
function operationToolNames(backendId: string) {
  return backendId === "claude"
    ? { add: "mcp__brain-ui__brain_add", update: "mcp__brain-ui__brain_update", archive: "mcp__brain-ui__brain_archive", write: "mcp__brain-ui__write_file", edit: "mcp__brain-ui__edit_file", staged: "mcp__brain-ui__apply_staged_changes" }
    : { add: "brain_add", update: "brain_update", archive: "brain_archive", write: "write_file", edit: "edit_file", staged: "apply_staged_changes" };
}

/**
 * Bounded application to authoritative Markdown: base reads, applications
 * and share completion. `self` is the composed bridge, read at call time:
 * approvals go through its current `requestPermission`. Returns the index
 * batch the turn's applications queue into.
 */
export function createApplication(ctx: BridgeContext, self: () => BackendBridge, root: string, applicationPolicy: BrainApplicationPolicy,
  options: Pick<MakeBridgeOptions, "protectedPaths" | "turnData">): { slice: BridgeSlice<"readBrainBase" | "applyBrain"> & Partial<BridgeSlice<"completeShare">>; indexBatch: IndexBatch } {
  const { host, turn, turnId, principalId, authorization, signal, work, backendId, recorder, maskGuard, toolName, isAuthorized, hold, afterHolds, current } = ctx;
  const { protectedPaths, turnData } = options;
  const operationTools = operationToolNames(backendId);
  const apply = createBrainApplication({
    root, principalId, turnId, signal, policy: applicationPolicy,
    protectedPaths,
    ...(maskGuard ? { providerMasks: { guard: maskGuard, tool: operation => operationTools[operation] } } : {}),
    ...(host.applicationPlanner ? { planner: host.applicationPlanner } : {}),
    isAuthorized, hold,
    approve: async (input, destructive) => {
      if (work?.posture === "voice") return false;
      const decision = await self().requestPermission({ toolUseId: `application-${crypto.randomUUID()}`,
        toolName: operationTools[input.operation], input: { ...input },
        kind: destructive ? "command" : "tool", outsideEnforcedAllowlist: applicationPolicy.enforceAllowedTools === true && !applicationPolicy.autoAllowed.includes(input.operation), description: "Apply this exact bounded change to authoritative Markdown." });
      // An edited proposal must be reissued with its own base and validation.
      return decision.behavior === "allow" && decision.updatedInput === undefined;
    },
    record: result => recorder?.recordApplication?.(result),
    ...(host.indexBatch ? { indexBatch: host.indexBatch } : {}),
    recordIndex: outcome => recorder?.recordApplicationIndex?.(outcome),
    ...(turnData ? { turnTree: turnData.tree } : {}),
    // A masked turn plans on its own tree, so its captures are admitted like its other effects (#2846).
    ...(turnData && maskGuard ? { turnPlanner: async (_root, input, _read, planSignal) => validatePlan(await turnData.tree.planAdd(input, planSignal)) } : {}),
  });
  const slice: BridgeSlice<"readBrainBase" | "applyBrain"> & Partial<BridgeSlice<"completeShare">> = {
    readBrainBase: async path => {
      if (turn.turnId !== turnId || signal.aborted || !authorization.valid || authorization.expiresAt <= Date.now() || turn.cancelled || turn.startedAt === undefined || !host.isPrincipalAuthorized(principalId)) throw new Error("This turn no longer has current principal authority.");
      return readBrainApplicationBase(root, path, maskGuard ? { guard: maskGuard, tool: toolName("brain_read_base") } : undefined);
    },
    // The application waits for holds itself, so its refusals are recorded.
    applyBrain: input => afterHolds(() => {
      const execute = () => apply({ principalId, turnId, input });
      return host.inboxTools?.shares ? host.inboxTools.shares.apply(principalId, turnId, turn.sessionId ?? undefined, current, input, execute) : execute();
    }, false),
  };
  if (host.inboxTools?.shares && work?.posture !== "voice") slice.completeShare = input => afterHolds(() => {
    return host.inboxTools!.shares!.complete(principalId, turnId, turn.sessionId ?? undefined, current, input, async () => {
      const decision = await self().requestPermission({ toolUseId: `share-completion-${crypto.randomUUID()}`, toolName: toolName("complete_share"), input, kind: "command", description: "Complete this share and discard only these exact originals after verified filing." });
      return decision.behavior === "allow" && decision.updatedInput === undefined;
    }, applicationPolicy.lock, maskGuard ? paths => maskGuard.assert(toolName("complete_share"), paths) : undefined);
  });
  return { slice, indexBatch: apply.indexBatch };
}
