import type { ClientMessage, ClientTurnTiming, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

interface Observation {
  sentAt: number;
  turnId?: string;
  firstHostAt?: number;
  firstContentAt?: number;
  lastContentAt?: number;
}

/** Arrival evidence only, before rendering/delta buffering. Nothing survives a
 * socket gap: a resumed client cannot establish the missing boundaries. */
export function createTurnClock(report: (message: ClientMessage) => boolean, clock = () => performance.now()) {
  const requests = new Map<string, Observation>();
  const arrivals = new Map<string, Omit<Observation, "sentAt">>();
  return {
    sent(message: ClientMessage, sentAt: number) {
      if ((message.type !== "chat_message" && message.type !== "retry_turn") || !message.requestId) return;
      // Telemetry has a fixed memory bound, even against an unresponsive peer.
      if (requests.size >= 256) requests.delete(requests.keys().next().value!);
      requests.set(message.requestId, { sentAt });
    },
    now: clock,
    disconnected() { requests.clear(); arrivals.clear(); },
    frame(message: ServerMessage) {
      if (!requests.size) return;
      const at = clock();
      const { turnId, requestId } = message as { turnId?: string; requestId?: string };
      // A backend may emit a turn-scoped frame before session_info supplies
      // its request correlation. Retain that arrival, never infer by session.
      const arrival = turnId ? arrivals.get(turnId) ?? { firstHostAt: at } : undefined;
      if (arrival && (message.type === "text_delta" || message.type === "thinking_delta") && message.text.length > 0) {
        arrival.firstContentAt ??= at; arrival.lastContentAt = at;
      }
      if (turnId && arrival) {
        if (arrivals.size >= 256) arrivals.delete(arrivals.keys().next().value!);
        arrivals.set(turnId, arrival);
      }
      const correlates = message.type === "session_info" || message.type === "status" || message.type === "error";
      let observation = correlates && requestId ? requests.get(requestId) : undefined;
      if (observation) {
        observation.firstHostAt ??= at;
        if (turnId) observation.turnId ??= turnId;
        if (message.type === "error" && !turnId) { requests.delete(requestId!); return; }
      }
      if (!observation && turnId) observation = [...requests.values()].find(value => value.turnId === turnId);
      if (!observation || !turnId || observation.turnId !== turnId) return;
      observation.firstHostAt = Math.min(observation.firstHostAt ?? at, arrival?.firstHostAt ?? at);
      observation.firstContentAt ??= arrival?.firstContentAt;
      observation.lastContentAt = arrival?.lastContentAt;
      if (message.type !== "status" || message.status !== "idle") return;
      arrivals.delete(turnId);
      for (const [id, value] of requests) if (value === observation) requests.delete(id);
      const timing: ClientTurnTiming = {
        sendToFirstHostFrameMs: Math.max(0, observation.firstHostAt - observation.sentAt),
        ...(observation.firstContentAt === undefined ? {} : { sendToFirstContentFrameMs: Math.max(0, observation.firstContentAt - observation.sentAt) }),
        ...(observation.lastContentAt === undefined ? {} : { lastContentFrameToIdleMs: Math.max(0, at - observation.lastContentAt) }),
      };
      // One attempt, no retry or retained outgoing queue. Loss affects only this measurement.
      try { report({ type: "client_turn_receipt", turnId, timing }); }
      catch { /* A transport exception must not interrupt idle handling. */ }
    },
  };
}
