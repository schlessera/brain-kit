import { createStore } from "zustand/vanilla";
import type { ClientMessage, ConversationWireEvent, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";

export interface VoicePermissionReceipt {
  sessionId: string;
  turnId: string;
  toolUseId: string;
  phase: "pending" | "sent" | "unknown" | "denied" | "granted" | "expired";
  announced: boolean;
  ambiguous: boolean;
  byVoice: boolean;
  heardAt?: number;
  script: string;
  word: string;
  label?: string;
  postureDenied?: true;
}

/** Concrete permission routing. Exact-copy speech is absent, so only a local earcon is queued. */
export function createConversationPermissions(root: BrainUiServices, send: (message: ClientMessage) => boolean,
  selected: () => { active: boolean; sessionId: string | null; micOn: boolean; quiet: boolean; isolated: boolean }, earcon: () => void, overflow: () => void) {
  const state = createStore<{ records: VoicePermissionReceipt[]; line: string }>(() => ({ records: [], line: "" }));
  const records = new Map<string, VoicePermissionReceipt>();
  const turns = new Map<string, string>();
  const announced = new Set<string>();
  let applying = false;
  let full = false;
  const identity = (sessionId: string, turnId: string, toolUseId: string) => JSON.stringify([sessionId, turnId, toolUseId]);
  const pending = () => {
    const s = selected();
    return s.active && s.sessionId ? [...records.values()].filter((r) => r.sessionId === s.sessionId && r.turnId === turns.get(s.sessionId!) && r.phase === "pending") : [];
  };
  function apply() {
    if (applying) return;
    applying = true;
    try { for (const receipt of records.values()) root.stores.chat.getState().applyVoicePermission(receipt); }
    finally { applying = false; }
  }
  function publish() {
    const s = selected();
    state.setState({ records: [...records.values()], line: full ? "Use Deny on screen; the voice request limit was reached." : pending().length ? s.micOn ? 'Say “brain, stop” to refuse · voice can’t approve' : "Mic is off. Use Deny on screen, or unmute to refuse." : "" });
    apply();
  }
  function put(receipt: VoicePermissionReceipt) {
    const key = identity(receipt.sessionId, receipt.turnId, receipt.toolUseId);
    if (!records.has(key) && records.size >= 128) {
      const old = [...records].find(([, r]) => !["pending", "sent", "unknown"].includes(r.phase));
      if (!old) { full = true; overflow(); return; }
      records.delete(old[0]);
    }
    records.set(key, receipt);
  }
  function quiet() {
    if (!selected().quiet) return;
    let tone = false;
    for (const receipt of pending()) {
      const key = identity(receipt.sessionId, receipt.turnId, receipt.toolUseId);
      if (announced.has(key) || announced.size >= 4096) continue;
      announced.add(key);
      put({ ...receipt, announced: true, word: "earcon once · voice can’t approve", script: selected().micOn
        ? `${receipt.label ?? "An action"} needs a decision on screen. Voice can’t approve it. Say “brain, stop” to refuse.`
        : `${receipt.label ?? "An action"} needs a decision on screen. Mic is off. Use Deny on screen, or unmute to refuse.` });
      tone = true;
    }
    if (tone) earcon();
    publish();
  }
  function frame(message: ServerMessage) {
    const { sessionId, turnId } = message as { sessionId?: string; turnId?: string };
    if (!sessionId || !turnId) return;
    if (message.type === "session_info" || message.type === "text_delta" || message.type === "status" && message.status !== "idle" && message.status !== "cancelled") {
      if (!turns.has(sessionId) && turns.size >= 128) turns.delete(turns.keys().next().value!);
      turns.set(sessionId, turnId);
    }
    if (message.type === "tool_approval_request") {
      if (!turns.has(sessionId)) turns.set(sessionId, turnId);
      const key = identity(sessionId, turnId, message.toolUseId);
      const previous = records.get(key);
      const provider = root.stores.provider.getState();
      const backendId = provider.available.find(p => p.id === (provider.pinnedId ?? provider.selectedId))?.backendId ?? "";
      let candidate: unknown;
      try { candidate = root.renderers.resolve({ id: message.toolUseId, name: message.toolName, input: {} }, backendId)?.label; } catch { /* A renderer cannot break the permission transport. */ }
      const label = typeof candidate === "string" && /^[a-zA-Z][a-zA-Z0-9 -]{0,63}$/.test(candidate) && candidate.trim().split(/\s+/).length <= 4 ? candidate.trim() : "An action";
      if (!previous) put({ sessionId, turnId, toolUseId: message.toolUseId, label, phase: "pending", announced: false, ambiguous: false, byVoice: false, script: "", word: "" });
      else if (previous.phase === "unknown") put({ ...previous, phase: "pending", word: "Refusal unconfirmed · request still waiting" });
      publish(); quiet();
    } else if (message.type === "tool_resolution") {
      const key = identity(sessionId, turnId, message.toolUseId);
      const previous = records.get(key);
      const phase = message.outcome === "granted" ? "granted" : message.outcome === "expired" ? "expired" : message.outcome === "denied" ? "denied" : "unknown";
      // A posture denial can have an outcome without ever having a grant card.
      const byVoice = phase === "unknown" ? previous?.byVoice === true : previous?.heardAt !== undefined && message.channel === "voice";
      const word = phase === "granted" ? previous?.heardAt ? "The screen decision was already accepted." : "Approved on screen" : phase === "expired" ? "Expired · denied · no answer before the turn ended"
        : phase === "unknown" ? "Couldn't confirm the refusal" : byVoice ? previous?.ambiguous ? "Denied · by voice · heard unclearly · taken as refusal" : "Denied · by voice"
        : message.reason === "voice_posture" ? "not done · denied by voice posture · no card" : "Denied on screen";
      put({ sessionId, turnId, toolUseId: message.toolUseId, announced: previous?.announced ?? false, ambiguous: previous?.ambiguous ?? false, byVoice,
        ...(previous?.heardAt ? { heardAt: previous.heardAt } : {}), ...(message.reason === "voice_posture" ? { postureDenied: true as const } : {}), label: previous?.label, phase, word,
        script: phase === "denied" && byVoice ? previous?.ambiguous ? "I couldn't hear that clearly, so I took it as a refusal. The action was denied." : "I took that as a refusal. The action was denied."
          : phase === "expired" ? "I stopped without doing it. Ask me again when you can look at a screen." : word });
      publish();
    } else if (message.type === "result" || message.type === "status" && (message.status === "idle" || message.status === "cancelled")) {
      for (const receipt of records.values()) if (receipt.sessionId === sessionId && receipt.turnId === turnId && ["pending", "sent"].includes(receipt.phase)) {
        put({ ...receipt, phase: "expired", word: message.type === "status" && message.status === "cancelled" ? "Cancelled · not done" : "Expired · denied · no answer before the turn ended", script: "I stopped without doing it. Ask me again when you can look at a screen." });
      }
      publish();
    }
  }
  function input(event: Extract<ConversationWireEvent, { kind: "input_fragment" }>) {
    // Unknown attribution is never a user decision. Neither an assistant
    // transcript nor replayed output can authorize even a scoped denial.
    if (full || event.origin !== "user" || !/\bbrain[\s,]+st(?:o(?:p)?)?\b/i.test(event.text)) return false;
    const snapshot = pending();
    if (!snapshot.length) return false;
    const ambiguous = !selected().isolated || snapshot.length !== 1 || event.finalization !== "final" || event.certainty !== "known" || (event.confidence ?? 0) < 0.9 || !/^brain[\s,]+stop[.!?\s]*$/i.test(event.text.trim());
    for (const receipt of snapshot) {
      const sent = send({ type: "tool_denial", toolUseId: receipt.toolUseId, turnId: receipt.turnId, channel: "voice", message: ambiguous ? 'Heard unclearly; took “brain, stop” as refusal.' : 'Heard “brain, stop”.' });
      put({ ...receipt, phase: sent ? "sent" : "unknown", ambiguous, byVoice: true, heardAt: Date.now(), word: sent ? "Refusal sent · checking" : "Couldn't confirm the refusal", script: "" });
    }
    publish();
    return true;
  }
  const unsubscribe = root.stores.chat.subscribe(apply);
  return { state, frame, input, quiet, refresh() { publish(); quiet(); },
    lost() { for (const receipt of records.values()) if (receipt.phase === "sent") put({ ...receipt, phase: "unknown", word: "Couldn't confirm the refusal" }); publish(); },
    clear() { records.clear(); turns.clear(); announced.clear(); full = false; publish(); },
    dispose() { unsubscribe(); records.clear(); turns.clear(); announced.clear(); },
  };
}
