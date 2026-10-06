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
  DraftRef,
  LocalExchange,
  MessageSource,
  QueuedFollowUpView,
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

/** How host work ended, from the host's point of view. */
export type HostWorkOutcome = "completed" | "cancelled" | "error" | "refused";

/**
 * Lifecycle hooks for one message submitted by host orchestration rather than
 * typed by a client (a committed live-conversation utterance, #957). The
 * session machinery calls `settle` on every exit — refused, dropped from a
 * queue, cancelled before starting, or finished — and an implementation must
 * treat repeats as no-ops. `posture: "voice"` makes a new turn declare
 * `enforceAllowedTools` and `noGrantSurface` (docs/decisions/voice-permission.md).
 */
export interface HostWork {
  posture: "voice";
  started(turnId: string): void;
  /** Every frame the turn emits, after host scoping. */
  observe(frame: import("@schlessera/brain-ui-sdk/protocol").ServerMessage): void;
  settle(outcome: HostWorkOutcome, detail?: { sessionId?: string | null; reason?: string }): void;
}

export interface QueuedFollowUp {
  /** Host-orchestrated work this entry carries; absent for client messages. */
  work?: HostWork;
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
  /** The saved draft revision this message was sent from (#979). */
  draftRef?: DraftRef;
  /** Accepted-work revision the host gave this request (#964); absent if unrecorded. */
  revision?: number;
  /** Queue-owned authorization lease, transferred to the runner on dequeue. */
  releaseAuthorization: () => void;
  /**
   * Host-minted identity and acceptance time, set when the entry joins a
   * queue (#1002). Clients key their pending follow-ups by it.
   */
  followUpId?: string;
  queuedAt?: number;
  /** Its pill label (#1004), once the host's label model has written one. */
  label?: string;
  /**
   * Set when this message was first handed to the backend as a live
   * follow-up and refused, because the backend had no running turn for it
   * (#1063). Its source was recorded then, and the local exchanges its
   * refused prompt took are carried here, so its own turn neither records
   * it twice nor loses them.
   */
  refusedFollowUp?: { exchanges: LocalExchange[] };
  /**
   * The order the host received it in. A queue is kept in this order, so a
   * refused live follow-up that rejoins it late still runs ahead of the
   * messages sent after it (#1063).
   */
  sendOrder?: number;
}

/**
 * Serialized bytes of one follow-up's text a report carries (#1002): its
 * JSON string on the wire, escapes included, since a control character
 * costs six bytes there. A full queue (`MAX_SESSION_QUEUE`, 50) then stays
 * near 400 KB, under the 512 KB frame bound, so the frame shrinker never
 * clips the list itself: every pending follow-up is always reported, and
 * only a very long prompt is shortened.
 */
export const FOLLOW_UP_VIEW_TEXT_BYTES = 8_000;

const wireBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");

/** Head of `text` within `bytes` serialized bytes, with an elision note when cut. */
export function boundFollowUpText(text: string, bytes: number = FOLLOW_UP_VIEW_TEXT_BYTES): string {
  if (wireBytes(text) <= bytes) return text;
  const budget = Math.max(0, bytes - 64);
  // The longest head that fits: wire size grows with length, so bisect.
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (wireBytes(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let head = text.slice(0, low);
  // Never end on half of a surrogate pair.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}\n…[${text.length - head.length} chars elided]`;
}

/** What a client is shown of one pending follow-up (#1002): no attachment bytes. */
export function followUpView(entry: QueuedFollowUp): QueuedFollowUpView {
  const text = boundFollowUpText(entry.text);
  return {
    id: entry.followUpId ?? "",
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    text,
    ...(text !== entry.text ? { textTruncated: true } : {}),
    ...(entry.attachments.length ? { attachmentCount: entry.attachments.length } : {}),
    ...(entry.files?.length ? { fileCount: entry.files.length } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    queuedAt: entry.queuedAt ?? 0,
    ...(entry.label ? { label: entry.label } : {}),
  };
}

/** Why a follow-up leaves when its sender's authorization ends (#1002). */
export const REVOKED_REASON = "Its sender was signed out.";

/** How a session's pending follow-ups just changed (#1002). */
export interface FollowUpQueueChange {
  /** The entry that just became the session's turn, and that turn's id. */
  started?: { entry: QueuedFollowUp; turnId: string };
  /** Entries that left without running, and why. */
  dropped?: { entries: readonly QueuedFollowUp[]; reason: string };
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
  /** The draft revision the current turn's message was sent from; replaced on dequeue. */
  draftRef?: DraftRef;
  /** Host-orchestrated work the CURRENT turn runs, if any; replaced on dequeue. */
  work?: HostWork;
  /**
   * Accepted-work revision (#964) of the request this slot currently holds,
   * from dequeue until its turn has finished; cleared in between, so a slot
   * between turns never claims one.
   */
  revision?: number;
  /** When the CURRENT turn was handed to the backend; unset until then and after it ends. */
  startedAt?: number;
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
  /**
   * The entry taken off `queue` to run next, until its turn reaches the
   * backend (#1002). Routing and billing are awaited in between, and the
   * message is still pending for that whole window: a client that reconnects
   * inside it must still see the pill.
   */
  handingOver?: QueuedFollowUp;
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

/**
 * The host's outcome for one permission request, kept after the request
 * leaves `pendingApprovals` so a late or repeated reply learns what actually
 * happened (#957). `expired` is a terminal turn that resolved the request
 * itself; it never needed a `tool_result`.
 */
export interface ToolResolutionRecord {
  outcome: "granted" | "denied" | "expired";
  turnId: string;
  sessionId: string | null;
  channel?: ApprovalChannel;
  reason?: string;
}

/** Settled outcomes retained for late replies; the oldest is evicted first. */
export const MAX_RESOLVED_APPROVALS = 512;

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

/** The four ask kinds, which share one request-id space. */
export type AskKind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";

/**
 * What became of an ask request that is no longer pending (#910). Kept so a
 * repeated or late answer, or a status query after a lost receipt, gets the
 * host's actual outcome instead of silence.
 */
export interface AskOutcome {
  requestId: string;
  sessionId: string | null;
  turnId: string;
  state: "accepted" | "closed";
  /** On `closed`: the turn ended, or the question was dismissed. */
  reason?: "ended" | "cancelled";
  /** On `accepted`: the submission that settled it, and who sent it. */
  submissionId?: string;
  principalId?: string;
  at: number;
}

/**
 * How long, and how many, ask outcomes the host remembers. 24 hours is the
 * client's maximum replay age (Queue A), so any answer a client may still
 * replay finds its outcome. The count bound keeps a host that asks a great
 * deal from growing this without limit; the oldest outcome goes first, and a
 * forgotten request answers `not_recognized`, which stops replay just the same.
 */
export const ASK_OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;
export const ASK_OUTCOME_MAX = 1024;

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
  readonly startingBySession = new Map<string, { queue: QueuedFollowUp[]; cancelled: boolean; revision?: number }>();
  /**
   * Sessions whose newest acceptance could not be recorded (#964). Their
   * recovery reads `unknown` until a later acceptance is recorded, so an
   * older persisted request can never stand in for newer work.
   */
  readonly unorderedSessions = new Set<string>();

  readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Settled permission outcomes by toolUseId, bounded by MAX_RESOLVED_APPROVALS. */
  readonly resolvedApprovals = new Map<string, ToolResolutionRecord>();
  /**
   * Told about every settled permission request, whichever path settled it.
   * Assigned by the owning WsHost, which publishes `tool_resolution`.
   */
  onApprovalSettled?: (toolUseId: string, record: ToolResolutionRecord) => void;
  /**
   * Told whenever a session's pending follow-ups change (#1002). Assigned by
   * the owning WsHost, which publishes `session_queue`.
   */
  onQueueChanged?: (sessionId: string, change: FollowUpQueueChange) => void;
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
  /** Settled and closed ask requests, by request id (see AskOutcome). */
  readonly askOutcomes = new Map<string, AskOutcome>();

  /** Every authorization context with at least one live owner or async lease. */
  readonly authorizationRegistry = new Map<AuthorizationContext, number>();

  /**
   * A session's follow-ups that the agent has not received yet, in send
   * order (#1002): the one being handed over, then the queue. A session still
   * routing its first message holds its queue in `startingBySession`.
   */
  pendingFollowUps(sessionId: string): QueuedFollowUp[] {
    // The same precedence as chat dispatch, which queues into a start first.
    const starting = this.startingBySession.get(sessionId);
    if (starting) return [...starting.queue];
    const turn = this.bySession.get(sessionId);
    return turn ? [...(turn.handingOver ? [turn.handingOver] : []), ...turn.queue] : [];
  }

  /** Every session that has at least one pending follow-up. */
  sessionsWithFollowUps(): string[] {
    const ids = new Set<string>();
    for (const [sessionId, turn] of this.bySession) {
      if (turn.handingOver || turn.queue.length > 0) ids.add(sessionId);
    }
    for (const [sessionId, starting] of this.startingBySession) {
      if (starting.queue.length > 0) ids.add(sessionId);
    }
    return [...ids];
  }

  /** Report a change to a session's pending follow-ups; a no-op without a session. */
  queueChanged(sessionId: string | null, change: FollowUpQueueChange = {}): void {
    if (!sessionId) return;
    // Dropping nothing changed nothing.
    if (change.dropped?.entries.length === 0 && !change.started) return;
    this.onQueueChanged?.(sessionId, change);
  }

  /**
   * Take every pending follow-up off a turn without running it: the queue
   * and the entry being handed over. Leases are released by the caller's
   * own path (the slot's loop releases a handed-over entry itself).
   */
  private takePending(turn: RunningTurn): { taken: QueuedFollowUp[]; handingOver?: QueuedFollowUp } {
    const handingOver = turn.handingOver;
    turn.handingOver = undefined;
    return { taken: turn.queue.splice(0), ...(handingOver ? { handingOver } : {}) };
  }

  /** Drop a session start's queue, releasing each lease, and report it. */
  dropStartingQueue(sessionId: string, starting: { queue: QueuedFollowUp[] }, reason: string): void {
    const dropped = starting.queue.splice(0);
    for (const entry of dropped) entry.releaseAuthorization();
    this.queueChanged(sessionId, { dropped: { entries: dropped, reason } });
  }

  /** Remember what became of an ask request, within the TTL/count bounds. */
  recordAskOutcome(outcome: AskOutcome): void {
    const cutoff = outcome.at - ASK_OUTCOME_TTL_MS;
    for (const [id, existing] of this.askOutcomes) {
      if (existing.at > cutoff && this.askOutcomes.size < ASK_OUTCOME_MAX) break;
      this.askOutcomes.delete(id);
    }
    // Re-inserting moves the entry to the end, so map order stays age order.
    this.askOutcomes.delete(outcome.requestId);
    this.askOutcomes.set(outcome.requestId, outcome);
  }

  /** The outcome for a request id, unless it has aged out. */
  askOutcome(requestId: string, now = Date.now()): AskOutcome | undefined {
    const outcome = this.askOutcomes.get(requestId);
    if (!outcome) return undefined;
    if (outcome.at <= now - ASK_OUTCOME_TTL_MS) {
      this.askOutcomes.delete(requestId);
      return undefined;
    }
    return outcome;
  }

  private closeAsk(p: { turn: RunningTurn; turnId: string; requestId: string }, reason: "ended" | "cancelled"): void {
    this.recordAskOutcome({
      requestId: p.requestId,
      sessionId: p.turn.sessionId,
      turnId: p.turnId,
      state: "closed",
      reason,
      at: Date.now(),
    });
  }

  /**
   * Remove a pending ask of any kind and record why. Used by dismissal; a
   * turn ending goes through drainPendingForTurn.
   */
  cancelAsk(requestId: string): void {
    const p =
      this.pendingAskUser.get(requestId) ??
      this.pendingAskUserList.get(requestId) ??
      this.pendingAskUserRank.get(requestId) ??
      this.pendingAskUserForm.get(requestId);
    this.pendingAskUser.delete(requestId);
    this.pendingAskUserList.delete(requestId);
    this.pendingAskUserRank.delete(requestId);
    this.pendingAskUserForm.delete(requestId);
    if (p) this.closeAsk(p, "cancelled");
  }

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
      const dropped: QueuedFollowUp[] = [];
      turn.queue = turn.queue.filter((entry) => {
        if (!principalIds.has(entry.principalId)) return true;
        entry.releaseAuthorization();
        dropped.push(entry);
        return false;
      });
      // A handed-over entry is dropped by the slot's own authorization check
      // before it reaches the backend, which reports it there.
      this.queueChanged(turn.sessionId, { dropped: { entries: dropped, reason: REVOKED_REASON } });
    }
    return affectedRunning;
  }

  /** Cancel every running turn (used on shutdown). */
  cancelAll(reason: string): boolean {
    const hadWork = this.running.size > 0 || this.startingBySession.size > 0;
    for (const [sessionId, starting] of this.startingBySession) {
      starting.cancelled = true;
      // Release, never truncate: each entry's lease settles host work it carries.
      this.dropStartingQueue(sessionId, starting, reason);
    }
    if (!hadWork) return false;
    for (const turn of [...this.running]) this.cancelTurn(turn, reason);
    return true;
  }

  /** Cancel a session's current turn and drop its queued follow-ups. */
  cancelTurn(turn: RunningTurn, reason: string): void {
    turn.cancelled = true;
    // The handed-over entry's lease belongs to the slot's loop, which
    // releases it on the way out; it is reported as dropped here.
    const { taken, handingOver } = this.takePending(turn);
    for (const entry of taken) entry.releaseAuthorization();
    this.queueChanged(turn.sessionId, {
      dropped: { entries: handingOver ? [handingOver, ...taken] : taken, reason },
    });
    clearTimeout(turn.timeoutHandle);
    turn.abortController.abort();
    this.drainPendingForTurn(turn, reason);
  }

  /** Record now, or retain the actor across the pre-recorder startup window. */
  recordCancellation(turn: RunningTurn, principalId: string): void {
    if (turn.recorder) turn.recorder.recordCancellation(principalId);
    else turn.pendingCancellationPrincipalIds.push(principalId);
  }

  /** Record a settled permission outcome and tell the host. */
  recordApprovalOutcome(toolUseId: string, record: ToolResolutionRecord): void {
    this.resolvedApprovals.delete(toolUseId);
    this.resolvedApprovals.set(toolUseId, record);
    while (this.resolvedApprovals.size > MAX_RESOLVED_APPROVALS) {
      const oldest = this.resolvedApprovals.keys().next().value;
      if (oldest === undefined) break;
      this.resolvedApprovals.delete(oldest);
    }
    this.onApprovalSettled?.(toolUseId, record);
  }

  /** Resolve/reject every pending interactive request belonging to one turn. */
  drainPendingForTurn(turn: RunningTurn, reason: string): void {
    for (const [id, p] of this.pendingApprovals) {
      if (p.turn !== turn) continue;
      p.resolve({ behavior: "deny", message: reason });
      this.pendingApprovals.delete(id);
      // A terminal turn settles its own cards: no tool_result is coming, and
      // a client must be able to clear the card without waiting for one.
      this.recordApprovalOutcome(id, { outcome: "expired", turnId: p.turnId, sessionId: p.turn.sessionId, reason });
    }
    for (const [id, p] of this.pendingAskUser) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUser.delete(id);
      this.closeAsk(p, "ended");
    }
    for (const [id, p] of this.pendingAskUserList) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUserList.delete(id);
      this.closeAsk(p, "ended");
    }
    for (const [id, p] of this.pendingAskUserRank) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUserRank.delete(id);
      this.closeAsk(p, "ended");
    }
    for (const [id, p] of this.pendingAskUserForm) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.pendingAskUserForm.delete(id);
      this.closeAsk(p, "ended");
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
      // Release, never truncate: each entry's lease settles host work it carries.
      for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
    }
    this.startingBySession.clear();
    this.unorderedSessions.clear();
    this.running.clear();
    this.bySession.clear();
    this.pendingApprovals.clear();
    this.resolvedApprovals.clear();
    this.pendingAskUser.clear();
    this.pendingAskUserList.clear();
    this.pendingAskUserRank.clear();
    this.pendingAskUserForm.clear();
    this.askOutcomes.clear();
    this.pendingLocation.clear();
    for (const preparation of this.handoffPreparations.values()) preparation.abort.abort();
    this.handoffPreparations.clear();
    this.handoffs.clear();
    this.startingSessions = 0;
  }
}
