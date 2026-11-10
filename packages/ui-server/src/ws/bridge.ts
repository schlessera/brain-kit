import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { readsIndex, type IndexBatch } from "../brain/index-batch.js";
import { staleReadRefusal } from "../brain/turn-data-tree.js";
import type { RunningTurn } from "./turns.js";
import type { WsHost } from "./host.js";
import { createBridgeContext, type BridgeContext, type MakeBridgeOptions } from "./bridge-capabilities/context.js";
import { createEmission, createTurnTranscript, type TurnTranscript } from "./bridge-capabilities/emission.js";
import { createActivity, guardMaskedRecords, openInbox } from "./bridge-capabilities/activity.js";
import { createPermissions } from "./bridge-capabilities/permissions.js";
import { createAsks } from "./bridge-capabilities/asks.js";
import { createLocationAndMask, createMaskApplicationSlice } from "./bridge-capabilities/location-mask.js";
import { createPolicyProposal } from "./bridge-capabilities/policy-proposal.js";
import { createApplication } from "./bridge-capabilities/application.js";
import { createScratch } from "./bridge-capabilities/scratch.js";
import { createAttachmentRead } from "./bridge-capabilities/attachments.js";
import { createWebAccess } from "./bridge-capabilities/web.js";
import { createEffectiveSafety } from "../governance/effective-safety.js";
import { retainTurnSessionBinding } from "./bridge-session-binding.js";

export { emitTurnError } from "./bridge-capabilities/turn-error.js";

const turnIndexSettlers = new WeakMap<BackendBridge, () => Promise<void>>();

/**
 * At turn end: flush the index updates this turn's applications queued.
 * Rejects when that update fails; each application's Activity record has
 * already received the outcome, and its paths stay queued for the next reader.
 */
export function settleTurnIndex(bridge: BackendBridge): Promise<void> {
  return turnIndexSettlers.get(bridge)?.() ?? Promise.resolve();
}

/**
 * Build the per-turn bridge the backend drives (#2516): one slice per
 * capability, composed in a fixed order, with the live-authority wrapper last.
 */
export async function makeBridge(host: WsHost, turn: RunningTurn, options: MakeBridgeOptions): Promise<BackendBridge> {
  const applicationPolicy = options.applicationPolicy ? { ...options.applicationPolicy, lock: host.workerLock } : undefined;
  const ctx = createBridgeContext(host, turn, options);
  const transcript = createTurnTranscript(ctx);
  // Captures the turn's draft and retry fields now, with its identity.
  const emission = createEmission(ctx, transcript, options);
  const inbox = openInbox(ctx, options.protectedPaths);
  if (ctx.work?.posture !== "voice") await host.inboxTools?.shares?.start(ctx.principalId, ctx.turnId, turn.sessionId ?? undefined, turn.shareId, ctx.current);
  // Capabilities that ask for a permission read the composed bridge when they
  // ask, so they reach the wrapped `requestPermission` installed below.
  let bridge: BackendBridge | undefined;
  const self = () => bridge!;
  bridge = {
    ...inbox,
    ...createScratch(ctx),
    ...emission,
    ...createPermissions(ctx, self),
    ...createActivity(ctx, transcript, options),
    ...createAsks(ctx),
    ...createLocationAndMask(ctx),
  };
  Object.assign(bridge, createPolicyProposal(ctx, self));
  let turnIndex: IndexBatch | undefined;
  if (host.brainPath && applicationPolicy) {
    const application = createApplication(ctx, self, host.brainPath, applicationPolicy, options);
    turnIndex = application.indexBatch;
    Object.assign(bridge, application.slice);
    if (ctx.backendId === "claude" || ctx.backendId === "pi") {
      Object.assign(bridge, createMaskApplicationSlice(ctx, host.brainPath, applicationPolicy, bridge.requestMask!, options));
      // Hosted scratch pruning is part of the mask operation, including its
      // exact removals. No second, unrecorded prune callback is handed out.
      delete bridge.pruneScratch;
    }
  }
  applyIndexReads(ctx, bridge, turnIndex, options.turnData);
  // Reference source and managed worktrees (#2432): the host's record of this
  // turn supplies principal, views and generation; the call carries its input only.
  if (host.referenceTools) bridge.referenceAccess = call => host.referenceTools!.call(ctx.turnId, ctx.principalId, call, ctx.signal);
  applyExternalServices(ctx, bridge, transcript, options.governance);
  Object.assign(bridge, createAttachmentRead(ctx, transcript));
  Object.assign(bridge, createWebAccess(ctx, transcript, options.governance));
  guardMaskedRecords(ctx, bridge);
  if (ctx.backendId === "claude" || ctx.backendId === "pi") applyLiveAuthority(ctx, bridge);
  if (host.activity?.governanceDb) {
    let epoch = 0n, previous = ctx.current();
    bridge.admissionSafety = createEffectiveSafety(host.activity.governanceDb, {
      brain: host.brainPath, turnId: ctx.turnId, sessionId: () => turn.sessionId ?? null, policyHash: options.governance?.policy.hash ?? null,
      writes: host.activity.governanceWrites, trust: host.safetyTrust, signal: ctx.signal,
      authority: () => {
        // Journal/scope holds retain their existing wait semantics; they are
        // not principal revocation and do not mint a new authority epoch.
        const current = ctx.current();
        if (current !== previous) { epoch++; previous = current; }
        return { current, epoch: String(epoch) };
      },
    });
  }
  retainTurnSessionBinding(bridge, ctx);
  return bridge;
}

/**
 * External compute (#3108) and Apify (#3162). The host binds the caller, the
 * frozen policy, the approval surface, the mask guard and the credentials;
 * the call carries its own input only.
 */
function applyExternalServices(ctx: BridgeContext, bridge: BackendBridge, transcript: TurnTranscript, governance: MakeBridgeOptions["governance"]): void {
  const { host, turn, turnId, principalId, backendId, work, signal, maskGuard, mainModel, workerProfile, toolName, isAuthorized } = ctx;
  if (backendId !== "claude" && backendId !== "pi") return;
  // Governed turns only: the budget ledger and the frozen policy are theirs.
  if (host.computeTools && governance) {
    const posture = work?.posture === "voice" ? "voice" : "interactive";
    bridge.compute = host.computeTools.forTurn({ turnId, principalId, sessionId: () => turn.sessionId ?? undefined,
      policy: governance.policy.policy, policyHash: governance.policy.hash, posture, noGrantSurface: posture === "voice", autonomous: false,
      hasClient: () => host.clients.hasClients(), ...(maskGuard ? { maskGuard } : {}), toolName,
      requestPermission: request => bridge.requestPermission(request),
      isCurrent: () => !signal.aborted && isAuthorized(),
      govern: event => host.catalog.recordGovernanceEvent?.({ ...event, turnId, sessionId: turn.sessionId, actor: posture,
        model: mainModel?.current() ?? null, profile: workerProfile?.actualProfile ?? null } as never) });
  }
  // The context comes from this turn, never from the call. The approval
  // surface is this bridge's own, so voice and revoked turns refuse as they
  // do for every other card; the host also refuses a non-interactive turn.
  if (host.apify) {
    const apify = host.apify;
    bridge.apify = call => apify.call({ turnId, principalId, sessionId: () => transcript.collectedSessionId ?? null,
      posture: work?.posture === "voice" ? "voice" : "interactive",
      approvals: { requestPermission: request => bridge.requestPermission(request) }, signal }, call);
  }
}

/**
 * Index-dependent reads wait for every application committed before them,
 * in any turn; the end of this turn flushes what is still queued (#2835).
 */
export function applyIndexReads(ctx: Pick<BridgeContext, "host" | "signal">, bridge: BackendBridge, turnIndex: IndexBatch | undefined,
  turnData: MakeBridgeOptions["turnData"]): void {
  const { host, signal } = ctx;
  const indexBatch = turnIndex ?? host.indexBatch;
  if (turnData) {
    // The worker reads the turn's own index, so only its own update gates
    // a read; the live brain's still settles at the end of the turn (#2848).
    const { tree, view } = turnData;
    bridge.awaitIndex = async (toolName, input) => {
      // A Claude file tool sees the startup view at the brain path: what this
      // turn applied is current only through the brain tools (2026-10-25 ruling).
      const refusal = tree.mount && host.brainPath ? staleReadRefusal(tree, host.brainPath, view, toolName, input) : undefined;
      if (refusal) throw new Error(refusal);
      if (readsIndex(toolName)) await tree.barrier(signal);
    };
  } else if (indexBatch) bridge.awaitIndex = async toolName => { if (readsIndex(toolName)) await indexBatch.barrier(signal); };
  if (indexBatch && turnIndex) turnIndexSettlers.set(bridge, () => turnIndex!.pending() ? turnIndex!.barrier() : Promise.resolve());
}

/**
 * A worker may invoke a bridge executor without the runtime's permission
 * hook. Check live server authority on every parent effect, not only at
 * tool admission. Voice retains the same narrower named capabilities.
 */
export function applyLiveAuthority(ctx: Pick<BridgeContext, "work" | "afterHolds" | "assertAuthority">, bridge: BackendBridge): void {
  const { work, afterHolds, assertAuthority } = ctx;
  for (const name of ["requestPermission", "askUser", "askUserList", "askUserRank", "askUserForm", "getLocation", "queryActivity", "requestMask", "pruneScratch", "inboxList", "inboxGet", "inboxAdd", "resolveAction", "completeShare", "referenceAccess", "compute", "apify", "readAttachment", "webAccess"] as const) {
    const original = bridge[name];
    if (!original) continue;
    (bridge as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      if (name === "requestPermission" && work?.posture === "voice") return Promise.resolve({ behavior: "deny", message: "Voice cannot grant tools." });
      try {
        return await afterHolds(() => {
          assertAuthority();
          if (work?.posture === "voice" && ["askUserList", "askUserRank", "askUserForm", "requestMask", "pruneScratch"].includes(name))
            throw new Error("This capability is outside the voice membership.");
          return (original as (...input: unknown[]) => unknown)(...args);
        });
      } catch (error) { return Promise.reject(error); }
    };
  }
}
