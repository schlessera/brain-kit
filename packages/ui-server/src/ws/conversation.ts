/**
 * Host orchestration for live conversations (#957).
 *
 * A `LiveConversationProvider` streams voice in and out; this module decides
 * what any of it means. It owns the identities — conversation, epoch,
 * utterance, request, host turn — and binds a provider's advisory work
 * requests to them only after a semantic commit from the client. Work runs
 * through the ordinary chat path (`handleChatMessage`), so the backend's
 * startTurn/followUp capabilities, the session queue and the permission
 * bridge are the same ones a typed message gets. One conversation submits one
 * request at a time, so its work never runs as parallel turns of one session.
 *
 * Results are returned to the provider only while the request's epoch is
 * still the live one, the conversation is open, the provider has not
 * withdrawn the request and the host work completed or failed. Anything else
 * keeps the host outcome and discards the narration.
 */

import {
  CONVERSATION_LIMITS,
  type ClientConversationAudio,
  type ClientConversationCommit,
  type ClientConversationEndpoint,
  type ClientConversationPlayback,
  type ClientConversationStart,
  type ClientConversationStop,
  type ConversationCloseReason,
  type ConversationOutputRecord,
  type ConversationWorkReceipt,
  type ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  assertLiveConversationSession,
  parseLiveConversationEvent,
  type LiveConversationEvent,
  type LiveConversationProvider,
  type LiveConversationSession,
  type ConversationWorkRef,
  type ConversationWorkResult,
} from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "./clients.js";
import type { ConnectionState } from "./dispatch.js";
import type { WsHost } from "./host.js";
import type { HostWork, HostWorkOutcome } from "./turns.js";
import { handleChatMessage } from "./run-session.js";

/** Conversations kept for resumption, live or detached, per host. */
export const MAX_RETAINED_CONVERSATIONS = 16;
/** Receipts one conversation keeps for resync; the oldest settled go first. */
export const MAX_CONVERSATION_RECEIPTS = 64;
/**
 * Request ids one conversation remembers as used. Receipts are evicted; the
 * id stays, so a reused id is refused rather than run a second time. A
 * conversation that has used this many asks the client to start a new one.
 */
export const MAX_CONVERSATION_REQUEST_IDS = 4_096;

interface Fragment {
  sequence: number;
  text: string;
  origin: "user" | "assistant" | "unknown";
}

interface Utterance {
  id: string;
  fragments: Map<number, Fragment>;
  endpointed: boolean;
  committed: boolean;
}

interface Work {
  receipt: ConversationWorkReceipt;
  nativeHandle?: string;
  withdrawn: boolean;
  facts: string;
  settled: boolean;
  /** The turn emitted its terminal `result`; without one it did not complete. */
  sawResult: boolean;
  /** The last `error` frame the turn emitted, for its receipt. */
  error?: string;
  /** What was handed to `returnWork`, kept so a late native handle can be answered. */
  handedOver?: { ref: ConversationWorkRef; result: ConversationWorkResult };
}

interface Epoch {
  number: number;
  session?: LiveConversationSession;
  abort: AbortController;
  closed: boolean;
  utterances: Map<string, Utterance>;
  /** Advisory provider requests not yet bound to committed work. */
  nativePending: Map<string, { utteranceId?: string }>;
  lastAudioSequence: number;
  /** Utterance ids this epoch evicted; one never comes back as new input. */
  retiredUtterances: Set<string>;
}

interface Conversation {
  id: string;
  principalId: string;
  connection: ConnectionState | null;
  ws: WSContext | null;
  sessionId?: string;
  epoch: Epoch | null;
  receipts: Work[];
  byRequestId: Map<string, Work>;
  /** Every request id this conversation admitted, bounded by MAX_CONVERSATION_REQUEST_IDS. */
  usedRequestIds: Set<string>;
  queue: Work[];
  running: Work | null;
  outputs: Map<string, ConversationOutputRecord>;
  /** Once-only permission announcements, `session\0turn\0toolUseId`, for the conversation's lifetime. */
  announced: Set<string>;
}

const outputKey = (epoch: number, outputId: string): string => `${epoch}\u0000${outputId}`;

const announcementKey = (sessionId: string, turnId: string, toolUseId: string): string =>
  `${sessionId}\u0000${turnId}\u0000${toolUseId}`;

/** A receipt whose request and delivery are both final. */
const evictable = (work: Work): boolean => work.settled && work.receipt.delivery !== "pending";

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export class ConversationHost {
  private readonly conversations = new Map<string, Conversation>();
  private readonly byConnection = new Map<ConnectionState, Conversation>();

  constructor(
    private readonly host: WsHost,
    readonly provider: LiveConversationProvider
  ) {}

  // --- client commands ---

  async start(ws: WSContext, connection: ConnectionState, msg: ClientConversationStart): Promise<void> {
    if (connection.closed) return;
    const principalId = connection.authorization.principalId;
    const owned = this.byConnection.get(connection);
    let conversation: Conversation;
    if (msg.conversationId !== undefined) {
      const found = this.conversations.get(msg.conversationId);
      if (!found || found.principalId !== principalId) {
        this.refuse(ws, "CONVERSATION_UNKNOWN", "No conversation with that id can be resumed here.");
        return;
      }
      if (owned && owned !== found) {
        this.refuse(ws, "CONVERSATION_LIMIT", "Stop this connection's conversation before resuming another.");
        return;
      }
      conversation = found;
      if (conversation.connection && conversation.connection !== connection) {
        // Another device held it: that one's capture ends, this one continues.
        this.endEpoch(conversation, "replaced");
        this.byConnection.delete(conversation.connection);
      }
      if (conversation.sessionId === undefined && msg.sessionId !== undefined) conversation.sessionId = msg.sessionId;
    } else {
      if (owned) {
        this.refuse(ws, "CONVERSATION_LIMIT", `A connection holds at most ${CONVERSATION_LIMITS.maxConversationsPerConnection} conversation.`);
        return;
      }
      if (!this.makeRoom()) {
        this.refuse(ws, "CONVERSATION_LIMIT", "Too many conversations are active on this server.");
        return;
      }
      conversation = {
        id: crypto.randomUUID(),
        principalId,
        connection: null,
        ws: null,
        ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
        epoch: null,
        receipts: [],
        byRequestId: new Map(),
        usedRequestIds: new Set(),
        queue: [],
        running: null,
        outputs: new Map(),
        announced: new Set(),
      };
      this.conversations.set(conversation.id, conversation);
    }
    conversation.connection = connection;
    conversation.ws = ws;
    this.byConnection.set(connection, conversation);

    // A new epoch: the previous one's capture, pending native requests and
    // unsubmitted work end here. Submitted work keeps running.
    this.endEpoch(conversation, "replaced");
    const epoch: Epoch = {
      number: (conversation.epoch?.number ?? 0) + 1,
      abort: new AbortController(),
      closed: false,
      utterances: new Map(),
      nativePending: new Map(),
      lastAudioSequence: -1,
      retiredUtterances: new Set(),
    };
    conversation.epoch = epoch;
    const scope = { conversationId: conversation.id, epoch: epoch.number };
    let session: LiveConversationSession;
    try {
      session = await this.provider.open(scope, {
        signal: epoch.abort.signal,
        resync: { work: conversation.receipts.map((work) => ({ ...work.receipt })) },
      });
      assertLiveConversationSession(session);
    } catch (err) {
      this.host.log.emit({
        severityText: "WARN",
        body: "live conversation failed to open",
        attributes: { "provider.id": this.provider.id, error: err instanceof Error ? err.message : String(err) },
      });
      this.endEpoch(conversation, "provider_error", "The voice service could not be opened.", epoch);
      return;
    }
    if (epoch.closed || conversation.epoch !== epoch) {
      // Replaced or stopped while opening: this session was never live.
      void session.close().catch(() => {});
      return;
    }
    epoch.session = session;
    this.send(conversation, {
      type: "conversation_opened",
      conversationId: conversation.id,
      epoch: epoch.number,
      ...(conversation.sessionId !== undefined ? { sessionId: conversation.sessionId } : {}),
      providerId: this.provider.id,
      capabilities: { ...this.provider.capabilities },
      disclosure: { voiceService: this.provider.disclosure.voiceService, destinations: [...this.provider.disclosure.destinations] },
      limits: { ...CONVERSATION_LIMITS },
      resync: { work: conversation.receipts.length, outputs: conversation.outputs.size },
    });
    // One whole record per frame: a snapshot of every record in one frame
    // could outgrow the per-frame cap and be clipped on the way out.
    for (const work of conversation.receipts) this.sendReceipt(conversation, work);
    for (const record of conversation.outputs.values()) {
      this.send(conversation, { type: "conversation_output", conversationId: conversation.id, ...record });
    }
    this.resendPermissions(conversation);
    void this.pump(conversation, epoch, session);
  }

  audio(ws: WSContext, connection: ConnectionState, msg: ClientConversationAudio): void {
    const found = this.current(ws, connection, msg.conversationId, msg.epoch);
    if (!found) return;
    const { conversation, epoch, session } = found;
    // Contiguous from 0: a chunk lost on the way (a metered frame, say)
    // closes capture visibly instead of leaving a silent hole in the audio.
    if (msg.sequence !== epoch.lastAudioSequence + 1) {
      this.endEpoch(conversation, "correlation", `Audio chunk ${epoch.lastAudioSequence + 1} is missing or out of sequence.`);
      return;
    }
    epoch.lastAudioSequence = msg.sequence;
    let utterance = epoch.utterances.get(msg.utteranceId);
    if (utterance?.committed || utterance?.endpointed || epoch.retiredUtterances.has(msg.utteranceId)) {
      this.endEpoch(conversation, "correlation", "Audio arrived for an utterance that already ended.");
      return;
    }
    if (!utterance) {
      if (!this.evictUtterance(epoch)) {
        this.endEpoch(conversation, "backpressure", `More than ${CONVERSATION_LIMITS.maxUtterances} utterances are awaiting a commit.`);
        return;
      }
      utterance = { id: msg.utteranceId, fragments: new Map(), endpointed: false, committed: false };
      epoch.utterances.set(utterance.id, utterance);
    }
    try {
      session.appendAudio({
        utteranceId: msg.utteranceId,
        sequence: msg.sequence,
        rate: msg.rate,
        pcm: Uint8Array.from(Buffer.from(msg.pcm, "base64")),
      });
    } catch {
      this.endEpoch(conversation, "provider_error", "The voice service refused audio.");
    }
  }

  endpoint(ws: WSContext, connection: ConnectionState, msg: ClientConversationEndpoint): void {
    const found = this.current(ws, connection, msg.conversationId, msg.epoch);
    if (!found) return;
    const { conversation, epoch, session } = found;
    const utterance = epoch.utterances.get(msg.utteranceId);
    if (!utterance) {
      this.endEpoch(conversation, "correlation", "An endpoint named an utterance this epoch never received.");
      return;
    }
    if (utterance.endpointed) return;
    utterance.endpointed = true;
    try {
      session.markEndpoint(msg.utteranceId);
    } catch {
      this.endEpoch(conversation, "provider_error", "The voice service refused an endpoint.");
    }
  }

  /** Semantic commit: the only way a conversation creates host work. */
  commit(ws: WSContext, connection: ConnectionState, msg: ClientConversationCommit): void {
    const conversation = this.owned(ws, connection, msg.conversationId);
    if (!conversation) return;
    const repeat = conversation.byRequestId.get(msg.requestId);
    if (repeat) {
      // A repeated request id replays its receipt; it never queues again.
      this.sendReceipt(conversation, repeat);
      return;
    }
    const epoch = conversation.epoch;
    const reused = conversation.usedRequestIds.has(msg.requestId);
    const refuse = (reason: string): void => {
      this.send(conversation, {
        type: "conversation_work",
        conversationId: conversation.id,
        epoch: msg.epoch,
        utteranceId: msg.utteranceId,
        requestId: msg.requestId,
        state: "refused",
        delivery: "discarded",
        recognized: "",
        submitted: msg.text,
        reason,
      });
    };
    if (reused) {
      // Its receipt was evicted, but the id already ran once.
      refuse("That request id was already used in this conversation.");
      return;
    }
    if (!epoch || epoch.closed || !epoch.session || epoch.number !== msg.epoch) {
      refuse("This epoch has ended. Restart capture and commit again.");
      return;
    }
    if (conversation.usedRequestIds.size >= MAX_CONVERSATION_REQUEST_IDS) {
      refuse(`This conversation has admitted ${MAX_CONVERSATION_REQUEST_IDS} requests. Start a new conversation.`);
      return;
    }
    const utterance = epoch.utterances.get(msg.utteranceId);
    if (!utterance) {
      refuse("This epoch holds no recognized input for that utterance.");
      return;
    }
    if (utterance.committed) {
      refuse("That utterance was already committed.");
      return;
    }
    const fragments = [...utterance.fragments.values()].sort((a, b) => a.sequence - b.sequence);
    // An utterance heard only as the assistant's own voice is echo, not input.
    if (!fragments.some((fragment) => fragment.origin !== "assistant")) {
      refuse("No recognized user input exists for that utterance.");
      return;
    }
    const active = conversation.queue.length + (conversation.running ? 1 : 0);
    if (active >= CONVERSATION_LIMITS.maxQueuedWork) {
      refuse(`This conversation already holds ${CONVERSATION_LIMITS.maxQueuedWork} requests. Wait for one to finish.`);
      return;
    }
    // A result still awaiting the provider's acknowledgement cannot be
    // evicted, so a provider that never acknowledges must not grow the
    // receipt list past its bound.
    if (conversation.receipts.length >= MAX_CONVERSATION_RECEIPTS && !conversation.receipts.some(evictable)) {
      refuse(`${MAX_CONVERSATION_RECEIPTS} requests still await the voice service. Wait for it to acknowledge them.`);
      return;
    }
    utterance.committed = true;
    const work: Work = {
      receipt: {
        conversationId: conversation.id,
        epoch: epoch.number,
        utteranceId: utterance.id,
        requestId: msg.requestId,
        ...(conversation.sessionId !== undefined ? { sessionId: conversation.sessionId } : {}),
        state: "queued",
        delivery: "pending",
        recognized: fragments.map((fragment) => fragment.text).join(" "),
        submitted: msg.text,
      },
      withdrawn: false,
      facts: "",
      settled: false,
      sawResult: false,
    };
    conversation.usedRequestIds.add(work.receipt.requestId);
    this.retainReceipt(conversation, work);
    // An advisory request the provider made before this commit binds now.
    for (const [handle, pending] of epoch.nativePending) {
      if (pending.utteranceId === undefined || pending.utteranceId === utterance.id) {
        epoch.nativePending.delete(handle);
        work.nativeHandle = handle;
        break;
      }
    }
    conversation.queue.push(work);
    this.sendReceipt(conversation, work);
    this.pumpQueue(conversation);
  }

  playback(ws: WSContext, connection: ConnectionState, msg: ClientConversationPlayback): void {
    // Evidence for an ended epoch's output never lands on the live epoch's.
    const found = this.current(ws, connection, msg.conversationId, msg.epoch);
    if (!found) return;
    const { conversation, epoch } = found;
    const record = conversation.outputs.get(outputKey(epoch.number, msg.outputId));
    if (!record) return;
    record.playback = msg.playback;
    if (msg.playedSamples) record.playedSamples = { ...msg.playedSamples };
  }

  stop(ws: WSContext, connection: ConnectionState, msg: ClientConversationStop): void {
    const conversation = this.owned(ws, connection, msg.conversationId);
    if (!conversation) return;
    this.endEpoch(conversation, "stopped");
    this.detach(conversation);
    this.conversations.delete(conversation.id);
  }

  /** The socket closed. Its conversation stays resumable as a new epoch. */
  dropConnection(connection: ConnectionState): void {
    const conversation = this.byConnection.get(connection);
    if (!conversation) return;
    this.endEpoch(conversation, "disconnected");
    this.detach(conversation);
  }

  /** A permission request was raised in some session; tell a conversation in it. */
  approvalRaised(request: { sessionId: string; turnId: string; toolUseId: string; toolName: string }): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.sessionId !== request.sessionId) continue;
      if (!conversation.ws || !conversation.epoch?.session || conversation.epoch.closed) continue;
      this.notifyPermission(conversation, request);
    }
  }

  // --- provider events ---

  private async pump(conversation: Conversation, epoch: Epoch, session: LiveConversationSession): Promise<void> {
    try {
      for await (const raw of session.events) {
        if (epoch.closed) break;
        const parsed = parseLiveConversationEvent(raw);
        if (!parsed.ok) {
          this.endEpoch(conversation, "correlation", parsed.error, epoch);
          break;
        }
        const event = parsed.event;
        if (event.conversationId !== conversation.id || event.epoch !== epoch.number) {
          // A stale or foreign scope is never applied to the live epoch.
          this.host.log.emit({ severityText: "WARN", body: "live conversation event for another scope ignored" });
          continue;
        }
        this.onEvent(conversation, epoch, event);
      }
      this.endEpoch(conversation, "provider_closed", undefined, epoch);
    } catch {
      this.endEpoch(conversation, "provider_error", "The voice service failed.", epoch);
    }
  }

  private onEvent(conversation: Conversation, epoch: Epoch, event: LiveConversationEvent): void {
    const scope = { conversationId: conversation.id, epoch: epoch.number };
    switch (event.kind) {
      case "ready": {
        this.send(conversation, { type: "conversation_event", ...scope, event: {
          kind: "ready", ...(event.model ? { model: event.model } : {}), ...(event.api ? { api: event.api } : {}),
          input: { ...event.input }, output: { ...event.output },
        } });
        return;
      }
      case "input_fragment": {
        const utterance = epoch.utterances.get(event.utteranceId);
        if (!utterance) {
          this.endEpoch(conversation, "correlation", "The voice service reported input for an utterance it was never sent.", epoch);
          return;
        }
        if (!utterance.fragments.has(event.sequence) && utterance.fragments.size >= CONVERSATION_LIMITS.maxFragmentsPerUtterance) {
          this.endEpoch(conversation, "backpressure", `More than ${CONVERSATION_LIMITS.maxFragmentsPerUtterance} fragments for one utterance.`, epoch);
          return;
        }
        // The receipt joins fragments with single spaces; bound that join.
        let joined = event.text.length;
        for (const fragment of utterance.fragments.values()) {
          if (fragment.sequence !== event.sequence) joined += fragment.text.length + 1;
        }
        if (joined > CONVERSATION_LIMITS.maxUtteranceChars) {
          this.endEpoch(conversation, "backpressure", `More than ${CONVERSATION_LIMITS.maxUtteranceChars} recognized characters for one utterance.`, epoch);
          return;
        }
        utterance.fragments.set(event.sequence, { sequence: event.sequence, text: event.text, origin: event.origin });
        this.send(conversation, { type: "conversation_event", ...scope, event: {
          kind: "input_fragment", utteranceId: event.utteranceId, sequence: event.sequence, text: event.text,
          ...(event.interval ? { interval: { ...event.interval } } : {}),
          finalization: event.finalization, certainty: event.certainty,
          ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
          origin: event.origin,
        } });
        return;
      }
      case "output_transcript": {
        const record = this.output(conversation, epoch.number, event.outputId);
        record.generated = bounded(record.generated + event.text, CONVERSATION_LIMITS.maxGeneratedChars);
        this.send(conversation, { type: "conversation_event", ...scope, event: {
          kind: "output_transcript", outputId: event.outputId, sequence: event.sequence, text: event.text,
          ...(event.interval ? { interval: { ...event.interval } } : {}),
        } });
        return;
      }
      case "audio": {
        this.output(conversation, epoch.number, event.outputId);
        this.send(conversation, { type: "conversation_event", ...scope, event: {
          kind: "audio", outputId: event.outputId, sequence: event.sequence, format: { ...event.format },
          pcm: Buffer.from(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength).toString("base64"),
        } });
        return;
      }
      case "interrupted": {
        this.send(conversation, { type: "conversation_event", ...scope, event: {
          kind: "interrupted", ...(event.outputId ? { outputId: event.outputId } : {}),
        } });
        return;
      }
      case "work_requested": {
        const known = epoch.nativePending.has(event.handle) ||
          conversation.receipts.some((work) => work.receipt.epoch === epoch.number && work.nativeHandle === event.handle);
        if (known) return;
        // Bind to committed work of this epoch that has no handle yet. The
        // request itself never runs anything. A request naming its utterance
        // binds to that work in any state; one naming none binds only to work
        // still running, never to an older finished request.
        const target = conversation.receipts.find((work) =>
          work.receipt.epoch === epoch.number && work.nativeHandle === undefined &&
          (event.utteranceId !== undefined ? work.receipt.utteranceId === event.utteranceId : !work.settled));
        if (target) {
          target.nativeHandle = event.handle;
          // The result already went out without this handle: answer the
          // native request with the same result. Discarded work stays
          // unanswered; its handle is consumed, not parked.
          const handed = target.handedOver;
          if (handed && target.receipt.delivery !== "discarded" && epoch.session && !epoch.closed) {
            const session = epoch.session;
            void Promise.resolve()
              .then(() => session.returnWork({ ...handed.ref, nativeHandle: event.handle }, handed.result))
              .catch(() => {});
          }
          return;
        }
        if (epoch.nativePending.size >= CONVERSATION_LIMITS.maxPendingNativeRequests) {
          this.endEpoch(conversation, "backpressure", `More than ${CONVERSATION_LIMITS.maxPendingNativeRequests} voice-service requests await a commit.`, epoch);
          return;
        }
        epoch.nativePending.set(event.handle, event.utteranceId !== undefined ? { utteranceId: event.utteranceId } : {});
        return;
      }
      case "work_withdrawn": {
        if (epoch.nativePending.delete(event.handle)) return;
        const work = conversation.receipts.find((candidate) =>
          candidate.receipt.epoch === epoch.number && candidate.nativeHandle === event.handle);
        if (!work || work.withdrawn) return;
        work.withdrawn = true;
        if (work.receipt.delivery === "pending") {
          work.receipt.delivery = "discarded";
          work.receipt.reason = "The voice service withdrew this request.";
          this.sendReceipt(conversation, work);
        }
        return;
      }
      case "closed": {
        this.endEpoch(conversation, "provider_closed", undefined, epoch);
        return;
      }
      case "error": {
        this.endEpoch(conversation, "provider_error", bounded(event.message, 500), epoch);
        return;
      }
    }
  }

  // --- work ---

  private pumpQueue(conversation: Conversation): void {
    if (conversation.running || conversation.queue.length === 0) return;
    const connection = conversation.connection;
    const ws = conversation.ws;
    const work = conversation.queue.shift()!;
    if (!connection || !ws || connection.closed || !connection.authorization.valid) {
      this.settle(conversation, work, "cancelled", { reason: "The conversation's connection ended before this request ran." });
      return;
    }
    conversation.running = work;
    if (conversation.sessionId !== undefined) work.receipt.sessionId = conversation.sessionId;
    void handleChatMessage(this.host, ws, {
      authorization: connection.authorization,
      text: work.receipt.submitted,
      ...(conversation.sessionId !== undefined ? { sessionId: conversation.sessionId } : {}),
      attachments: [],
      source: "voice-conversation",
      requestId: work.receipt.requestId,
      work: this.hostWork(conversation, work),
    }).catch((err) => {
      this.settle(conversation, work, "error", { reason: err instanceof Error ? err.message : String(err) });
    });
  }

  private hostWork(conversation: Conversation, work: Work): HostWork {
    return {
      posture: "voice",
      started: (turnId) => {
        if (work.settled) return;
        work.receipt.turnId = turnId;
        work.receipt.state = "running";
        this.sendReceipt(conversation, work);
      },
      observe: (frame) => {
        if (work.settled) return;
        if (frame.type === "session_info") {
          work.receipt.sessionId = frame.sessionId;
          conversation.sessionId ??= frame.sessionId;
        } else if (frame.type === "text_delta") {
          work.facts = bounded(work.facts + frame.text, CONVERSATION_LIMITS.maxFactChars);
        } else if (frame.type === "result") {
          work.sawResult = true;
        } else if (frame.type === "error") {
          work.error = frame.message;
        }
      },
      settle: (outcome, detail) => this.settle(conversation, work, outcome, detail),
    };
  }

  private settle(
    conversation: Conversation,
    work: Work,
    outcome: HostWorkOutcome,
    detail?: { sessionId?: string | null; reason?: string }
  ): void {
    if (work.settled) return;
    work.settled = true;
    // A backend may end a turn with only an `error` frame (one that failed
    // before naming a session) and still resolve: that is not a completion.
    if (outcome === "completed" && !work.sawResult) {
      outcome = "error";
      detail = { ...detail, reason: work.error ?? "The turn ended without a result." };
    }
    work.receipt.state = outcome;
    if (detail?.sessionId) {
      work.receipt.sessionId = detail.sessionId;
      conversation.sessionId ??= detail.sessionId;
    }
    if (detail?.reason && work.receipt.reason === undefined) work.receipt.reason = bounded(detail.reason, 500);
    if (conversation.running === work) {
      conversation.running = null;
      // A cancelled running request (a user cancel, with or without a
      // session id, host shutdown, or a timeout) takes the conversation's
      // backlog with it: nothing queued behind it starts afterwards.
      if (outcome === "cancelled") {
        for (const queued of conversation.queue.splice(0)) {
          this.settle(conversation, queued, "cancelled", { reason: "The request before it was cancelled." });
        }
      }
    }
    this.deliver(conversation, work);
    this.sendReceipt(conversation, work);
    // Next request on a fresh task: settle can run inside handleChatMessage.
    queueMicrotask(() => this.pumpQueue(conversation));
  }

  /** Return a settled result to the provider, or record why it was discarded. */
  private deliver(conversation: Conversation, work: Work): void {
    if (work.receipt.delivery !== "pending") return;
    const epoch = conversation.epoch;
    const outcome = work.receipt.state;
    const discard = (reason: string): void => {
      work.receipt.delivery = "discarded";
      work.receipt.reason ??= reason;
    };
    // A withdrawn request was already marked discarded when the provider
    // withdrew it, so it never reaches this point.
    if (outcome !== "completed" && outcome !== "error") return discard("The request did not complete.");
    if (!epoch || epoch.number !== work.receipt.epoch || epoch.closed || !epoch.session || conversation.ws === null) {
      return discard("The epoch this request belonged to has ended.");
    }
    if (work.receipt.turnId === undefined) return discard("The request never started a turn.");
    const session = epoch.session;
    const ref = {
      conversationId: conversation.id,
      epoch: work.receipt.epoch,
      utteranceId: work.receipt.utteranceId,
      turnId: work.receipt.turnId,
      requestId: work.receipt.requestId,
      ...(work.nativeHandle !== undefined ? { nativeHandle: work.nativeHandle } : {}),
    };
    const result = outcome === "completed"
      ? { outcome: "completed" as const, facts: work.facts, delivery: "when-idle" as const }
      : { outcome: "error" as const, facts: bounded(work.receipt.reason ?? "The request failed.", CONVERSATION_LIMITS.maxFactChars), delivery: "quiet" as const };
    work.handedOver = { ref, result };
    let returned: Promise<void>;
    try {
      returned = Promise.resolve(session.returnWork(ref, result));
    } catch (err) {
      returned = Promise.reject(err);
    }
    void returned.then(
      () => {
        if (work.receipt.delivery !== "pending") return;
        work.receipt.delivery = "returned";
        this.sendReceipt(conversation, work);
      },
      () => {
        if (work.receipt.delivery !== "pending") return;
        discard("The voice service did not accept the result.");
        this.sendReceipt(conversation, work);
      }
    );
  }

  // --- epochs and bookkeeping ---

  /**
   * End the current epoch (or `only` that one, when it is still current).
   * Unsubmitted work is cancelled; submitted work runs on, undelivered.
   */
  private endEpoch(conversation: Conversation, reason: ConversationCloseReason, message?: string, only?: Epoch): void {
    const epoch = conversation.epoch;
    if (!epoch || epoch.closed || (only !== undefined && only !== epoch)) return;
    epoch.closed = true;
    epoch.abort.abort();
    epoch.nativePending.clear();
    const session = epoch.session;
    if (session) {
      void Promise.resolve()
        .then(() => session.close())
        .catch(() => {});
    }
    for (const work of conversation.queue.splice(0)) {
      this.settle(conversation, work, "cancelled", { reason: "The epoch ended before this request ran." });
    }
    // A result handed to this epoch's provider and not yet acknowledged will
    // never be: its session is gone. A late acknowledgement cannot reopen it.
    for (const work of conversation.receipts) {
      if (work.receipt.epoch !== epoch.number || !work.settled || work.receipt.delivery !== "pending") continue;
      work.receipt.delivery = "discarded";
      work.receipt.reason ??= "The epoch ended before the voice service acknowledged the result.";
      this.sendReceipt(conversation, work);
    }
    if (conversation.ws && reason !== "disconnected") {
      this.send(conversation, {
        type: "conversation_closed",
        conversationId: conversation.id,
        epoch: epoch.number,
        reason,
        ...(message ? { message: bounded(message, 500) } : {}),
      });
    }
  }

  private detach(conversation: Conversation): void {
    if (conversation.connection && this.byConnection.get(conversation.connection) === conversation) {
      this.byConnection.delete(conversation.connection);
    }
    conversation.connection = null;
    conversation.ws = null;
  }

  /** Evict the oldest detached, idle conversation when the host is full. */
  private makeRoom(): boolean {
    if (this.conversations.size < MAX_RETAINED_CONVERSATIONS) return true;
    for (const [id, conversation] of this.conversations) {
      if (conversation.connection || conversation.running || conversation.queue.length > 0) continue;
      this.conversations.delete(id);
      return true;
    }
    return false;
  }

  /** Make room for one more utterance; only an ended or committed one may go. */
  private evictUtterance(epoch: Epoch): boolean {
    if (epoch.utterances.size < CONVERSATION_LIMITS.maxUtterances) return true;
    // The retired ids outlive their fragments, so the ledger is bounded too:
    // a full one asks for a new epoch rather than forgetting an identity.
    if (epoch.retiredUtterances.size >= MAX_CONVERSATION_REQUEST_IDS) return false;
    for (const [id, utterance] of epoch.utterances) {
      if (!utterance.committed && !utterance.endpointed) continue;
      epoch.utterances.delete(id);
      epoch.retiredUtterances.add(id);
      return true;
    }
    return false;
  }

  private retainReceipt(conversation: Conversation, work: Work): void {
    conversation.receipts.push(work);
    conversation.byRequestId.set(work.receipt.requestId, work);
    while (conversation.receipts.length > MAX_CONVERSATION_RECEIPTS) {
      const index = conversation.receipts.findIndex(evictable);
      if (index < 0) break;
      const [evicted] = conversation.receipts.splice(index, 1);
      conversation.byRequestId.delete(evicted!.receipt.requestId);
    }
  }

  private output(conversation: Conversation, epoch: number, outputId: string): ConversationOutputRecord {
    const key = outputKey(epoch, outputId);
    let record = conversation.outputs.get(key);
    if (!record) {
      record = { epoch, outputId, generated: "", playback: "unknown" };
      conversation.outputs.set(key, record);
      while (conversation.outputs.size > CONVERSATION_LIMITS.maxOutputs) {
        const oldest = conversation.outputs.keys().next().value;
        if (oldest === undefined) break;
        conversation.outputs.delete(oldest);
      }
    }
    return record;
  }

  private resendPermissions(conversation: Conversation): void {
    if (conversation.sessionId === undefined) return;
    for (const pending of this.host.coordinator.pendingApprovals.values()) {
      if (pending.turn.sessionId !== conversation.sessionId) continue;
      this.notifyPermission(conversation, {
        sessionId: conversation.sessionId,
        turnId: pending.turnId,
        toolUseId: pending.request.toolUseId,
        toolName: pending.request.toolName,
      });
    }
  }

  private notifyPermission(
    conversation: Conversation,
    request: { sessionId: string; turnId: string; toolUseId: string; toolName: string }
  ): void {
    const epoch = conversation.epoch;
    if (!epoch) return;
    const key = announcementKey(request.sessionId, request.turnId, request.toolUseId);
    // The ledger outlives epochs: a reconnect re-lists a pending request but
    // never announces it a second time. Speech stays closed until the
    // provider has proven exact host-approved copy.
    const announce = !conversation.announced.has(key) && this.provider.capabilities.exactPermissionSpeech === "supported";
    conversation.announced.add(key);
    this.send(conversation, {
      type: "conversation_permission",
      conversationId: conversation.id,
      epoch: epoch.number,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      announce,
    });
  }

  /** The caller's conversation, when the frame names it; refuses otherwise. */
  private owned(ws: WSContext, connection: ConnectionState, conversationId: string): Conversation | null {
    const conversation = this.byConnection.get(connection);
    if (!conversation || conversation.id !== conversationId) {
      this.refuse(ws, "CONVERSATION_UNKNOWN", "This connection holds no conversation with that id.");
      return null;
    }
    return conversation;
  }

  /** The live epoch a capture frame belongs to; a stale epoch is ignored. */
  private current(
    ws: WSContext,
    connection: ConnectionState,
    conversationId: string,
    epochNumber: number
  ): { conversation: Conversation; epoch: Epoch; session: LiveConversationSession } | null {
    const conversation = this.owned(ws, connection, conversationId);
    if (!conversation) return null;
    const epoch = conversation.epoch;
    // Frames already in flight when an epoch ended are expected; they are
    // dropped, never applied to the replacement.
    if (!epoch || epoch.closed || !epoch.session || epoch.number !== epochNumber) return null;
    return { conversation, epoch, session: epoch.session };
  }

  private sendReceipt(conversation: Conversation, work: Work): void {
    this.send(conversation, { type: "conversation_work", ...work.receipt });
  }

  private send(conversation: Conversation, frame: ServerMessage): void {
    if (!conversation.ws) return;
    try {
      this.host.sendMessage(conversation.ws, frame);
    } catch {
      // The socket's close handler detaches the conversation.
    }
  }

  private refuse(ws: WSContext, code: string, message: string): void {
    this.host.sendMessage(ws, { type: "error", code, message });
  }

  /**
   * A frame from this connection was metered away before parsing. It may have
   * been audio, an endpoint or a commit, so capture cannot continue on an
   * incomplete record: the epoch ends and capture restarts explicitly.
   */
  frameDropped(connection: ConnectionState): void {
    const conversation = this.byConnection.get(connection);
    if (!conversation) return;
    this.endEpoch(conversation, "backpressure", "A frame from this connection was rate-limited; restart capture.");
  }

  /** The user cancelled a session: its conversations' unsubmitted work is cancelled too. */
  sessionCancelled(sessionId: string): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.sessionId !== sessionId) continue;
      for (const work of conversation.queue.splice(0)) {
        this.settle(conversation, work, "cancelled", { reason: "Cancelled by user" });
      }
    }
  }

  /** Host teardown: end every epoch, close every provider session, forget all. */
  closeAll(): void {
    for (const conversation of this.conversations.values()) {
      this.endEpoch(conversation, "stopped", "The server is shutting down.");
      this.detach(conversation);
    }
    this.conversations.clear();
    this.byConnection.clear();
  }

  /** Test seam: conversations currently retained. */
  get size(): number {
    return this.conversations.size;
  }
}
