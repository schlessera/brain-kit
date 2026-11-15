import type { BackendBridge, BrainApplicationPolicy } from "@schlessera/brain-ui-sdk/server";
import type { BillingMode, PricingRoute, TurnFailure, TurnUsage } from "@schlessera/brain-ui-sdk/protocol";
import type { TurnGovernancePolicy } from "../../brain/governance-policy.js";
import type { TurnDataTree } from "../../brain/turn-data-tree.js";
import { createProviderMaskGuard, type ProviderMaskGuard } from "../../brain/provider-mask-refusal.js";
import { AUTHORITY_HOLD_WAIT_MS, waitForAuthority, waitWhile, type AuthorityHold } from "../../brain/authority-hold.js";
import type { TurnRecorder } from "../../activity/recorder.js";
import type { RunningTurn } from "../turns.js";
import type { WsHost } from "../host.js";
import { createEffectiveSafety } from "../../governance/effective-safety.js";

/** What one turn's bridge is built from, besides its host and turn (#2516). */
export interface MakeBridgeOptions {
  promptText: string;
  backendId: string;
  recorder?: TurnRecorder | undefined;
  /**
   * Called once, with the first session id `session_info` names. A new
   * conversation has no id until then, so anything keyed by the session
   * that must be written for this turn's prompt waits for it here.
   */
  onSessionNamed?: ((sessionId: string) => void) | undefined;
  onTerminalFailure?: ((sessionId: string, failure: TurnFailure) => void) | undefined;
  /** Called before this turn's own result frame goes out. */
  onTurnResult?: ((sessionId: string) => void) | undefined;
  /** The pill label the request already has, read when the session is named (#1004). */
  promptLabel?: (() => string | undefined) | undefined;
  applicationPolicy?: BrainApplicationPolicy | undefined;
  /** Frozen policy protection captured after this turn's gate admission. */
  protectedPaths?: readonly string[] | undefined;
  workerProfile?: WorkerProfileBinding | undefined;
  onUsage?: ((usage: TurnUsage, backstop?: boolean) => TurnUsage | void) | undefined;
  pricingContext?: { billingMode?: BillingMode; pricingRoute?: PricingRoute } | undefined;
  mainModel?: MainModelBinding | undefined;
  /** The admitted turn's masked provider folders (`sandbox.providerMasks.folders`) and the policy that named them. */
  providerMasks?: { folders: readonly string[]; policy: TurnGovernancePolicy; typeFolders?: Readonly<Record<string, readonly string[]>>; recipient?: string } | undefined;
  /**
   * The admitted turn's data tree (#2848, #2846) and, for a worker on the
   * startup view, that view's root: where its `Read` of a brain path resolves.
   */
  turnData?: { tree: TurnDataTree; view?: string } | undefined;
  /** The governed turn's frozen policy: hosted external compute is admitted only under it (#3108). */
  governance?: { policy: TurnGovernancePolicy } | undefined;
}

interface WorkerProfileBinding { origin: "interactive" | "voice"; actualProfile: "governed" | "strict"; draftId?: string; preference?: "governed" | "strict" }
interface MainModelBinding { current(): string | null; bind(model: string): void }

/**
 * The turn identity and authority checks every capability shares, captured
 * when the bridge is built. A backend can still emit late frames through this
 * bridge after its startTurn resolved, and the slot's fields are re-minted for
 * each queued follow-up: reading the live fields would attribute those to the
 * NEXT turn.
 */
export interface BridgeContext {
  readonly host: WsHost;
  readonly turn: RunningTurn;
  readonly backendId: string;
  readonly turnId: string;
  readonly requestId: string | undefined;
  readonly principalId: string;
  readonly authorization: RunningTurn["authorization"];
  readonly signal: AbortSignal;
  /** The host work this bridge's turn runs, not whatever the slot runs after a late frame arrives. */
  readonly work: RunningTurn["work"];
  readonly recorder: TurnRecorder | undefined;
  readonly mainModel: MainModelBinding | undefined;
  readonly workerProfile: WorkerProfileBinding | undefined;
  /** Read when the bridge is built, like the identity above. */
  readonly queryActivity: NonNullable<WsHost["activity"]>["query"] | undefined;
  /** This bridge's announced session identity must commit before its first approval snapshot. */
  readonly sessionBinding: { pending?: Promise<void>; failed: boolean };
  /** The turn's own authority: its identity, authorization and principal are current. */
  principalIsAuthorized(): boolean;
  /** Final host effects require qualified input recording independently of principal authority. */
  recordingAvailable(): boolean;
  scopePaused(): boolean;
  isAuthorized(): boolean;
  holdOf(held: () => boolean): AuthorityHold;
  readonly hold: AuthorityHold;
  assertAuthority(): void;
  afterHolds<T>(effect: () => T, holds?: boolean): Promise<Awaited<T>>;
  /** Share state is a server record, not Markdown: a hold that begins mid-call does not void it. */
  current(): boolean;
  /** The name a backend registers a brain-ui bridge tool under. */
  toolName(name: string): string;
  /**
   * Host bridge tools run outside the worker's mounts, so they refuse the
   * folders the worker masks, with one governance event per refused call (#2690).
   */
  readonly maskGuard: ProviderMaskGuard | undefined;
}

export function createBridgeContext(host: WsHost, turn: RunningTurn, options: MakeBridgeOptions): BridgeContext {
  const { backendId, recorder, mainModel, workerProfile, providerMasks } = options;
  const turnId = turn.turnId;
  const principalId = turn.principalId;
  const authorization = turn.authorization;
  const signal = turn.abortController.signal;
  const work = turn.work;
  const principalIsAuthorized = () => turn.turnId === turnId && turn.startedAt !== undefined && authorization.valid &&
    authorization.expiresAt > Date.now() && !turn.cancelled && host.isPrincipalAuthorized(principalId);
  const safety = host.activity?.governanceDb ? createEffectiveSafety(host.activity.governanceDb, {
    brain: host.brainPath, turnId, sessionId: () => turn.sessionId ?? null, policyHash: null,
    writes: host.activity.governanceWrites, trust: host.safetyTrust,
    authority: () => ({ current: principalIsAuthorized(), epoch: "0" }),
  }) : undefined;
  const recordingAvailable = () => {
    try { return safety?.read().recordingAvailable ?? true; } catch { return false; }
  };
  // A journal observation or a scope pause stops host effects for a while but
  // revokes nothing (#2853). An effect waits for one, bounded, and checks again;
  // `isAuthorized` stays false while one is active, so nothing commits under it.
  const scopePaused = () => !!host.scope?.isPaused(turnId);
  const isAuthorized = () => principalIsAuthorized() && recordingAvailable() && !host.journal?.isHeld() && !scopePaused();
  // A pause ends with the user's answer, which has no event here; the wait rechecks it.
  const holdOf = (held: () => boolean): AuthorityHold => ({ waitMs: AUTHORITY_HOLD_WAIT_MS,
    active: () => !signal.aborted && principalIsAuthorized() && held(),
    settled: () => host.journal?.isHeld() ? host.journal.idle() : new Promise(() => {}) });
  const hold = holdOf(() => !!host.journal?.isHeld() || scopePaused());
  const assertAuthority = () => {
    if (signal.aborted || !isAuthorized()) throw new Error("This turn no longer has current principal authority.");
  };
  /**
   * Starts `effect` after earlier journal work and, with `holds`, once no hold
   * remains, checked in the same tick it starts. A hold that begins after
   * `idle()` resolves is waited out, bounded, rather than read as revoked
   * authority. Revocation or cancellation ends either wait at once; `effect`
   * still makes its own final check.
   */
  const afterHolds = async <T>(effect: () => T, holds = true): Promise<Awaited<T>> => {
    const deadline = Date.now() + hold.waitMs;
    let idle = !host.journal;
    const idled = host.journal?.idle().then(() => { idle = true; });
    await waitWhile(() => !idle && !signal.aborted && principalIsAuthorized(), () => idled!, signal, deadline);
    if (holds) {
      while (hold.active() && await waitForAuthority(hold, signal, deadline)) { /* Recheck in this tick. */ }
      if (hold.active()) throw new Error("This turn's host effect stayed held by a journal observation or a scope pause past the wait bound; nothing was applied.");
    }
    return await effect();
  };
  const maskGuard = providerMasks?.folders.length ? createProviderMaskGuard({ folders: providerMasks.folders, policy: providerMasks.policy.policy,
    ...(providerMasks.typeFolders ? { typeFolders: providerMasks.typeFolders } : {}), ...(providerMasks.recipient ? { recipient: providerMasks.recipient } : {}),
    record: refusal => host.catalog.recordGovernanceEvent?.({ kind: "provider_mask_refusal", turnId, sessionId: turn.sessionId,
      actor: work?.posture === "voice" ? "voice" : "interactive", model: mainModel?.current() ?? null, profile: workerProfile?.actualProfile ?? null,
      payload: { ...refusal, policyHash: providerMasks.policy.hash } }) }) : undefined;
  return {
    host, turn, backendId, turnId, requestId: turn.requestId, principalId, authorization, signal, work,
    recorder, mainModel, workerProfile, queryActivity: host.activity?.query, sessionBinding: { failed: false },
    principalIsAuthorized, recordingAvailable, scopePaused, isAuthorized, holdOf, hold, assertAuthority, afterHolds,
    current: () => !signal.aborted && principalIsAuthorized(),
    toolName: (name: string) => backendId === "claude" ? `mcp__brain-ui__${name}` : name,
    maskGuard,
  };
}

/** A slice of the bridge one capability factory contributes. */
export type BridgeSlice<K extends keyof BackendBridge> = Pick<BackendBridge, K>;
