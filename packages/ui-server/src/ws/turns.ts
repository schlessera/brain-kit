import type { Logger } from "@opentelemetry/api-logs";
import type {
  AgentBackend,
  PermissionDecision,
  PermissionRequest,
  AskUserResult,
  AskUserListResult,
  AskUserRankResult,
  AskUserFormResult,
  LocationFix,
} from "@schlessera/brain-ui-sdk/server";
import type {
  ApprovalChannel,
  AskUserListSpec,
  AskUserRankSpec,
  AskUserFormSpec,
  AskUserQuestion,
  ChatImageAttachment,
  ClientEnvironment,
  MessageSource,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import type { TurnRecorder } from "../activity/recorder.js";

const authorizationContextBrand: unique symbol = Symbol("AuthorizationContext");

/** Mutable admission decision shared by every asynchronous path from one socket. */
export interface AuthorizationContext {
  readonly [authorizationContextBrand]: true;
  readonly principalId: string;
  readonly expiresAt: number;
  valid: boolean;
  /** Keep this context discoverable until the returned release is called. */
  retain(): () => void;
  /** Release the reference acquired when the coordinator opened this context. */
  release(): void;
}

export interface QueuedFollowUp {
  principalId: string;
  authorization: AuthorizationContext;
  text: string;
  attachments: ChatImageAttachment[];
  files?: import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta[];
  /** Device snapshot taken when the message was sent, not when it runs. */
  client?: ClientEnvironment;
  /** How the user produced the message; absent means typed. */
  source?: MessageSource;
  thinkingLevel?: ThinkingLevel;
  requestId?: string;
  /** Queue-owned authorization lease, transferred to the runner on dequeue. */
  releaseAuthorization: () => void;
}

/**
 * Bytes one queued entry keeps alive in this process until its turn runs.
 *
 * Attachments dominate and are still base64 here — the host never decodes a
 * follow-up's images, it hands the same strings to the backend when the turn
 * starts — so their wire length IS the retained size. (A JS string may cost
 * two bytes per character internally; this deliberately measures the payload,
 * not the engine's representation, so the number matches what the sender put
 * on the wire.) The client snapshot is a handful of short fields and is not
 * worth walking.
 */
export function queuedFollowUpBytes(
  entry: Pick<QueuedFollowUp, "text" | "attachments" | "files">
): number {
  let bytes = Buffer.byteLength(entry.text, "utf-8");
  for (const attachment of entry.attachments) {
    bytes += attachment.data.length;
  }
  return bytes + (entry.files?.length ? Buffer.byteLength(JSON.stringify(entry.files), "utf8") : 0);
}

/** Total bytes currently parked in a session's follow-up queue. */
export function queuedBytes(turn: Pick<RunningTurn, "queue">): number {
  let bytes = 0;
  for (const entry of turn.queue) bytes += queuedFollowUpBytes(entry);
  return bytes;
}

/**
 * One RUNNING session slot. `abortController`/`timeoutHandle` belong to the
 * turn currently executing; a queued follow-up runs as the next turn in the
 * same slot (same sessionId) after the current one resolves.
 */
export interface RunningTurn {
  /** Chat correlation for the current turn; replaced on dequeue. */
  requestId?: string;
  /** Principal responsible for the CURRENT turn in this session slot. */
  principalId: string;
  authorization: AuthorizationContext;
  /** Exact caller input plus the effective prompt; omitted for native injection. */
  retryRequest?: import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage;
  retryPrompt?: string;
  isManualRetry?: boolean;
  /** Activity recorder for the CURRENT turn, once startup reaches the backend. */
  recorder?: TurnRecorder;
  /**
   * Cancelling actors accepted before the recorder exists (while billing is
   * resolving). Drained into immutable activity events at recorder creation.
   */
  pendingCancellationPrincipalIds: string[];
  sessionId: string | null; // null until session_info resolves it (new session)
  /** Host-minted id of the CURRENT turn in this slot; re-minted per queued follow-up. */
  turnId: string;
  providerId: string | null;
  backend: AgentBackend;
  abortController: AbortController;
  timeoutHandle: ReturnType<typeof setTimeout>;
  queue: QueuedFollowUp[];
  cancelled: boolean;
  /**
   * Terminal disposition of the CURRENT turn's `result` frame, when one has
   * streamed. Backends RESOLVE startTurn for runtime failures (the failure
   * rides the result frame as outcome "error"), so completion accounting must
   * read this — a resolved startTurn alone does not mean the turn succeeded.
   * Reset when a queued follow-up becomes the next turn.
   */
  lastResult: "success" | "error" | "cancelled" | null;
  /**
   * Correlation id the client minted for this NEW conversation, echoed back on
   * `session_info` so the client can tell its own turn's identity from a
   * background turn's. Null on a resumed session or a client that sent none.
   */
  draftId: string | null;
}

// Pending interactive requests are tagged with their turn so a per-session
// cancel/disconnect can drain only that session's pending entries, and with
// the turnId that raised them (the slot's id mutates across queued follow-ups).
export interface PendingApproval {
  turn: RunningTurn;
  turnId: string;
  /**
   * The original request, kept so the card can be RE-DELIVERED to a client
   * that connects later. On a phone the socket drops every time the screen
   * locks; an approval must survive that and reappear, not silently die.
   */
  request: PermissionRequest;
  resolve: (
    decision: PermissionDecision,
    response?: { principalId: string; always?: boolean; channel?: ApprovalChannel }
  ) => void;
}

export interface PendingAskUser {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingApproval.request. */
  requestId: string;
  questions: AskUserQuestion[];
  resolve: (result: AskUserResult) => void;
  reject: (err: Error) => void;
}

export interface PendingAskUserList {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingAskUser.questions. */
  requestId: string;
  request: AskUserListSpec;
  resolve: (result: AskUserListResult) => void;
  reject: (err: Error) => void;
}

export interface PendingAskUserRank {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingAskUser.questions. */
  requestId: string;
  request: AskUserRankSpec;
  resolve: (result: AskUserRankResult) => void;
  reject: (err: Error) => void;
}

export interface PendingAskUserForm {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingAskUser.questions. */
  requestId: string;
  request: AskUserFormSpec;
  resolve: (result: AskUserFormResult) => void;
  reject: (err: Error) => void;
}

export interface PendingLocation {
  turn: RunningTurn;
  turnId: string;
  resolve: (result: LocationFix) => void;
  reject: (err: Error) => void;
}

export interface PendingMask {
  turn: RunningTurn;
  turnId: string;
  resolve: (png: Uint8Array) => void;
  reject: (err: Error) => void;
}

/**
 * Mutable turn state for one ws host: the running session slots and every
 * pending interactive round-trip. This used to be six module-level globals
 * inside a 976-line handler; as instance state it is testable and owned by an
 * explicit object with a defined lifecycle.
 */
export class TurnCoordinator {
  /**
   * Where collisions are reported. Assigned by the owning WsHost so the
   * coordinator reports through the same consumer as everything else; absent
   * (a bare coordinator in a test) means silence.
   */
  log?: Logger;

  readonly running = new Set<RunningTurn>();
  readonly bySession = new Map<string, RunningTurn>();
  startingSessions = 0;
  /** Reserve a known session before asynchronous backend routing. */
  readonly startingBySession = new Map<string, { queue: QueuedFollowUp[]; cancelled: boolean }>();

  readonly pendingApprovals = new Map<string, PendingApproval>();
  readonly pendingAskUser = new Map<string, PendingAskUser>();
  readonly pendingAskUserList = new Map<string, PendingAskUserList>();
  readonly pendingAskUserRank = new Map<string, PendingAskUserRank>();
  readonly pendingAskUserForm = new Map<string, PendingAskUserForm>();
  readonly pendingLocation = new Map<string, PendingLocation>();
  readonly pendingMask = new Map<string, PendingMask>();
  /**
   * Handoff creations in flight, by client-minted key (#61). Present from
   * acceptance until the destination is recorded or the attempt ends, so a
   * repeated key answers `pending` instead of starting a second session.
   */
  readonly handoffs = new Map<string, { sessionId?: string }>();
  /** Running handoff preparation summaries, by handoff key (#61). */
  readonly handoffPreparations = new Map<string, { abort: AbortController; owner: unknown }>();

  /** Every authorization context with at least one live owner or async lease. */
  readonly authorizationRegistry = new Map<AuthorizationContext, number>();

  private locationCounter = 0;
  private maskCounter = 0;

  nextLocationRequestId(): string {
    return `loc-${Date.now().toString(36)}-${++this.locationCounter}`;
  }

  nextMaskRequestId(): string {
    return `mask-${Date.now().toString(36)}-${++this.maskCounter}`;
  }

  /** True while any session has a running turn. */
  /**
   * Backend runs occupying the concurrency cap: running and starting turns,
   * and handoff preparation summaries (#61). Every admission check reads
   * this, so no kind of run can slip past the others.
   */
  activeRuns(): number {
    return this.running.size + this.startingSessions + this.handoffPreparations.size;
  }

  isTurnActive(): boolean {
    return this.running.size > 0;
  }

  /** Construct and synchronously register a context with its initial reference. */
  openAuthorization(input: {
    principalId: string;
    expiresAt: number;
    valid: boolean;
  }): AuthorizationContext {
    let initialReleased = false;
    const releaseReference = () => {
      const count = this.authorizationRegistry.get(authorization);
      if (count === undefined) return;
      if (count === 1) this.authorizationRegistry.delete(authorization);
      else this.authorizationRegistry.set(authorization, count - 1);
    };
    const authorization: AuthorizationContext = {
      [authorizationContextBrand]: true,
      ...input,
      retain: () => {
        const count = this.authorizationRegistry.get(authorization);
        if (count === undefined) {
          throw new Error("Cannot retain a released authorization context");
        }
        this.authorizationRegistry.set(authorization, count + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseReference();
        };
      },
      release: () => {
        if (initialReleased) return;
        initialReleased = true;
        releaseReference();
      },
    };
    this.authorizationRegistry.set(authorization, 1);
    return authorization;
  }

  /** Add principals whose registered authorization context has expired. */
  collectExpiredPrincipalIds(now: number, ids: Set<string>): void {
    for (const authorization of this.authorizationRegistry.keys()) {
      if (authorization.valid && authorization.expiresAt <= now) {
        ids.add(authorization.principalId);
      }
    }
  }

  /** Invalidate every registered context belonging to one of these principals. */
  invalidateAuthorizations(principalIds: ReadonlySet<string>): void {
    for (const authorization of this.authorizationRegistry.keys()) {
      if (principalIds.has(authorization.principalId)) authorization.valid = false;
    }
  }

  /**
   * Record revocation without aborting running work. Unstarted queued work is
   * removed per sender, while a current turn merely carries the invalid marker.
   */
  revokePrincipals(principalIds: ReadonlySet<string>): RunningTurn[] {
    const affectedRunning: RunningTurn[] = [];
    this.invalidateAuthorizations(principalIds);
    for (const turn of this.running) {
      if (principalIds.has(turn.principalId)) {
        affectedRunning.push(turn);
      }
      turn.queue = turn.queue.filter((entry) => {
        if (!principalIds.has(entry.principalId)) return true;
        entry.releaseAuthorization();
        return false;
      });
    }
    return affectedRunning;
  }

  /** Cancel every running turn (used on shutdown). */
  cancelAll(reason: string): boolean {
    const hadWork = this.running.size > 0 || this.startingBySession.size > 0;
    for (const starting of this.startingBySession.values()) {
      starting.cancelled = true;
      starting.queue.length = 0;
    }
    if (!hadWork) return false;
    for (const turn of [...this.running]) this.cancelTurn(turn, reason);
    return true;
  }

  /** Cancel a session's current turn and drop its queued follow-ups. */
  cancelTurn(turn: RunningTurn, reason: string): void {
    turn.cancelled = true;
    for (const entry of turn.queue.splice(0)) entry.releaseAuthorization();
    clearTimeout(turn.timeoutHandle);
    turn.abortController.abort();
    this.drainPendingForTurn(turn, reason);
  }

  /** Record now, or retain the actor across the pre-recorder startup window. */
  recordCancellation(turn: RunningTurn, principalId: string): void {
    if (turn.recorder) turn.recorder.recordCancellation(principalId);
    else turn.pendingCancellationPrincipalIds.push(principalId);
  }

  /** Resolve/reject every pending interactive request belonging to one turn. */
  drainPendingForTurn(turn: RunningTurn, reason: string): void {
    for (const [id, p] of this.pendingApprovals) {
      if (p.turn !== turn) continue;
      p.resolve({ behavior: "deny", message: reason });
      this.pendingApprovals.delete(id);
    }
    for (const [id, p] of this.pendingAskUser) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUser.delete(id);
    }
    for (const [id, p] of this.pendingAskUserList) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUserList.delete(id);
    }
    for (const [id, p] of this.pendingAskUserRank) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUserRank.delete(id);
    }
    for (const [id, p] of this.pendingAskUserForm) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUserForm.delete(id);
    }
    this.drainClientBoundForTurn(turn, reason);
  }

  /**
   * Reject only the requests that NEED a live client at this instant —
   * location and mask, whose sibling handlers already fail fast with no
   * client attached. Approvals and ask-user cards deliberately survive a
   * disconnect: on a phone the socket drops at every screen lock, and before
   * this split a pending approval was silently denied the moment the screen
   * went dark ("Client disconnected") while one raised DURING the dark parked
   * until the turn timeout. Both now hold, bounded by the turn timeout, and
   * re-deliver on reconnect.
   */
  drainClientBoundForTurn(turn: RunningTurn, reason: string): void {
    for (const [id, p] of this.pendingLocation) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingLocation.delete(id);
    }
    for (const [id, p] of this.pendingMask) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingMask.delete(id);
    }
  }

  /**
   * Interactive-request ids (tool-approval / ask-user / location) must be
   * globally unique so an inbound response resolves the correct turn's
   * promise. The current backends mint unique ids (SDK tool-use ids,
   * crypto.randomUUID, a host counter), so a collision across live turns means
   * a future backend broke that invariant — fail the new request loudly rather
   * than silently overwriting (and thus resolving) another turn's entry.
   */
  collidesAcrossTurns<T extends { turn: RunningTurn }>(
    map: Map<string, T>,
    id: string,
    turn: RunningTurn
  ): boolean {
    const existing = map.get(id);
    if (existing && existing.turn !== turn) {
      this.log?.emit({
        severityText: "ERROR",
        body: "interactive id collision: already pending for another turn",
        attributes: { "request.id": id },
      });
      return true;
    }
    return false;
  }

  /** Test seam: abort everything and clear all turn/pending state. */
  reset(): void {
    for (const turn of [...this.running]) {
      clearTimeout(turn.timeoutHandle);
      turn.abortController.abort();
      for (const entry of turn.queue.splice(0)) entry.releaseAuthorization();
    }
    for (const starting of this.startingBySession.values()) {
      starting.cancelled = true;
      starting.queue.length = 0;
    }
    this.startingBySession.clear();
    this.running.clear();
    this.bySession.clear();
    this.pendingApprovals.clear();
    this.pendingAskUser.clear();
    this.pendingAskUserList.clear();
    this.pendingAskUserRank.clear();
    this.pendingAskUserForm.clear();
    this.pendingLocation.clear();
    for (const preparation of this.handoffPreparations.values()) preparation.abort.abort();
    this.handoffPreparations.clear();
    this.handoffs.clear();
    this.startingSessions = 0;
  }
}
