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
 * treat repeats as no-ops. Live conversations use `interactive` policy, matching
 * typed work (#3070). Explicit legacy `voice` work retains its restrictions.
 */
export interface HostWork {
  posture: "interactive" | "voice";
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
  lifecycleTurnId?: string;
  lifecycle?: ReturnType<typeof import("../activity/turn-lifecycle.js").createTurnLifecycle>;
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
const FOLLOW_UP_VIEW_TEXT_BYTES = 8_000;

const wireBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");

/** Head of `text` within `bytes` serialized bytes, with an elision note when cut. */
function boundFollowUpText(text: string, bytes: number = FOLLOW_UP_VIEW_TEXT_BYTES): string {
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
  entry: Pick<QueuedFollowUp, "text" | "attachments" | "files" | "refusedFollowUp">
): number {
  let bytes = Buffer.byteLength(entry.text, "utf-8");
  for (const attachment of entry.attachments) {
    bytes += attachment.data.length;
  }
  // A refused follow-up holds the exchanges its prompt took until it runs.
  const exchanges = entry.refusedFollowUp?.exchanges;
  if (exchanges?.length) bytes += Buffer.byteLength(JSON.stringify(exchanges), "utf8");
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
  shareId?: string;
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
  /** When host admission started for the CURRENT turn; cleared after it ends. */
  startedAt?: number;
  /** True only while the backend owns this turn; preparation cannot accept live injection. */
  backendStarted?: boolean;
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
   * The turn the host's hard elapsed-time limit ended (#3356). Set by the
   * timeout itself, never inferred from an aborted signal, so a cancel or a
   * journal/egress abort is never reported as a timeout. Keyed by turn id
   * because a queued follow-up reuses this slot.
   */
  timedOutTurnId?: string;
  /**
   * Terminal disposition of the CURRENT turn's `result` frame, when one has
   * streamed. Backends RESOLVE startTurn for runtime failures (the failure
   * rides the result frame as outcome "error"), so completion accounting must
   * read this — a resolved startTurn alone does not mean the turn succeeded.
   * Reset when a queued follow-up becomes the next turn.
   */
  lastResult: "success" | "error" | "cancelled" | null;
  /**
   * Live follow-ups handed to the backend whose delivery has not settled. A
   * refused one rejoins the queue (#1063), so the slot lets them settle
   * before it starts the next queued turn.
   */
  deliveries?: Set<Promise<void>>;
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
interface ToolResolutionRecord {
  outcome: "granted" | "denied" | "expired";
  turnId: string;
  sessionId: string | null;
  channel?: ApprovalChannel;
  reason?: string;
}

/** Settled outcomes retained for late replies; the oldest is evicted first. */
const MAX_RESOLVED_APPROVALS = 512;

interface PendingAskUser {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingApproval.request. */
  requestId: string;
  questions: AskUserQuestion[];
  resolve: (result: AskUserResult) => void;
  reject: (err: Error) => void;
}

interface PendingAskUserList {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingAskUser.questions. */
  requestId: string;
  request: AskUserListSpec;
  resolve: (result: AskUserListResult) => void;
  reject: (err: Error) => void;
}

interface PendingAskUserRank {
  turn: RunningTurn;
  turnId: string;
  /** Kept for re-delivery on reconnect, like PendingAskUser.questions. */
  requestId: string;
  request: AskUserRankSpec;
  resolve: (result: AskUserRankResult) => void;
  reject: (err: Error) => void;
}

interface PendingAskUserForm {
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

/** One pending ask of any kind. The kinds share one id space, so they share one map. */
export type PendingAsk =
  | { kind: "ask_user"; entry: PendingAskUser }
  | { kind: "ask_user_list"; entry: PendingAskUserList }
  | { kind: "ask_user_rank"; entry: PendingAskUserRank }
  | { kind: "ask_user_form"; entry: PendingAskUserForm };

/** The entry type a pending ask of kind `K` carries. */
type PendingAskEntry<K extends AskKind> = Extract<PendingAsk, { kind: K }>["entry"];

/** A session start reserved before asynchronous backend routing finishes. */
export interface StartingSession {
  queue: QueuedFollowUp[];
  cancelled: boolean;
  revision?: number;
}

/** A handoff creation in flight (#61); `sessionId` is set once its destination exists. */
interface PendingHandoff {
  sessionId?: string;
}

/** A running handoff preparation summary (#61). */
interface HandoffPreparation {
  abort: AbortController;
  owner: unknown;
}

/** What a coordinator reports to, fixed when it is constructed. */
interface TurnCoordinatorOptions {
  /** Where collisions are reported; absent (a bare coordinator in a test) means silence. */
  log?: Logger;
  /** Told about every settled permission request, whichever path settled it. */
  onApprovalSettled?: (toolUseId: string, record: ToolResolutionRecord) => void;
  /** Told whenever a session's pending follow-ups change (#1002). */
  onQueueChanged?: (sessionId: string, change: FollowUpQueueChange) => void;
}

/**
 * What became of an ask request that is no longer pending (#910). Kept so a
 * repeated or late answer, or a status query after a lost receipt, gets the
 * host's actual outcome instead of silence.
 */
interface AskOutcome {
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
const ASK_OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;
const ASK_OUTCOME_MAX = 1024;

interface PendingLocation {
  turn: RunningTurn;
  turnId: string;
  resolve: (result: LocationFix) => void;
  reject: (err: Error) => void;
}

interface PendingMask {
  turn: RunningTurn;
  turnId: string;
  resolve: (png: Uint8Array) => void;
  reject: (err: Error) => void;
}


/** The ask kinds in the order every per-kind walk visits them. */
const ASK_KINDS: readonly AskKind[] = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"];

/**
 * Mutable turn state for one ws host: the running session slots and every
 * pending interactive round-trip. This used to be six module-level globals
 * inside a 976-line handler; as instance state it is testable and owned by an
 * explicit object with a defined lifecycle.
 *
 * Every collection is private (#2515). Other modules read it through
 * read-only views and change it only through the intent methods below, so
 * each invariant (remove before settling, record the outcome, keep the
 * starting count and the session index in step) is written once, here.
 */
export class TurnCoordinator {
  readonly #log?: Logger;
  readonly #onApprovalSettled?: (toolUseId: string, record: ToolResolutionRecord) => void;
  readonly #onQueueChanged?: (sessionId: string, change: FollowUpQueueChange) => void;

  readonly #running = new Set<RunningTurn>();
  readonly #bySession = new Map<string, RunningTurn>();
  #startingSessions = 0;
  readonly #startingBySession = new Map<string, StartingSession>();
  readonly #unorderedSessions = new Set<string>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #resolvedApprovals = new Map<string, ToolResolutionRecord>();
  readonly #asks = new Map<string, PendingAsk>();
  readonly #pendingLocation = new Map<string, PendingLocation>();
  readonly #pendingMask = new Map<string, PendingMask>();
  readonly #handoffs = new Map<string, PendingHandoff>();
  readonly #handoffPreparations = new Map<string, HandoffPreparation>();
  readonly #askOutcomes = new Map<string, AskOutcome>();
  /** The last drain of each turn's interactive requests, by the turn id it ended (#3553). */
  readonly #drained = new WeakMap<RunningTurn, { turnId: string; reason: string }>();
  readonly #authorizationRegistry = new Map<AuthorizationContext, number>();

  constructor(options: TurnCoordinatorOptions = {}) {
    this.#log = options.log;
    this.#onApprovalSettled = options.onApprovalSettled;
    this.#onQueueChanged = options.onQueueChanged;
  }

  /** Every running session slot. */
  get running(): ReadonlySet<RunningTurn> {
    return this.#running;
  }

  /** Running slots by the session id they have been bound to. */
  get bySession(): ReadonlyMap<string, RunningTurn> {
    return this.#bySession;
  }

  /** Session starts still resolving their backend, counted against the concurrency cap. */
  get startingSessions(): number {
    return this.#startingSessions;
  }

  /** Known sessions reserved before asynchronous backend routing. */
  get startingBySession(): ReadonlyMap<string, StartingSession> {
    return this.#startingBySession;
  }

  /**
   * Sessions whose newest acceptance could not be recorded (#964). Their
   * recovery reads `unknown` until a later acceptance is recorded, so an
   * older persisted request can never stand in for newer work.
   */
  get unorderedSessions(): ReadonlySet<string> {
    return this.#unorderedSessions;
  }

  /** Permission requests waiting for an answer, by toolUseId. */
  get pendingApprovals(): ReadonlyMap<string, PendingApproval> {
    return this.#pendingApprovals;
  }

  /** Settled permission outcomes by toolUseId, bounded by MAX_RESOLVED_APPROVALS. */
  get resolvedApprovals(): ReadonlyMap<string, ToolResolutionRecord> {
    return this.#resolvedApprovals;
  }

  /** Pending `ask_user` requests, in the order they were opened. */
  get pendingAskUser(): ReadonlyMap<string, PendingAskUser> {
    return this.pendingAsks("ask_user");
  }

  /** Pending `ask_user_list` requests, in the order they were opened. */
  get pendingAskUserList(): ReadonlyMap<string, PendingAskUserList> {
    return this.pendingAsks("ask_user_list");
  }

  /** Pending `ask_user_rank` requests, in the order they were opened. */
  get pendingAskUserRank(): ReadonlyMap<string, PendingAskUserRank> {
    return this.pendingAsks("ask_user_rank");
  }

  /** Pending `ask_user_form` requests, in the order they were opened. */
  get pendingAskUserForm(): ReadonlyMap<string, PendingAskUserForm> {
    return this.pendingAsks("ask_user_form");
  }

  /** Location requests waiting for the client. */
  get pendingLocation(): ReadonlyMap<string, PendingLocation> {
    return this.#pendingLocation;
  }

  /** Mask requests waiting for the client. */
  get pendingMask(): ReadonlyMap<string, PendingMask> {
    return this.#pendingMask;
  }

  /**
   * Handoff creations in flight, by client-minted key (#61). Present from
   * acceptance until the destination is recorded or the attempt ends, so a
   * repeated key answers `pending` instead of starting a second session.
   */
  get handoffs(): ReadonlyMap<string, PendingHandoff> {
    return this.#handoffs;
  }

  /** Running handoff preparation summaries, by handoff key (#61). */
  get handoffPreparations(): ReadonlyMap<string, HandoffPreparation> {
    return this.#handoffPreparations;
  }

  /** Every authorization context with at least one live owner or async lease. */
  get authorizationRegistry(): ReadonlyMap<AuthorizationContext, number> {
    return this.#authorizationRegistry;
  }

  /**
   * A session's follow-ups that the agent has not received yet, in send
   * order (#1002): the one being handed over, then the queue. A session still
   * routing its first message holds its queue in `startingBySession`.
   */
  pendingFollowUps(sessionId: string): QueuedFollowUp[] {
    // The same precedence as chat dispatch, which queues into a start first.
    const starting = this.#startingBySession.get(sessionId);
    if (starting) return [...starting.queue];
    const turn = this.#bySession.get(sessionId);
    return turn ? [...(turn.handingOver ? [turn.handingOver] : []), ...turn.queue] : [];
  }

  /** Every session that has at least one pending follow-up. */
  sessionsWithFollowUps(): string[] {
    const ids = new Set<string>();
    for (const [sessionId, turn] of this.#bySession) {
      if (turn.handingOver || turn.queue.length > 0) ids.add(sessionId);
    }
    for (const [sessionId, starting] of this.#startingBySession) {
      if (starting.queue.length > 0) ids.add(sessionId);
    }
    return [...ids];
  }

  /** Report a change to a session's pending follow-ups; a no-op without a session. */
  queueChanged(sessionId: string | null, change: FollowUpQueueChange = {}): void {
    if (!sessionId) return;
    // Dropping nothing changed nothing.
    if (change.dropped?.entries.length === 0 && !change.started) return;
    this.#onQueueChanged?.(sessionId, change);
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

  /**
   * Count a session start against the concurrency cap and, for a known
   * session, reserve it so chat dispatch queues behind it. Pair with
   * `endStarting` on every exit.
   */
  beginStarting(sessionId: string | null | undefined, starting: StartingSession): void {
    if (sessionId) this.#startingBySession.set(sessionId, starting);
    this.#startingSessions += 1;
  }

  /** End a start begun with `beginStarting`; a newer reservation for the session is kept. */
  endStarting(sessionId: string | null | undefined, starting: StartingSession): void {
    this.#startingSessions = Math.max(0, this.#startingSessions - 1);
    if (sessionId && this.#startingBySession.get(sessionId) === starting) {
      this.#startingBySession.delete(sessionId);
    }
  }

  /** Make a slot running, indexed by its session once it has one. */
  registerTurn(turn: RunningTurn): void {
    this.#running.add(turn);
    if (turn.sessionId) this.#bySession.set(turn.sessionId, turn);
  }

  /** Index a running slot under the session id its backend just named. */
  bindSession(sessionId: string, turn: RunningTurn): void {
    this.#bySession.set(sessionId, turn);
  }

  /** Remove an ended slot; a newer slot indexed under the same session is kept. */
  unregisterTurn(turn: RunningTurn): void {
    if (turn.sessionId && this.#bySession.get(turn.sessionId) === turn) {
      this.#bySession.delete(turn.sessionId);
    }
    this.#running.delete(turn);
  }

  /** Record whether a session's newest acceptance was stored, ordering its recovery (#964). */
  setSessionOrdered(sessionId: string, ordered: boolean): void {
    if (ordered) this.#unorderedSessions.delete(sessionId);
    else this.#unorderedSessions.add(sessionId);
  }

  /** Reserve a handoff key (#61) until `releaseHandoff` is called with the same entry. */
  registerHandoff(handoffId: string, entry: PendingHandoff): void {
    this.#handoffs.set(handoffId, entry);
  }

  /** Release a handoff key, unless a newer attempt holds it. */
  releaseHandoff(handoffId: string, entry: PendingHandoff): void {
    if (this.#handoffs.get(handoffId) === entry) this.#handoffs.delete(handoffId);
  }

  /** Track a running handoff preparation summary (#61); it counts as an active run. */
  registerHandoffPreparation(handoffId: string, preparation: HandoffPreparation): void {
    this.#handoffPreparations.set(handoffId, preparation);
  }

  /** Stop tracking a preparation, unless a newer one holds the key. */
  releaseHandoffPreparation(handoffId: string, abort: AbortController): void {
    if (this.#handoffPreparations.get(handoffId)?.abort === abort) this.#handoffPreparations.delete(handoffId);
  }

  /** Remember what became of an ask request, within the TTL/count bounds. */
  recordAskOutcome(outcome: AskOutcome): void {
    const cutoff = outcome.at - ASK_OUTCOME_TTL_MS;
    for (const [id, existing] of this.#askOutcomes) {
      if (existing.at > cutoff && this.#askOutcomes.size < ASK_OUTCOME_MAX) break;
      this.#askOutcomes.delete(id);
    }
    // Re-inserting moves the entry to the end, so map order stays age order.
    this.#askOutcomes.delete(outcome.requestId);
    this.#askOutcomes.set(outcome.requestId, outcome);
  }

  /** The outcome for a request id, unless it has aged out. */
  askOutcome(requestId: string, now = Date.now()): AskOutcome | undefined {
    const outcome = this.#askOutcomes.get(requestId);
    if (!outcome) return undefined;
    if (outcome.at <= now - ASK_OUTCOME_TTL_MS) {
      this.#askOutcomes.delete(requestId);
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

  /** The pending ask with this id, of whichever kind. */
  pendingAsk(requestId: string): PendingAsk | undefined {
    return this.#asks.get(requestId);
  }

  /** Pending asks of one kind, in the order they were opened. */
  pendingAsks<K extends AskKind>(kind: K): ReadonlyMap<string, PendingAskEntry<K>> {
    const asks = new Map<string, PendingAskEntry<K>>();
    for (const [id, ask] of this.#asks) {
      if (ask.kind === kind) asks.set(id, ask.entry as PendingAskEntry<K>);
    }
    return asks;
  }

  /**
   * Open an ask unless its id is already pending, and say whether it opened.
   *
   * The rule differs by kind today, and is preserved here until #2773 rules
   * on one: `ask_user` and `ask_user_list` replace their own kind's entry
   * from the same turn and refuse (and log) one from another turn, while any
   * other pending id refuses every kind without a log.
   */
  openAsk<K extends AskKind>(kind: K, entry: PendingAskEntry<K>): boolean {
    const existing = this.#asks.get(entry.requestId);
    if (existing) {
      if (existing.kind !== kind || (kind !== "ask_user" && kind !== "ask_user_list")) return false;
      if (this.collides(existing.entry, entry.requestId, entry.turn)) return false;
    }
    this.#asks.set(entry.requestId, { kind, entry } as PendingAsk);
    return true;
  }

  /**
   * Settle a pending ask with an answer: remove it and record who accepted
   * it. The caller resolves the entry's promise with the answer.
   */
  acceptAsk(ask: PendingAsk, submission: { submissionId: string; principalId: string }): void {
    const { entry } = ask;
    if (this.#asks.get(entry.requestId) === ask) this.#asks.delete(entry.requestId);
    this.recordAskOutcome({
      requestId: entry.requestId,
      sessionId: entry.turn.sessionId,
      turnId: entry.turnId,
      state: "accepted",
      submissionId: submission.submissionId,
      principalId: submission.principalId,
      at: Date.now(),
    });
  }

  /**
   * Remove a pending ask of any kind and record why. Used by dismissal; a
   * turn ending goes through drainPendingForTurn.
   */
  cancelAsk(requestId: string): void {
    const p = this.#asks.get(requestId);
    this.#asks.delete(requestId);
    if (p) this.closeAsk(p.entry, "cancelled");
  }

  /** Open a permission request unless another turn holds its id; says whether it opened. */
  openApproval(toolUseId: string, entry: PendingApproval): boolean {
    if (this.collides(this.#pendingApprovals.get(toolUseId), toolUseId, entry.turn)) return false;
    this.#pendingApprovals.set(toolUseId, entry);
    return true;
  }

  /**
   * Remove a pending permission request that `accepts` matches, so no other
   * path can settle it, and return it. Settle it with `settleApproval`.
   */
  claimApproval(toolUseId: string, accepts: (p: PendingApproval) => boolean = () => true): PendingApproval | undefined {
    const p = this.#pendingApprovals.get(toolUseId);
    if (!p || !accepts(p)) return undefined;
    this.#pendingApprovals.delete(toolUseId);
    return p;
  }

  /** Answer a claimed permission request and record its outcome. */
  settleApproval(
    toolUseId: string,
    claimed: PendingApproval,
    decision: PermissionDecision,
    response: { principalId: string; always?: boolean; channel?: ApprovalChannel }
  ): void {
    claimed.resolve(decision, response);
    this.recordApprovalOutcome(toolUseId, {
      outcome: decision.behavior === "deny" ? "denied" : "granted",
      turnId: claimed.turnId,
      sessionId: claimed.turn.sessionId,
      ...(response.channel ? { channel: response.channel } : {}),
    });
  }

  /** Open a location request unless another turn holds its id; says whether it opened. */
  openLocation(requestId: string, entry: PendingLocation): boolean {
    if (this.collides(this.#pendingLocation.get(requestId), requestId, entry.turn)) return false;
    this.#pendingLocation.set(requestId, entry);
    return true;
  }

  /** Remove and return a pending location request that `accepts` matches; the caller settles it. */
  claimLocation(requestId: string, accepts: (p: PendingLocation) => boolean = () => true): PendingLocation | undefined {
    const p = this.#pendingLocation.get(requestId);
    if (!p || !accepts(p)) return undefined;
    this.#pendingLocation.delete(requestId);
    return p;
  }

  /** Open a mask request unless another turn holds its id; says whether it opened. */
  openMask(requestId: string, entry: PendingMask): boolean {
    if (this.collides(this.#pendingMask.get(requestId), requestId, entry.turn)) return false;
    this.#pendingMask.set(requestId, entry);
    return true;
  }

  /** Remove and return a pending mask request that `accepts` matches; the caller settles it. */
  claimMask(requestId: string, accepts: (p: PendingMask) => boolean = () => true): PendingMask | undefined {
    const p = this.#pendingMask.get(requestId);
    if (!p || !accepts(p)) return undefined;
    this.#pendingMask.delete(requestId);
    return p;
  }

  private locationCounter = 0;
  private maskCounter = 0;

  nextLocationRequestId(): string {
    return `loc-${Date.now().toString(36)}-${++this.locationCounter}`;
  }

  nextMaskRequestId(): string {
    return `mask-${Date.now().toString(36)}-${++this.maskCounter}`;
  }

  /**
   * Backend runs occupying the concurrency cap: running and starting turns,
   * and handoff preparation summaries (#61). Every admission check reads
   * this, so no kind of run can slip past the others.
   */
  activeRuns(): number {
    return this.#running.size + this.#startingSessions + this.#handoffPreparations.size;
  }

  /** True while any session has a running turn. */
  isTurnActive(): boolean {
    return this.#running.size > 0;
  }

  /** Construct and synchronously register a context with its initial reference. */
  openAuthorization(input: {
    principalId: string;
    expiresAt: number;
    valid: boolean;
  }): AuthorizationContext {
    const registry = this.#authorizationRegistry;
    let initialReleased = false;
    const releaseReference = () => {
      const count = registry.get(authorization);
      if (count === undefined) return;
      if (count === 1) registry.delete(authorization);
      else registry.set(authorization, count - 1);
    };
    const authorization: AuthorizationContext = {
      [authorizationContextBrand]: true,
      ...input,
      retain: () => {
        const count = registry.get(authorization);
        if (count === undefined) {
          throw new Error("Cannot retain a released authorization context");
        }
        registry.set(authorization, count + 1);
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
    registry.set(authorization, 1);
    return authorization;
  }

  /** Add principals whose registered authorization context has expired. */
  collectExpiredPrincipalIds(now: number, ids: Set<string>): void {
    for (const authorization of this.#authorizationRegistry.keys()) {
      if (authorization.valid && authorization.expiresAt <= now) {
        ids.add(authorization.principalId);
      }
    }
  }

  /** Invalidate every registered context belonging to one of these principals. */
  invalidateAuthorizations(principalIds: ReadonlySet<string>): void {
    for (const authorization of this.#authorizationRegistry.keys()) {
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
    for (const turn of this.#running) {
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

  /**
   * Cancel every running turn and session start (used on shutdown), then
   * settle any pending request whose turn is no longer running, so nothing a
   * caller awaits is left unsettled. Returns whether any turn or start was
   * cancelled.
   */
  cancelAll(reason: string): boolean {
    const hadWork = this.#running.size > 0 || this.#startingBySession.size > 0;
    for (const [sessionId, starting] of this.#startingBySession) {
      starting.cancelled = true;
      // Release, never truncate: each entry's lease settles host work it carries.
      this.dropStartingQueue(sessionId, starting, reason);
    }
    for (const turn of [...this.#running]) this.cancelTurn(turn, reason);
    const orphaned = new Set<RunningTurn>();
    for (const p of this.#pendingApprovals.values()) orphaned.add(p.turn);
    for (const p of this.#asks.values()) orphaned.add(p.entry.turn);
    for (const p of this.#pendingLocation.values()) orphaned.add(p.turn);
    for (const p of this.#pendingMask.values()) orphaned.add(p.turn);
    for (const turn of orphaned) this.drainPendingForTurn(turn, reason);
    return hadWork;
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
    this.#resolvedApprovals.delete(toolUseId);
    this.#resolvedApprovals.set(toolUseId, record);
    while (this.#resolvedApprovals.size > MAX_RESOLVED_APPROVALS) {
      const oldest = this.#resolvedApprovals.keys().next().value;
      if (oldest === undefined) break;
      this.#resolvedApprovals.delete(oldest);
    }
    this.#onApprovalSettled?.(toolUseId, record);
  }

  /**
   * Why this turn's interactive requests were drained, when they were for
   * this turn id. A drain runs once, so a request a backend raises after it
   * (a turn limit that ran out before the question reached the bridge) would
   * never settle and would park startTurn until restart (#3553). Openers
   * refuse with this reason instead.
   */
  drainedReason(turn: RunningTurn, turnId: string): string | undefined {
    const drained = this.#drained.get(turn);
    return drained?.turnId === turnId ? drained.reason : undefined;
  }

  /**
   * Refuse an ask raised after its turn's drain: record it closed as ended,
   * as the drain would have, and return the drain's reason. Undefined when
   * the turn's requests were not drained and the ask may open.
   */
  refuseDrainedAsk(p: { turn: RunningTurn; turnId: string; requestId: string }): string | undefined {
    const reason = this.drainedReason(p.turn, p.turnId);
    if (reason !== undefined) this.closeAsk(p, "ended");
    return reason;
  }

  /** Resolve/reject every pending interactive request belonging to one turn. */
  drainPendingForTurn(turn: RunningTurn, reason: string): void {
    // Kept only for the first drain: it is the reason the turn ended.
    if (this.#drained.get(turn)?.turnId !== turn.turnId) this.#drained.set(turn, { turnId: turn.turnId, reason });
    for (const [id, p] of this.#pendingApprovals) {
      if (p.turn !== turn) continue;
      p.resolve({ behavior: "deny", message: reason });
      this.#pendingApprovals.delete(id);
      // A terminal turn settles its own cards: no tool_result is coming, and
      // a client must be able to clear the card without waiting for one.
      this.recordApprovalOutcome(id, { outcome: "expired", turnId: p.turnId, sessionId: p.turn.sessionId, reason });
    }
    // Kind by kind, in the order the per-kind maps were once drained.
    for (const kind of ASK_KINDS) {
      for (const [id, { kind: pendingKind, entry: p }] of this.#asks) {
        if (pendingKind !== kind || p.turn !== turn) continue;
        p.reject(new Error(reason));
        this.#asks.delete(id);
        this.closeAsk(p, "ended");
      }
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
    for (const [id, p] of this.#pendingLocation) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.#pendingLocation.delete(id);
    }
    for (const [id, p] of this.#pendingMask) {
      if (p.turn !== turn) continue;
      p.reject(new Error(reason));
      this.#pendingMask.delete(id);
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
  private collides(existing: { turn: RunningTurn } | undefined, id: string, turn: RunningTurn): boolean {
    if (existing && existing.turn !== turn) {
      this.#log?.emit({
        severityText: "ERROR",
        body: "interactive id collision: already pending for another turn",
        attributes: { "request.id": id },
      });
      return true;
    }
    return false;
  }
}
