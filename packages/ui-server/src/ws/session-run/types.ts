import type {
  ChatImageAttachment,
  ClientEnvironment,
  DraftRef,
  LocalExchange,
  MessageSource,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { ProviderRelay, WorkerNoteFacts } from "@schlessera/brain-ui-sdk/internal";
import type { createTurnLifecycle } from "../../activity/turn-lifecycle.js";
import type { TurnRecorder } from "../../activity/recorder.js";
import type { prepareTurnEgress } from "../../brain/turn-egress.js";
import type { GovernedTurnHold } from "../../brain/governed-turn.js";
import type { ReferenceWorktreeGeneration } from "../../brain/reference-worktrees.js";
import type { WsHost } from "../host.js";
import type { AuthorizationContext, HostWork, QueuedFollowUp, RunningTurn } from "../turns.js";
import type { RunBilling } from "./billing.js";

export type TurnLifecycle = ReturnType<typeof createTurnLifecycle>;
type FailureRecording = Awaited<ReturnType<WsHost["failureReplay"]["begin"]>>;
type TurnEgress = Awaited<ReturnType<typeof prepareTurnEgress>>;

export type RunSessionInput = {
  shareId?: string;
  authorization: AuthorizationContext;
  replayPrompt?: string;
  isRetry?: boolean;
  text: string;
  sessionId?: string;
  historyOwnerId?: string;
  attachments: ChatImageAttachment[];
  files?: import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta[];
  providerId?: string;
  client?: ClientEnvironment;
  source?: MessageSource;
  thinkingLevel?: ThinkingLevel;
  requestId?: string;
  /** Client correlation id for a new conversation; echoed on session_info. */
  draftId?: string;
  /** The saved draft revision this message was sent from (#979). */
  draftRef?: DraftRef;
  profileDraftId?: string;
  /** Accepted-work revision of this request (#964), for a known session. */
  revision?: number;
  /**
   * Local exchanges the draft conversation holds (#582). Recorded against
   * the session once `session_info` names it, and carried on its first
   * prompt.
   */
  localExchanges?: LocalExchange[];
  /** A handoff destination's hooks (#61); only on a new conversation. */
  handoffHooks?: HandoffHooks;
  /** Host-orchestrated work this message carries (#957). */
  work?: HostWork;
};

/**
 * What a handoff creation (#61) needs from the run that creates its
 * destination: the moment `session_info` names it, and the moment the
 * attempt is over, whichever way it ended.
 */
export interface HandoffHooks {
  /** The conversation handed off: its provider history continues in the destination (#2695). */
  readonly sourceSessionId?: string;
  onNamed(sessionId: string): void;
  onSettled(): void;
}

/** What one session slot carries from each of its turns to the next. */
export interface SessionSlot {
  readonly host: WsHost;
  readonly initial: RunSessionInput;
  readonly turn: RunningTurn;
  readonly backend: AgentBackend;
  /** The slot's first turn: a manual retry and a replay prompt apply only to it. */
  readonly firstTurnId: string;
  /** The resolved profile, re-pinned by session_info between queued turns. */
  profileId: string | undefined;
  /** The session the next turn resumes, once one is known. */
  resumeId: string | undefined;
  /** Only the first turn of a new conversation carries the draft's exchanges. */
  draftExchanges: LocalExchange[];
  /** The running request's queue lease, until it is released. */
  releaseActive: (() => void) | undefined;
}

/**
 * Why a running turn was stopped from outside its own control flow: a
 * budget write or block, a journal failure, or a scope cap. Each is set at
 * most once, by a callback, and read when the turn's outcome is classified.
 */
export interface TurnStops {
  budget?: Error;
  journal?: Error;
  scope?: string;
}

/** What admission and backend entry acquired, which teardown releases. */
interface TurnHeld {
  governedHold?: GovernedTurnHold;
  worktreeGeneration?: ReferenceWorktreeGeneration;
  referenceViews: { public: string; private: string } | null;
  referenceTurn: boolean;
  turnEgress?: TurnEgress;
  providerRelay?: ProviderRelay;
  /** Index updates this turn's applications queued (#2835), flushed once its workers stop. */
  settleIndex?: () => Promise<void>;
  enteredBackend: boolean;
}

/** One request of a slot, from host admission to teardown. */
export interface TurnRun {
  readonly slot: SessionSlot;
  readonly host: WsHost;
  readonly turn: RunningTurn;
  readonly backend: AgentBackend;
  readonly current: QueuedFollowUp;
  /** The turn's identity as it started; the slot re-mints it for the next request. */
  readonly turnId: string;
  readonly lifecycle: TurnLifecycle | undefined;
  readonly abortController: AbortController;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  readonly billing: RunBilling;
  readonly failureRecording: FailureRecording;
  readonly recorder: TurnRecorder | undefined;
  readonly workerIdentity: WorkerNoteFacts["identity"] | undefined;
  readonly origin: "voice" | "interactive";
  /** The slot's profile and session as this turn started; the slot advances them after it. */
  readonly profileId: string | undefined;
  readonly resumeId: string | undefined;
  readonly startedAt: number;
  /** The model the turn runs, rebound when the backend reports its actual model. */
  mainModel: string | null;
  readonly stops: TurnStops;
  /** A budget write's commit and its outcome; the turn's outcome waits for every one (#2850). */
  readonly budgetWrites: Set<Promise<unknown>>;
  readonly held: TurnHeld;
}
