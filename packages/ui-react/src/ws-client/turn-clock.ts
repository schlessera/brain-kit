import type { ClientMessage, ClientTurnTiming, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

interface Observation {
  sentAt: number;
  dispatchedAt?: number;
  disqualified?: true;
  turnId?: string;
  firstHostAt?: number;
  firstContentAt?: number;
  lastContentAt?: number;
}

function isDispatched(value: Observation | undefined): value is Observation & { dispatchedAt: number } {
  return value?.dispatchedAt !== undefined && value.disqualified !== true;
}

/** Arrival evidence only, before rendering/delta buffering. Nothing survives a
 * socket gap: a resumed client cannot establish the missing boundaries. */
export function createTurnClock(report: (message: ClientMessage) => boolean, clock = () => performance.now()) {
  let supported = false;
  const requests = new Map<string, Observation>();
  const arrivals = new Map<string, Omit<Observation, "sentAt">>();
  return {
    started(requestId: string, sentAt = clock()) {
      if (requests.has(requestId)) return;
      if (requests.size >= 256) requests.delete(requests.keys().next().value!);
      requests.set(requestId, { sentAt });
    },
    sent(message: ClientMessage, sentAt: number) {
      if ((message.type !== "chat_message" && message.type !== "retry_turn") || !message.requestId) return;
      // A durable snapshot cannot reconstruct a lost Send after a reload
      // or eviction. Its origin must have been captured by this live root.
      if (message.type === "chat_message" && message.draftRef && !requests.has(message.requestId)) return;
      if (requests.get(message.requestId)?.disqualified) return;
      // Preserve the Send boundary captured before snapshot persistence.
      this.started(message.requestId, sentAt);
      requests.get(message.requestId)!.dispatchedAt ??= sentAt;
    },
    now: clock,
    disconnected() { supported = false; requests.clear(); arrivals.clear(); },
    frame(message: ServerMessage) {
      if (message.type === "server_hello") { supported = message.capabilities?.clientTurnReceipts === true; return; }
      if (!requests.size) return;
      const at = clock();
      const { turnId, requestId } = (message.type === "session_queue" ? message.started : message) as { turnId?: string; requestId?: string } | undefined ?? {};
      // A known request acknowledged before this client's dispatch belongs
      // to a peer. Retain that loss even if this tab later dispatches the id.
      const acknowledged = message.type === "session_queue"
        ? [...message.followUps.map(entry => entry.requestId), message.started?.requestId, ...(message.dropped ?? []).map(entry => entry.requestId)]
        : message.type === "session_info" || message.type === "status" || message.type === "error" || message.type === "retry_receipt" && message.state === "accepted"
          ? [requestId] : [];
      for (const id of acknowledged) {
        const observation = id ? requests.get(id) : undefined;
        if (observation && observation.dispatchedAt === undefined) observation.disqualified = true;
      }
      if (![...requests.values()].some(isDispatched)) return;
      if (message.type === "session_queue") {
        for (const entry of message.followUps) {
          const pending = entry.requestId ? requests.get(entry.requestId) : undefined;
          if (isDispatched(pending)) pending.firstHostAt ??= at;
        }
        for (const entry of message.dropped ?? []) { const dropped = entry.requestId ? requests.get(entry.requestId) : undefined; if (dropped) dropped.disqualified = true; }
      }
      // Activity can announce acceptance before session_info identifies the
      // initiating request. Only retain arrivals; never infer ownership.
      const lifecycleIds = message.type === "activity_delta" ? [message.lifecycle?.turnId]
        : message.type === "activity_snapshot" ? message.lifecycles?.map(value => value.turnId) ?? [] : [];
      for (const id of lifecycleIds) if (id) remember(id, at);

      // A backend may emit a turn-scoped frame before session_info supplies
      // its request correlation. Retain that arrival, never infer by session.
      const arrival = turnId ? arrivals.get(turnId) ?? { firstHostAt: at } : undefined;
      if (arrival && (message.type === "text_delta" || message.type === "thinking_delta") && message.text.length > 0) {
        arrival.firstContentAt ??= at; arrival.lastContentAt = at;
      }
      if (turnId && arrival) {
        remember(turnId, at, arrival);
      }
      function remember(id: string, at: number, value = arrivals.get(id) ?? { firstHostAt: at }) {
        if (!arrivals.has(id) && arrivals.size >= 256) {
          const evicted = arrivals.keys().next().value!;
          const lost = arrivals.get(evicted)!;
          arrivals.delete(evicted);
          // An unbound request may own the lost first arrival. Keep only
          // requests whose complete evidence is still provably retained.
          for (const [id, pending] of requests) if ((!pending.turnId && lost.firstHostAt! >= pending.sentAt) || pending.turnId === evicted) requests.delete(id);
        }
        arrivals.set(id, value);
      }
      const correlates = message.type === "session_queue" || message.type === "session_info" || message.type === "status" || message.type === "error" || (message.type === "retry_receipt" && message.state === "accepted");
      let observation = correlates && requestId ? requests.get(requestId) : undefined;
      if (!isDispatched(observation)) observation = undefined;
      if (observation) {
        observation.firstHostAt ??= at;
        if (turnId) observation.turnId ??= turnId;
        if (message.type === "error" && !turnId) { requests.delete(requestId!); return; }
      }
      if (!observation && turnId) observation = [...requests.values()].find(value => isDispatched(value) && value.turnId === turnId);
      if (!isDispatched(observation) || !turnId || observation.turnId !== turnId) return;
      if (arrival?.firstHostAt !== undefined && arrival.firstHostAt < observation.dispatchedAt) {
        // Evidence from another tab before this dispatch cannot become our
        // first frame. Drop this optional sample rather than infer a start.
        for (const [id, value] of requests) if (value === observation) requests.delete(id);
        return;
      }
      observation.firstHostAt = Math.min(observation.firstHostAt ?? at, arrival?.firstHostAt ?? at);
      observation.firstContentAt ??= arrival?.firstContentAt;
      observation.lastContentAt = arrival?.lastContentAt;
      if (message.type !== "status" || message.status !== "idle" || message.hostTurnComplete !== true) return;
      arrivals.delete(turnId);
      for (const [id, value] of requests) if (value === observation) requests.delete(id);
      const timing: ClientTurnTiming = {
        sendToFirstHostFrameMs: Math.max(0, observation.firstHostAt - observation.sentAt),
        ...(observation.firstContentAt === undefined ? {} : { sendToFirstContentFrameMs: Math.max(0, observation.firstContentAt - observation.sentAt) }),
        ...(observation.lastContentAt === undefined ? {} : { lastContentFrameToIdleMs: Math.max(0, at - observation.lastContentAt) }),
      };
      if (!supported) return;
      // One attempt, no retry or retained outgoing queue. Loss affects only this measurement.
      try { report({ type: "client_turn_receipt", turnId, timing }); }
      catch { /* A transport exception must not interrupt idle handling. */ }
    },
  };
}


// Like the connection's account lifecycle registry, this stays private to
// the concrete root. Composer timing never enters a draft or wire message.
const rootClocks = new WeakMap<object, ReturnType<typeof createTurnClock>>();
export function bindTurnClock(owner: object, clock: ReturnType<typeof createTurnClock>): () => void {
  rootClocks.set(owner, clock);
  return () => { if (rootClocks.get(owner) === clock) rootClocks.delete(owner); };
}
export function noteTurnSend(owner: object, requestId: string, at: number): void {
  rootClocks.get(owner)?.started(requestId, at);
}
