import { createConversationRecovery } from "./conversation-recovery.js";
import { createConversationPermissions } from "./conversation-permissions.js";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessage, ServerMessage, ServerConversationOpened, ServerConversationClosed, ConversationWireEvent, ConversationWorkReceipt, ConversationOutputRecord } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { openConversationMicrophone, createConversationPlayback } from "./conversation-pcm.js";

export interface ConversationClientOutput extends ConversationOutputRecord {
  conversationId: string;
  sessionId: string | null;
}

export interface UnassignedRecognition {
  /** Ephemeral task context, separate from retained manual-review candidates. */
  taskContext?: boolean;
  sessionId: string | null;
  conversationId: string;
  epoch: number;
  sequence: number;
  text: string;
  sessionInterval?: { startMs: number; endMs: number };
  timing?: { kind: "unavailable" };
  finalization?: "final" | "unknown";
}

export interface ConversationClientState {
  available: boolean;
  active: boolean;
  token: number;
  connection: "Connecting" | "Connected" | "Reconnecting" | "Speech lost";
  micOn: boolean;
  interaction: "Listening" | "Sending soon" | "Review before sending" | "Working" | "Speaking" | "Checking whether the reply stopped" | "Answering question";
  disclosureOpen: boolean;
  profile: ServerConversationOpened | null;
  sessionId: string | null;
  agentProviderId: string | null;
  text: string;
  notice: string;
  announcement: string;
  playing: boolean;
  outputRecovery: "audible" | "speaking" | "checking" | "muted";
  work: Record<string, ConversationWorkReceipt>;
  outputs: ConversationClientOutput[];
  unassigned: UnassignedRecognition[];
  unassignedWork: number;
}

// Local presentation metadata is neither wire state nor a public output field.
const restoredOutputs = new WeakSet<ConversationClientOutput>();
export const isRestoredConversationOutput = (output: ConversationClientOutput) => restoredOutputs.has(output);
function outputInSession(output: ConversationClientOutput, sessionId: string) {
  const next = { ...output, sessionId };
  if (restoredOutputs.has(output)) restoredOutputs.add(next);
  return next;
}

/** Concrete root-owned orchestration; ordinary chat frames keep their existing path. */
export function createConversationClient(root: BrainUiServices, send: (message: ClientMessage) => boolean, answer: (sessionId: string | null, text: string) => boolean) {
  const state = createStore<ConversationClientState>(() => ({ available: false, active: false, token: 0, connection: "Connecting", micOn: false, interaction: "Listening", disclosureOpen: false, profile: null, sessionId: null, agentProviderId: null, text: "", notice: "", announcement: "", playing: false, outputRecovery: "audible", work: {}, outputs: [], unassigned: [], unassignedWork: 0 }));
  let generation = 0;
  let disposed = false;
  let requested = false;
  let closedNotice = "";
  let openingId: string | undefined;
  // Capture callbacks and opening ownership have different lifetimes: hiding
  // retires a microphone callback, never a same-entry opening request.
  let entryLifetime = 0;
  let openingEntry = 0;
  let entryProfileId: string | null = null;
  let ready = false;
  let resync = 0;
  let consent = false;
  let agreedDisclosure: string | undefined;
  let draftId: string | null = null;
  let savedVoice = "";
  let mic: ReturnType<typeof openConversationMicrophone> | undefined;
  let sequence = 0;
  let utterance: string | null = null;
  let ended = false;
  let lastSpeech = 0;
  let silence: ReturnType<typeof setTimeout> | undefined;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let finalization: ReturnType<typeof setTimeout> | undefined;
  let lastInput: Extract<ConversationWireEvent, { kind: "input_fragment" }> | undefined;
  const retiredInputs = new Set<string>();
  const capturedInputs = new Set<string>();
  const manualReview = new Set<string>();
  const fragments = new Map<string, Map<number, Extract<ConversationWireEvent, { kind: "input_fragment" }>>>();
  const requests = new Map<string, { draftCorrelation?: string; composerDraftId: string | null; sessionId: string | null; conversationId: string; epoch: number; text: string }>();
  const restoredRequests = new Set<string>();
  const scope = () => state.getState().profile;
  const current = (own: number) => !disposed && state.getState().active && own === generation;
  const announce = (announcement: string) => state.setState({ announcement });
  const localTones = new Set<string>();
  let playback = makePlayback();
  const recovery = createConversationRecovery();
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let controlOwners = 0;
  function resetRecovery() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    recovery.reset(); state.setState({ outputRecovery: "audible" });
  }
  function checkRecovery() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    const phase = recovery.poll(performance.now());
    state.setState({ outputRecovery: phase });
    if (phase === "audible") {
      state.setState({ notice: "Reply audio recovered; delayed interrupted audio may still play." });
      playback.quiet(true);
    } else if (phase === "muted") {
      state.setState({ notice: "Reply audio is muted. Recover reply audio to listen; the microphone is unchanged." });
    } else if (phase === "checking") recoveryTimer = setTimeout(checkRecovery, 25);
  }
  function suppressOutput(speaking = false) {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    recovery.suppress(speaking, performance.now());
    state.setState({ outputRecovery: recovery.phase, notice: "Reply audio paused locally; remote reply outcome is unknown." });
    // Flush, never retire an epoch-wide output identity or cancel host work.
    playback.flush(); playback.quiet(false);
    if (!speaking) recoveryTimer = setTimeout(checkRecovery, 25);
  }
  function retainContext(fragment: UnassignedRecognition) {
    const old = state.getState().unassigned;
    const review = old.filter(f => !f.taskContext);
    const context = [...old.filter(f => f.taskContext), fragment];
    let chars = context.reduce((n, f) => n + f.text.length, 0);
    while (context.length > CONVERSATION_LIMITS.maxFragmentsPerUtterance || chars > CONVERSATION_LIMITS.maxUtteranceChars) chars -= context.shift()!.text.length;
    state.setState({ unassigned: [...review, ...context] });
  }
  const permissions = createConversationPermissions(root, send, () => ({ active: state.getState().active, sessionId: state.getState().sessionId, micOn: state.getState().micOn, isolated: scope()?.capabilities.echoIsolatedInput === "supported", quiet: !state.getState().micOn || ended && !hold }), () => {
    playback.flush();
    const outputId = crypto.randomUUID(); localTones.add(outputId);
    const bytes = new Uint8Array(12000); const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 660 / 24000) * 1600 * Math.sin(i * Math.PI / (bytes.length / 2)), true);
    playback.enqueue(outputId, bytes, { encoding: "pcm16", channels: 1, sampleRate: 24000 });
    playback.quiet(true);
  }, () => { pause(); state.setState({ notice: "Too many pending approvals. Use Deny on screen." }); });
  function makePlayback() { return createConversationPlayback((outputId, playbackState) => {
    if (localTones.has(outputId)) return;
    const profile = scope();
    if (profile) {
      updateOutput(profile.epoch, outputId, { playback: playbackState });
      send({ type: "conversation_playback", conversationId: profile.conversationId, epoch: profile.epoch, outputId, playback: playbackState });
    }
    if (playbackState !== "played") state.setState({ notice: "spoken portion unknown" });
  }, () => refresh()); }
  function updateOutput(epoch: number, outputId: string, patch: Partial<ConversationOutputRecord>, restored = false) {
    const s = state.getState();
    const p = scope();
    if (!p) return;
    const old = s.outputs.find((output) => output.conversationId === p.conversationId && output.epoch === epoch && output.outputId === outputId);
    const next: ConversationClientOutput = { conversationId: p.conversationId, epoch, outputId, sessionId: s.sessionId, generated: "", playback: "unknown", ...old, ...patch };
    if (restored && !old || old && restoredOutputs.has(old)) restoredOutputs.add(next);
    state.setState({ outputs: old ? s.outputs.map((output) => output === old ? next : output) : [...s.outputs, next].slice(-128) });
  }
  function disclosureKey(profile: ServerConversationOpened) {
    // Compare the effective profile disclosed at entry, not a later picker pin
    // from automatic task/session adoption. Same-ID metadata changes and removal
    // still invalidate consent. Sort fields so roster serialization order does not.
    const effectiveId = profile.agentProviderId ?? entryProfileId;
    const entryProfile = root.stores.provider.getState().available.find(p => p.id === effectiveId);
    return JSON.stringify([profile.providerId, profile.disclosure, root.apiBase(), entryProfileId, effectiveId,
      entryProfile ? Object.entries(entryProfile).sort(([a], [b]) => a.localeCompare(b)) : null]);
  }
  function requireCurrentDisclosure() {
    const profile = scope();
    if (!state.getState().active || !profile || agreedDisclosure === undefined || agreedDisclosure === disclosureKey(profile)) return false;
    consent = false;
    if (ready && mic) endpoint(generation);
    clearTimers(); resetRecovery();
    generation++; state.setState({ token: generation }); stopMic(); saveDraft();
    playback.flush(); playback.quiet(false);
    state.setState({ disclosureOpen: true, notice: "The voice disclosure changed. Review it and select Start. Microphone off." });
    return true;
  }

  function refresh() {
    const s = state.getState();
    const chat = root.stores.chat.getState();
    const buffer = s.sessionId === null ? chat.draft : chat.buffers[s.sessionId];
    const working = !!buffer?.isStreaming || Object.values(s.work).some((work) => work.state === "queued" || work.state === "running");
    const question = buffer?.askUser;
    const answering = question && !question.cancelled && !question.answers && !question.order && !question.formAnswers && question.questions.length === 1 && !question.list && !question.rank && !question.form;
    const playing = playback.playingIds().some(id => !localTones.has(id));
    state.setState({ playing, interaction: playing ? "Speaking" : answering ? "Answering question" : s.text ? (hold ? "Sending soon" : "Review before sending") : working || playback.pending() ? "Working" : "Listening" });
  }
  function clearTimers() { clearTimeout(silence); clearTimeout(hold); clearTimeout(finalization); silence = hold = finalization = undefined; }
  function stopMic() { mic?.stop(); mic = undefined; state.setState({ micOn: false }); }
  function saveDraft() {
    if (!draftId) return;
    // Interim recognition is never retained. Unknown finality is the explicit
    // manual-review candidate, as required by the GPT-Live profile.
    const text = [...fragments.values()].flatMap((items) => [...items.values()].filter((f) => f.finalization !== "interim").sort((a, b) => a.sequence - b.sequence).map((f) => f.text)).join(" ").trim();
    const drafts = root.stores.drafts.getState();
    const id = drafts.resolveId(draftId);
    const old = drafts.drafts[id]?.text ?? "";
    const prefix = savedVoice && old.endsWith(savedVoice) ? old.slice(0, -savedVoice.length).trimEnd() : old;
    const next = [prefix, text].filter(Boolean).join("\n\n");
    if (next !== old) drafts.edit(id, state.getState().sessionId, { text: next });
    savedVoice = text;
  }
  function removeSavedDraft() {
    if (!draftId || !savedVoice) return;
    const drafts = root.stores.drafts.getState();
    const id = drafts.resolveId(draftId);
    const old = drafts.drafts[id]?.text ?? "";
    if (old.endsWith(savedVoice)) drafts.edit(id, state.getState().sessionId, { text: old.slice(0, -savedVoice.length).trimEnd() });
    savedVoice = "";
  }
  function pause(lost = false, resumable = true, notify = true) {
    generation++; state.setState({ token: generation });
    permissions.lost();
    clearTimers(); resetRecovery();
    stopMic();
    saveDraft();
    playback.cut();
    playback.quiet(false);
    const profile = scope();
    if (profile && notify) send({ type: "conversation_stop", conversationId: profile.conversationId, ...(resumable ? { resumable: true } : {}) });
    ready = false; consent = false; requested = false;
    state.setState({ connection: lost ? "Speech lost" : "Reconnecting", notice: closedNotice || (lost ? "Speech lost. Microphone off; reply outcome unknown until reconnect." : "Microphone off. Resume when voice is ready.") });
    announce(lost ? "Speech lost. Chat is still connected." : "Microphone off");
  }
  // Suspend the unavailable transport, never consent. Drop PCM rather than
  // accumulating disconnected speech for replay. A new disclosed epoch gates capture.
  function suspend() {
    if (!state.getState().active) return;
    const retainedConsent = consent;
    pause(true);
    openingId = undefined;
    consent = retainedConsent;
    state.setState({ notice: closedNotice || (retainedConsent ? "Voice temporarily unavailable. Listening will recover in the same disclosed scope." : "Voice temporarily unavailable. Microphone remains muted.") });
  }
  function closeDiagnostic(reason: ServerConversationClosed["reason"]) {
    // Only local fixed classes survive an epoch closure. Remote message text
    // can contain provider details or content and must never be retained here.
    const reasons: Record<ServerConversationClosed["reason"], string> = {
      stopped: "The voice session stopped.", replaced: "The voice session was replaced.",
      disconnected: "The voice connection was lost.", provider_closed: "The voice service closed the connection.",
      provider_error: "The voice service failed.", backpressure: "The voice session reached a transport limit.",
      correlation: "The voice service could not match the conversation input.", refused: "The voice session was refused.",
    };
    return `${reasons[reason] ?? "The voice session closed."} Microphone off; reply outcome unknown. Resume when voice is ready.`;
  }
  function clearClosedNotice() {
    if (!closedNotice) return;
    closedNotice = "";
    state.setState({ notice: "" });
  }
  function leave() {
    clearClosedNotice();
    if (!state.getState().active) return;
    entryLifetime++;
    pause(false, false);
    fragments.clear(); lastInput = undefined; utterance = null;
    state.setState({ active: false, text: "", disclosureOpen: false });
    if (root.stores.voice.getState().mode === "conversation") root.stores.voice.getState().setMode("idle");
  }
  function startEpoch() {
    if (disposed || !state.getState().active || requested || openingId || (typeof document !== "undefined" && document.hidden) || root.stores.connection.getState().wsStatus !== "connected") return;
    const retained = state.getState().unassigned.filter(f => !f.taskContext);
    if (retained.length >= CONVERSATION_LIMITS.maxFragmentsPerUtterance || retained.reduce((n, f) => n + f.text.length, 0) >= CONVERSATION_LIMITS.maxUtteranceChars) {
      state.setState({ notice: "Recognition is full. Review it in the composer before restarting voice." }); return;
    }
    clearClosedNotice();
    requested = true; ready = false; resync = 0; generation++; state.setState({ token: generation });
    sequence = 0; utterance = null; ended = false; clearTimers(); resetRecovery();
    const s = state.getState();
    openingId = crypto.randomUUID(); openingEntry = entryLifetime;
    send({ type: "conversation_start", contextualTasks: true, requestId: openingId, ...(!s.sessionId && s.agentProviderId ? { agentProviderId: s.agentProviderId } : {}), ...(s.profile ? { conversationId: s.profile.conversationId } : {}), ...(s.sessionId ? { sessionId: s.sessionId } : {}) });
  }
  async function capture() {
    const profile = scope();
    if (requireCurrentDisclosure()) return;
    if (!state.getState().active || !consent || !profile || mic || (typeof document !== "undefined" && document.hidden)) return;
    const reason = state.getState().disclosureOpen ? "Review the voice service disclosure. Microphone off."
      : state.getState().connection !== "Connected" ? "Waiting for the voice connection. Microphone off."
      : !ready ? "Waiting for voice readiness. Microphone off."
      : resync !== 0 ? "Synchronizing voice. Microphone off." : "";
    if (reason) { state.setState({ notice: reason }); return; }
    const own = generation;
    const input = inputFormat;
    if (!input) return;
    state.setState({ notice: "Opening microphone. Check browser permission if prompted." });
    const captureSession = openConversationMicrophone(input.sampleRate, (pcm, speaking) => {
      if (!current(own) || mic !== captureSession) return;
      if (speaking) {
        finalAfterSpeech = false;
        lastSpeech = performance.now();
        clearTimeout(hold); hold = undefined;
        if (playback.playingIds().some(id => !localTones.has(id)) || recovery.phase !== "audible") suppressOutput(true);
        if (playback.pending()) playback.flush();
        playback.quiet(false);
        if (!utterance || ended) { if (capturedInputs.size >= 4096) { pause(true); state.setState({ notice: "Restart voice to continue this long conversation." }); return; } utterance = crypto.randomUUID(); capturedInputs.add(utterance); ended = false; }
        clearTimeout(silence);
        silence = setTimeout(() => endpoint(own), 700);
      }
      if (!utterance || ended) return;
      let binary = "";
      for (const byte of pcm) binary += String.fromCharCode(byte);
      if (!send({ type: "conversation_audio", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: utterance, sequence: sequence++, rate: input.sampleRate, pcm: btoa(binary) })) { suspend(); startEpoch(); }
    }, () => {
      if (!current(own) || mic !== captureSession) return;
      state.setState({ micOn: true, notice: "" }); playback.quiet(true); announce("Microphone on"); refresh();
    }, () => { if (current(own) && mic === captureSession) { pause(true); state.setState({ notice: "Microphone input ended. Check the device, then resume." }); } });
    mic = captureSession;
    try { await captureSession.ready; }
    catch (error) { if (current(own) && mic === captureSession) {
      stopMic(); consent = false;
      const name = error instanceof DOMException ? error.name : "";
      state.setState({ notice: name === "NotAllowedError" ? "Microphone permission denied. Allow it in the browser, then unmute."
        : name === "NotFoundError" ? "No microphone found. Connect one, then unmute."
        : "Microphone could not be opened. Check the device and browser, then unmute." });
    } }
  }
  function endpoint(own: number) {
    if (!current(own) || !utterance || ended) return;
    ended = true; clearTimeout(silence); silence = undefined;
    const profile = scope()!;
    send({ type: "conversation_endpoint", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: utterance });
    if (recovery.phase === "speaking") { recovery.endpoint(performance.now()); checkRecovery(); }
    else if (recovery.phase === "audible") playback.quiet(!trustworthy());
    if (profile.capabilities.contextualTasks !== "supported") maybeHold(own);
    permissions.quiet();
    const endedUtterance = utterance;
    finalization = setTimeout(() => {
      if (!current(own)) return;
      manualReview.add(endedUtterance);
      if (utterance === endedUtterance) {
        clearTimeout(hold); hold = undefined;
        refresh();
        if (state.getState().text) announce("Needs review");
      }
    }, 2000);
  }
  let finalAfterSpeech = false;
  function trustworthy() {
    return finalAfterSpeech && !!utterance && [...fragments.keys()].every((id) => !manualReview.has(id)) && lastInput?.utteranceId === utterance && scope()?.capabilities.finalTranscript === "supported" && lastInput?.finalization === "final" && lastInput.origin === "user" && lastInput.certainty === "known" && (lastInput.confidence ?? 0) >= 0.9;
  }
  function maybeHold(own: number) {
    if (!ended || !trustworthy() || !state.getState().text || hold) return;
    hold = setTimeout(() => { hold = undefined; if (current(own) && ended && trustworthy() && performance.now() - lastSpeech >= 700) commit(own); }, 500);
    refresh();
  }
  function commit(own: number) {
    const s = state.getState();
    const profile = scope();
    if (!current(own) || !profile || !ready || resync || !s.text.trim() || !lastInput || s.interaction === "Checking whether the reply stopped") return false;
    // Manual review ends speech through the same bounded recovery transition.
    // Cancel review timers after endpoint(), which may have scheduled them.
    endpoint(own); clearTimers();
    const text = s.text.trim();
    for (const id of fragments.keys()) retiredInputs.add(id);
    if (answer(s.sessionId, text)) { removeSavedDraft(); fragments.clear(); state.setState({ text: "", interaction: "Answering question" }); lastInput = undefined; return true; }
    if (requests.size >= 4096) { pause(); state.setState({ notice: "Reload chat after pending work finishes to continue this long conversation." }); return false; }
    const requestId = crypto.randomUUID();
    const chat = root.stores.chat.getState();
    const draftCorrelation = s.sessionId ? undefined : chat.startDraftTurn();
    requests.set(requestId, { sessionId: s.sessionId, composerDraftId: draftId, conversationId: profile.conversationId, epoch: profile.epoch, text, ...(draftCorrelation ? { draftCorrelation } : {}) });
    if (!send({ type: "conversation_commit", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: lastInput.utteranceId, requestId, text })) { suspend(); startEpoch(); return false; }
    if (s.sessionId) root.stores.followUp.getState().addLocal(s.sessionId, { requestId, text, source: "voice-conversation", queuedAt: Date.now() });
    else { chat.addUserMessage(null, text, "voice-conversation", undefined, { requestId }); chat.startAssistantMessage(null, undefined, requestId); }
    removeSavedDraft(); fragments.clear(); lastInput = undefined;
    state.setState({ text: "" }); announce("Sending"); playback.quiet(true); refresh();
    return true;
  }
  function stopReply() {
    // Explicit output control is neither microphone revocation nor cancellation
    // of a host task. Ordinary host receipts/serialization remain authoritative.
    suppressOutput(!!mic && !ended && !!utterance);
    refresh();
  }

  // Adopt only a task admitted in the live epoch. Update voice before selecting
  // its transcript: the chat subscription still treats other selections as leave.
  function adoptContextualSession(work: ConversationWorkReceipt, sessionId: string) {
    const s = state.getState();
    const p = scope();
    if (!s.active || work.provenance !== "contextual" || work.state !== "running" || !work.turnId
      || p?.conversationId !== work.conversationId || p.epoch !== work.epoch
      || s.sessionId !== null || root.stores.chat.getState().activeSessionId !== null) return;
    state.setState({ sessionId,
      outputs: s.outputs.map(o => o.conversationId === work.conversationId && o.sessionId === null ? outputInSession(o, sessionId) : o),
      unassigned: s.unassigned.map(f => f.conversationId === work.conversationId && f.sessionId === null ? { ...f, sessionId } : f),
    });
    // This task has no reviewed composer draft. Materialize its own buffer so
    // ordinary session_info routing cannot adopt the independent typed draft.
    root.stores.chat.getState().setActiveSession(sessionId);
  }
  let inputFormat: Extract<ConversationWireEvent, { kind: "ready" }>["input"] | undefined;
  function frame(message: ServerMessage): ServerMessage | null {
    permissions.frame(message);
    if (message.type === "server_hello") state.setState({ available: message.capabilities?.liveConversation === true && message.capabilities?.conversationPause === true });
    if (message.type === "session_info" && message.requestId) {
      const work = state.getState().work[message.requestId];
      // The bridge broadcasts identity before the work receipt names the session.
      // Match both host request and turn; unrelated or stale frames cannot bind.
      if (work?.turnId && work.turnId === (message as ServerMessage & { turnId?: string }).turnId && (!work.sessionId || work.sessionId === message.sessionId)) adoptContextualSession(work, message.sessionId);
    }
    if (message.type === "session_info" && message.requestId && requests.has(message.requestId)) {
      const request = requests.get(message.requestId)!;
      if (request.composerDraftId && request.sessionId === null) root.stores.drafts.getState().associateVoice(request.composerDraftId, message.sessionId, message.requestId);
      if (state.getState().active && scope()?.conversationId === request.conversationId && scope()?.epoch === request.epoch && state.getState().sessionId === request.sessionId) {
        state.setState({ sessionId: message.sessionId, outputs: state.getState().outputs.map((output) => output.conversationId === request.conversationId && output.sessionId === null ? outputInSession(output, message.sessionId) : output) });
      }
      return request.draftCorrelation ? { ...message, draftId: request.draftCorrelation } : message;
    }
    if (message.type === "error" && message.code.startsWith("CONVERSATION_")) {
      openingId = undefined; pause(true, true, false);
      state.setState({ notice: message.message, ...(message.code === "CONVERSATION_UNKNOWN" ? { profile: null } : {}) });
      return null;
    }
    if (!message.type.startsWith("conversation_")) return message;
    const s = state.getState();
    if ((message.type === "conversation_opened" || message.type === "conversation_closed") && openingId && message.requestId === openingId) {
      // A duplicate/foreign response cannot consume the valid pending request.
      if (s.active && openingEntry === entryLifetime && s.profile
        && (message.conversationId !== s.profile.conversationId || message.epoch <= s.profile.epoch)) return null;
      openingId = undefined;
      if (!s.active || openingEntry !== entryLifetime) {
        requested = false;
        send({ type: "conversation_stop", conversationId: message.conversationId });
        if (s.active) queueMicrotask(startEpoch);
        return null;
      }
      if (message.type === "conversation_closed") { closedNotice = closeDiagnostic(message.reason); send({ type: "conversation_stop", conversationId: message.conversationId }); pause(true, true, false); return null; }
    } else if (message.type === "conversation_opened") return null;
    if (message.type === "conversation_work") {
      const p = scope();
      const request = requests.get(message.requestId);
      const ownRequest = request?.conversationId === message.conversationId && request.epoch === message.epoch;
      if (p?.conversationId !== message.conversationId && !ownRequest) return null;
      const neverStarted = message.state === "refused" || (!message.turnId && (message.state === "cancelled" || message.state === "error"));
      if (ownRequest && neverStarted && request.composerDraftId && !restoredRequests.has(message.requestId)) {
        restoredRequests.add(message.requestId);
        const drafts = root.stores.drafts.getState();
        const id = drafts.resolveId(request.composerDraftId);
        const old = drafts.drafts[id]?.text ?? "";
        drafts.edit(id, request.sessionId, { text: [old, request.text].filter(Boolean).join("\n\n") });
      }
      if (message.state === "refused" || message.state === "cancelled" || message.state === "error") root.stores.followUp.getState().dropLocal(message.requestId);
      if (s.active && p?.conversationId === message.conversationId) {
        if (message.sessionId) adoptContextualSession(message, message.sessionId);
        const work = Object.fromEntries(Object.entries({ ...s.work, [message.requestId]: message }).slice(-128));
        state.setState({ work });
        if (resync > 0) resync--;
        refresh(); if (consent) void capture();
      }
      return null;
    }
    if (!s.active) return null;
    if (message.type === "conversation_opened") {
      if (!requested || (s.profile && (s.profile.conversationId !== message.conversationId || message.epoch <= s.profile.epoch))) return null;
      clearClosedNotice();
      generation++; state.setState({ token: generation }); stopMic(); resetRecovery(); playback.dispose(); playback = makePlayback(); fragments.clear(); retiredInputs.clear(); capturedInputs.clear(); manualReview.clear(); lastInput = undefined;
      state.setState({ profile: message, connection: "Connected", text: "", interaction: "Listening", disclosureOpen: agreedDisclosure !== disclosureKey(message) });
      if (agreedDisclosure !== disclosureKey(message)) consent = false;
      resync = message.resync.work + message.resync.outputs;
      ready = false;
      return null;
    }
    const p = scope();
    if (!p || !("conversationId" in message) || message.conversationId !== p.conversationId) return null;
    if (message.type === "conversation_output") { updateOutput(message.epoch, message.outputId, message, true); if (resync > 0) resync--; refresh(); if (consent) void capture(); return null; }
    if (!("epoch" in message) || message.epoch !== p.epoch) return null;
    if (message.type === "conversation_closed") {
      // An old epoch can close after explicit Resume has already requested
      // its replacement. The opening's own closed response is handled above;
      // this receipt must not retire the replacement request or its consent.
      if (openingId && requested) return null;
      requested = false;
      if (message.reason === "stopped") {
        suspend(); startEpoch();
      } else if (message.reason === "disconnected" || message.reason === "provider_closed") {
        closedNotice = closeDiagnostic(message.reason); suspend(); startEpoch();
      } else { closedNotice = closeDiagnostic(message.reason); pause(true); }
      return null;
    }
    if (message.type !== "conversation_event") return null;
    const event = message.event;
    if (event.kind === "ready") { inputFormat = event.input; ready = true; refresh(); if (consent) void capture(); return null; }
    if (!ready) return null;
    if (event.kind === "unassigned_input_fragment") {
      const retained = state.getState().unassigned;
      if (retained.some(f => f.conversationId === p.conversationId && f.epoch === p.epoch && f.sequence === event.sequence)) return null;
      // Retain the boundary-crossing fragment before stopping. Never truncate
      // it or merge approximate session intervals into captured utterances.
      const unassigned = [...retained, { sessionId: s.sessionId, conversationId: p.conversationId, epoch: p.epoch, taskContext: p.capabilities.contextualTasks === "supported", ...event }];
      if (p.capabilities.contextualTasks === "supported") { retainContext(unassigned.at(-1)!); return null; }
      state.setState({ unassigned });
      if (unassigned.length >= CONVERSATION_LIMITS.maxFragmentsPerUtterance || unassigned.reduce((n, f) => n + f.text.length, 0) >= CONVERSATION_LIMITS.maxUtteranceChars) {
        pause(); state.setState({ notice: "Recognition is full. Review it in the composer before restarting voice." });
      }
      return null;
    }
    if (event.kind === "unassigned_delegation") {
      state.setState({ unassignedWork: state.getState().unassignedWork + 1 }); return null;
    }
    if (event.kind === "input_fragment") {
      if (!capturedInputs.has(event.utteranceId) || retiredInputs.has(event.utteranceId)) return null;
      if (permissions.input(event)) {
        retiredInputs.add(event.utteranceId); fragments.delete(event.utteranceId); lastInput = undefined;
        state.setState({ text: [...fragments.values()].flatMap(items => [...items.values()].map(f => f.text)).join(" ").trim() });
        saveDraft(); refresh(); return null;
      }
      if (p.capabilities.contextualTasks === "supported") {
        // Bounded ephemeral context, never a manual-review draft or grant.
        retainContext({ sessionId: s.sessionId, conversationId: p.conversationId, epoch: p.epoch, taskContext: true, sequence: event.sequence, text: event.text, timing: { kind: "unavailable" }, finalization: event.finalization === "final" ? "final" : "unknown" });
        return null;
      }
      const items = fragments.get(event.utteranceId) ?? new Map();
      if (event.certainty !== "known" || event.origin !== "user" || (event.confidence ?? 0) < 0.9) manualReview.add(event.utteranceId);
      finalAfterSpeech = event.finalization === "final";
      items.set(event.sequence, event); fragments.set(event.utteranceId, items); lastInput = event;
      const text = [...fragments.values()].flatMap((f) => [...f.values()].sort((a, b) => a.sequence - b.sequence).map((f) => f.text)).join(" ").trim();
      state.setState({ text, notice: event.certainty === "unknown" || event.origin !== "user" ? "I couldn't hear that clearly. Review before sending." : s.notice });
      saveDraft();
      if (text.length > p.limits.maxCommitChars) {
        pause(); state.setState({ notice: "The recognized text is too long. Leave voice and review the complete draft." }); return null;
      }
      maybeHold(generation); refresh();
    } else if (event.kind === "output_transcript") {
      const old = state.getState().outputs.find((output) => output.conversationId === p.conversationId && output.epoch === p.epoch && output.outputId === event.outputId);
      updateOutput(p.epoch, event.outputId, { generated: ((old?.generated ?? "") + event.text).slice(0, p.limits.maxGeneratedChars) });
    } else if (event.kind === "audio") {
      try {
        const pcm = Uint8Array.from(atob(event.pcm), c => c.charCodeAt(0));
        if (state.getState().disclosureOpen || typeof document !== "undefined" && document.hidden) { updateOutput(p.epoch, event.outputId, { playback: "unknown" }); return null; }
        if (recovery.phase !== "audible") {
          recovery.observe(pcm, performance.now());
          updateOutput(p.epoch, event.outputId, { playback: "unknown" });
          // Poll before the next event; never enqueue a suppressed chunk.
          return null;
        }
        playback.enqueue(event.outputId, pcm, event.format);
      }
      catch { pause(true); }
    } else if (event.kind === "interrupted") { suppressOutput(!!mic && !ended && !!utterance); refresh(); }
    return null;
  }
  const unwatchChat = root.stores.chat.subscribe((next, previous) => {
    if (!state.getState().active) return;
    if (next.activeSessionId !== previous.activeSessionId && next.activeSessionId !== state.getState().sessionId) leave();
    else refresh();
  });
  const unwatchProvider = root.stores.provider.subscribe(() => { requireCurrentDisclosure(); });
  const unwatchConnection = root.stores.connection.subscribe((next, previous) => {
    if (!state.getState().active || next.wsStatus === previous.wsStatus) return;
    if (next.wsStatus !== "connected") suspend();
    else { state.setState({ connection: "Reconnecting" }); startEpoch(); announce(consent ? "Reconnected. Restoring listening." : "Reconnected. Microphone off."); }
  });
  const hidden = () => {
    if (!state.getState().active) return;
    if (document.hidden) {
      // Visibility is local unavailability, not a broken provider connection.
      // End the current capture interval, retain the epoch/context and consent.
      if (ready && mic) endpoint(generation);
      clearTimers(); resetRecovery();
      generation++; state.setState({ token: generation }); stopMic(); saveDraft();
      playback.flush(); playback.quiet(false);
      if (!closedNotice) state.setState({ notice: "Voice is paused while this page is hidden. Microphone intent is unchanged." });
    } else if (!requested) startEpoch();
    else if (consent) void capture();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
  const unwatchAuth = root.authLock.registerStop(async () => { leave(); requests.clear(); restoredRequests.clear(); openingId = undefined; requested = false; agreedDisclosure = undefined; permissions.clear(); localTones.clear(); state.setState({ profile: null, work: {}, outputs: [], unassigned: [], unassignedWork: 0, available: false }); });
  return {
    state, frame, permissions,
    attachControls() {
      controlOwners++;
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false; controlOwners--;
        queueMicrotask(() => { if (!controlOwners) leave(); });
      };
    },
    recoverOutput() {
      if (!state.getState().active || !ready || state.getState().disclosureOpen || recovery.phase !== "muted") return;
      resetRecovery(); playback.flush(); playback.quiet(true);
      state.setState({ notice: "Reply audio recovered manually; delayed interrupted audio may still play." });
    },
    enter() {
      if (disposed || state.getState().active || root.stores.voice.getState().mode !== "idle" || root.stores.voice.getState().local !== "idle") return;
      const sessionId = root.stores.chat.getState().activeSessionId;
      if (state.getState().unassigned.some(f => !f.taskContext && f.sessionId !== sessionId)) { state.setState({ notice: "Return to the previous chat to review its recognized speech." }); return; }
      draftId = root.stores.drafts.getState().idFor(sessionId); savedVoice = "";
      const providers = root.stores.provider.getState();
      const agentProviderId = providers.available.some((provider) => provider.id === providers.selectedId) ? providers.selectedId : null;
      entryLifetime++;
      entryProfileId = providers.pinnedId ?? agentProviderId;
      state.setState({ active: true, sessionId, agentProviderId, unassigned: state.getState().unassigned.filter(f => !f.taskContext || f.sessionId === sessionId), profile: null, work: {}, connection: "Connecting", disclosureOpen: true, text: "", notice: "", interaction: "Listening" });
      // A new entry needs Start even when the service matches the last visit.
      agreedDisclosure = undefined;
      root.stores.voice.getState().setMode("conversation");
      consent = false; startEpoch(); permissions.refresh();
    },
    start() { const profile = scope(); if (!profile) return; agreedDisclosure = disclosureKey(profile); consent = true; state.setState({ disclosureOpen: false }); void capture(); },
    details() { state.setState({ disclosureOpen: true }); },
    resume() { if (state.getState().disclosureOpen) return; consent = true; if (!ready) startEpoch(); void capture(); },
    mute() { consent = false; if (ready && mic) endpoint(generation); clearTimers(); stopMic(); state.setState({ notice: "Microphone muted. Unmute to speak." }); playback.quiet(true); permissions.refresh(); announce("Microphone off"); },
    commit,
    reviewUnassigned() {
      const s = state.getState();
      const selected = s.unassigned.filter(f => f.sessionId === root.stores.chat.getState().activeSessionId);
      if (!selected.length) return false;
      // One explicit transfer, with no send. Existing draft and review text
      // remain intact; the existing voice review path preserves provenance.
      const text = selected.map(f => f.text).join("");
      leave();
      const voice = root.stores.voice.getState();
      voice.setReviewText([voice.reviewText, text].filter(Boolean).join("\n\n"));
      state.setState({ unassigned: s.unassigned.filter(f => !selected.includes(f)), unassignedWork: 0 });
      return true;
    },
    discard() {
      if (ready && mic) endpoint(generation);
      clearTimers();
      for (const id of fragments.keys()) retiredInputs.add(id);
      removeSavedDraft(); fragments.clear(); lastInput = undefined; state.setState({ text: "" }); refresh();
    },
    stopReply, leave,
    dispose() { leave(); disposed = true; unwatchChat(); unwatchProvider(); unwatchConnection(); unwatchAuth(); playback.dispose(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden); requests.clear(); },
  };
}
