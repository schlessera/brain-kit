import { createConversationPermissions } from "./conversation-permissions.js";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessage, ServerMessage, ServerConversationOpened, ConversationWireEvent, ConversationWorkReceipt, ConversationOutputRecord } from "@schlessera/brain-ui-sdk/protocol";
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
  work: Record<string, ConversationWorkReceipt>;
  outputs: ConversationClientOutput[];
  unassigned: UnassignedRecognition[];
  unassignedWork: number;
}

/** Concrete root-owned orchestration; ordinary chat frames keep their existing path. */
export function createConversationClient(root: BrainUiServices, send: (message: ClientMessage) => boolean, answer: (sessionId: string | null, text: string) => boolean) {
  const state = createStore<ConversationClientState>(() => ({ available: false, active: false, token: 0, connection: "Connecting", micOn: false, interaction: "Listening", disclosureOpen: false, profile: null, sessionId: null, agentProviderId: null, text: "", notice: "", announcement: "", playing: false, work: {}, outputs: [], unassigned: [], unassignedWork: 0 }));
  let generation = 0;
  let disposed = false;
  let requested = false;
  let openingId: string | undefined;
  let openingGeneration = 0;
  let ready = false;
  let resync = 0;
  let consent = false;
  let agreedDisclosure: string | undefined;
  let stopFence = false;
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
  function updateOutput(epoch: number, outputId: string, patch: Partial<ConversationOutputRecord>) {
    const s = state.getState();
    const p = scope();
    if (!p) return;
    const old = s.outputs.find((output) => output.conversationId === p.conversationId && output.epoch === epoch && output.outputId === outputId);
    const next: ConversationClientOutput = { conversationId: p.conversationId, epoch, outputId, sessionId: s.sessionId, generated: "", playback: "unknown", ...old, ...patch };
    state.setState({ outputs: old ? s.outputs.map((output) => output === old ? next : output) : [...s.outputs, next].slice(-128) });
  }
  function disclosureKey(profile: ServerConversationOpened) {
    const providers = root.stores.provider.getState();
    const selected = providers.pinnedId ?? providers.selectedId;
    return JSON.stringify([profile.providerId, profile.disclosure, root.apiBase(), selected, providers.available.find((provider) => provider.id === selected)]);
  }
  function refresh() {
    const s = state.getState();
    const chat = root.stores.chat.getState();
    const buffer = s.sessionId === null ? chat.draft : chat.buffers[s.sessionId];
    const working = !!buffer?.isStreaming || Object.values(s.work).some((work) => work.state === "queued" || work.state === "running");
    const question = buffer?.askUser;
    const answering = question && !question.cancelled && !question.answers && !question.order && !question.formAnswers && question.questions.length === 1 && !question.list && !question.rank && !question.form;
    if (stopFence && ready && resync === 0 && !working) stopFence = false;
    const playing = playback.playingIds().some(id => !localTones.has(id));
    state.setState({ playing, interaction: stopFence ? "Checking whether the reply stopped"
      : playing ? "Speaking" : answering ? "Answering question" : s.text ? (hold ? "Sending soon" : "Review before sending") : working || playback.pending() ? "Working" : "Listening" });
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
    clearTimers();
    stopMic();
    saveDraft();
    playback.cut();
    playback.quiet(false);
    const profile = scope();
    if (profile && notify) send({ type: "conversation_stop", conversationId: profile.conversationId, ...(resumable ? { resumable: true } : {}) });
    ready = false; consent = false; requested = false;
    state.setState({ connection: lost ? "Speech lost" : "Reconnecting", notice: lost ? "Speech lost. Microphone off; reply outcome unknown until reconnect." : "Microphone off. Resume when voice is ready." });
    announce(lost ? "Speech lost. Chat is still connected." : "Microphone off");
  }
  function leave() {
    if (!state.getState().active) return;
    pause(false, false);
    fragments.clear(); lastInput = undefined; utterance = null;
    state.setState({ active: false, text: "", disclosureOpen: false });
    if (root.stores.voice.getState().mode === "conversation") root.stores.voice.getState().setMode("idle");
  }
  function startEpoch() {
    if (disposed || !state.getState().active || requested || openingId || root.stores.connection.getState().wsStatus !== "connected") return;
    const retained = state.getState().unassigned;
    if (retained.length >= CONVERSATION_LIMITS.maxFragmentsPerUtterance || retained.reduce((n, f) => n + f.text.length, 0) >= CONVERSATION_LIMITS.maxUtteranceChars) {
      state.setState({ notice: "Recognition is full. Review it in the composer before restarting voice." }); return;
    }
    requested = true; ready = false; resync = 0; generation++; state.setState({ token: generation });
    sequence = 0; utterance = null; ended = false; clearTimers();
    const s = state.getState();
    openingId = crypto.randomUUID(); openingGeneration = generation;
    send({ type: "conversation_start", contextualTasks: true, requestId: openingId, ...(!s.sessionId && s.agentProviderId ? { agentProviderId: s.agentProviderId } : {}), ...(s.profile ? { conversationId: s.profile.conversationId } : {}), ...(s.sessionId ? { sessionId: s.sessionId } : {}) });
  }
  async function capture() {
    const profile = scope();
    if (!state.getState().active || !consent || !profile || mic) return;
    const reason = state.getState().disclosureOpen ? "Review the voice service disclosure. Microphone off."
      : state.getState().connection !== "Connected" ? "Waiting for the voice connection. Microphone off."
      : !ready ? "Waiting for voice readiness. Microphone off."
      : resync !== 0 ? "Synchronizing voice. Microphone off."
      : stopFence ? "Checking whether the reply stopped. Microphone off." : "";
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
        if (playback.playingIds().some(id => !localTones.has(id))) { stopReply(); return; }
        if (playback.pending()) playback.flush();
        playback.quiet(false);
        if (!utterance || ended) { if (capturedInputs.size >= 4096) { pause(true); state.setState({ notice: "Restart voice to continue this long conversation." }); return; } utterance = crypto.randomUUID(); capturedInputs.add(utterance); ended = false; }
        clearTimeout(silence);
        silence = setTimeout(() => endpoint(own), 700);
      }
      if (!utterance || ended) return;
      let binary = "";
      for (const byte of pcm) binary += String.fromCharCode(byte);
      if (!send({ type: "conversation_audio", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: utterance, sequence: sequence++, rate: input.sampleRate, pcm: btoa(binary) })) pause(true);
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
    ended = true; silence = undefined;
    const profile = scope()!;
    send({ type: "conversation_endpoint", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: utterance });
    playback.quiet(!trustworthy());
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
    clearTimers();
    if (!ended && utterance) { ended = true; send({ type: "conversation_endpoint", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: utterance }); }
    const text = s.text.trim();
    for (const id of fragments.keys()) retiredInputs.add(id);
    if (answer(s.sessionId, text)) { removeSavedDraft(); fragments.clear(); state.setState({ text: "", interaction: "Answering question" }); lastInput = undefined; return true; }
    if (requests.size >= 4096) { pause(); state.setState({ notice: "Reload chat after pending work finishes to continue this long conversation." }); return false; }
    const requestId = crypto.randomUUID();
    const chat = root.stores.chat.getState();
    const draftCorrelation = s.sessionId ? undefined : chat.startDraftTurn();
    requests.set(requestId, { sessionId: s.sessionId, composerDraftId: draftId, conversationId: profile.conversationId, epoch: profile.epoch, text, ...(draftCorrelation ? { draftCorrelation } : {}) });
    if (!send({ type: "conversation_commit", conversationId: profile.conversationId, epoch: profile.epoch, utteranceId: lastInput.utteranceId, requestId, text })) { pause(true); return false; }
    if (s.sessionId) root.stores.followUp.getState().addLocal(s.sessionId, { requestId, text, source: "voice-conversation", queuedAt: Date.now() });
    else { chat.addUserMessage(null, text, "voice-conversation", undefined, { requestId }); chat.startAssistantMessage(null, undefined, requestId); }
    removeSavedDraft(); fragments.clear(); lastInput = undefined;
    state.setState({ text: "" }); announce("Sending"); playback.quiet(true); refresh();
    return true;
  }
  function stopReply() {
    // Closing the speech epoch is the supported remote stop operation. The
    // local flush happens synchronously; no remote acknowledgement is invented.
    pause();
    stopFence = true;
    state.setState({ interaction: "Checking whether the reply stopped", notice: "Microphone off while checking the reply stop. Resume when voice is ready." });
    announce("Checking whether the reply stopped");
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
      outputs: s.outputs.map(o => o.conversationId === work.conversationId && o.sessionId === null ? { ...o, sessionId } : o),
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
        state.setState({ sessionId: message.sessionId, outputs: state.getState().outputs.map((output) => output.conversationId === request.conversationId && output.sessionId === null ? { ...output, sessionId: message.sessionId } : output) });
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
      openingId = undefined;
      if (!s.active || openingGeneration !== generation) {
        requested = false;
        send({ type: "conversation_stop", conversationId: message.conversationId });
        if (s.active) queueMicrotask(startEpoch);
        return null;
      }
      if (message.type === "conversation_closed") { send({ type: "conversation_stop", conversationId: message.conversationId }); pause(true, true, false); return null; }
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
      generation++; state.setState({ token: generation }); stopMic(); playback.dispose(); playback = makePlayback(); fragments.clear(); retiredInputs.clear(); capturedInputs.clear(); manualReview.clear(); lastInput = undefined;
      state.setState({ profile: message, connection: "Connected", text: "", interaction: stopFence ? "Checking whether the reply stopped" : "Listening", disclosureOpen: agreedDisclosure !== disclosureKey(message) });
      resync = message.resync.work + message.resync.outputs;
      ready = false;
      return null;
    }
    const p = scope();
    if (!p || !("conversationId" in message) || message.conversationId !== p.conversationId) return null;
    if (message.type === "conversation_output") { updateOutput(message.epoch, message.outputId, message); if (resync > 0) resync--; refresh(); if (consent) void capture(); return null; }
    if (!("epoch" in message) || message.epoch !== p.epoch) return null;
    if (message.type === "conversation_closed") {
      // An old epoch can close after explicit Resume has already requested
      // its replacement. The opening's own closed response is handled above;
      // this receipt must not retire the replacement request or its consent.
      if (openingId && requested) return null;
      requested = false;
      if (message.reason === "stopped") {
        if (typeof document === "undefined" || !document.hidden) startEpoch();
      } else pause(true);
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
        const retained = state.getState().unassigned;
        // Captured identity is evidence only; never manufacture a user message or edit a manual draft.
        if (retained.length >= CONVERSATION_LIMITS.maxFragmentsPerUtterance || retained.reduce((n, f) => n + f.text.length, 0) + event.text.length > CONVERSATION_LIMITS.maxUtteranceChars) {
          pause(); state.setState({ notice: "Recognition is full. Review it before restarting voice." }); return null;
        }
        state.setState({ unassigned: [...retained, { sessionId: s.sessionId, conversationId: p.conversationId, epoch: p.epoch, taskContext: true, sequence: retained.length, text: event.text, timing: { kind: "unavailable" }, finalization: event.finalization === "final" ? "final" : "unknown" }] });
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
      try { playback.enqueue(event.outputId, Uint8Array.from(atob(event.pcm), (c) => c.charCodeAt(0)), event.format); }
      catch { pause(true); }
    } else if (event.kind === "interrupted") stopReply();
    return null;
  }
  const unwatchChat = root.stores.chat.subscribe((next, previous) => {
    if (!state.getState().active) return;
    if (next.activeSessionId !== previous.activeSessionId && next.activeSessionId !== state.getState().sessionId) leave();
    else refresh();
  });
  const unwatchConnection = root.stores.connection.subscribe((next, previous) => {
    if (!state.getState().active || next.wsStatus === previous.wsStatus) return;
    if (next.wsStatus !== "connected") pause(true);
    else { state.setState({ connection: "Reconnecting" }); startEpoch(); announce("Reconnected. Microphone off."); }
  });
  const hidden = () => { if (document.hidden && state.getState().active) pause(); else if (state.getState().active && !requested) startEpoch(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
  const unwatchAuth = root.authLock.registerStop(async () => { leave(); requests.clear(); restoredRequests.clear(); openingId = undefined; requested = false; agreedDisclosure = undefined; stopFence = false; permissions.clear(); localTones.clear(); state.setState({ profile: null, work: {}, outputs: [], unassigned: [], unassignedWork: 0, available: false }); });
  return {
    state, frame, permissions,
    enter() {
      if (disposed || state.getState().active || root.stores.voice.getState().mode !== "idle" || root.stores.voice.getState().local !== "idle") return;
      const sessionId = root.stores.chat.getState().activeSessionId;
      if (state.getState().unassigned.some(f => !f.taskContext && f.sessionId !== sessionId)) { state.setState({ notice: "Return to the previous chat to review its recognized speech." }); return; }
      draftId = root.stores.drafts.getState().idFor(sessionId); savedVoice = "";
      const providers = root.stores.provider.getState();
      const agentProviderId = providers.available.some((provider) => provider.id === providers.selectedId) ? providers.selectedId : null;
      state.setState({ active: true, sessionId, agentProviderId, unassigned: state.getState().unassigned.filter(f => !f.taskContext || f.sessionId === sessionId), profile: null, work: {}, connection: "Connecting", disclosureOpen: true, text: "", notice: "", interaction: "Listening" });
      stopFence = false;
      root.stores.voice.getState().setMode("conversation");
      consent = false; startEpoch(); permissions.refresh();
    },
    start() { const profile = scope(); if (!profile) return; agreedDisclosure = disclosureKey(profile); consent = true; state.setState({ disclosureOpen: false }); void capture(); },
    details() { state.setState({ disclosureOpen: true }); },
    resume() { if (state.getState().disclosureOpen) return; consent = true; if (!ready) startEpoch(); void capture(); },
    mute() { consent = false; clearTimers(); endpoint(generation); stopMic(); state.setState({ notice: "Microphone muted. Unmute to speak." }); playback.quiet(true); permissions.refresh(); announce("Microphone off"); },
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
    discard() { clearTimers(); removeSavedDraft(); fragments.clear(); lastInput = undefined; state.setState({ text: "" }); refresh(); },
    stopReply, leave,
    dispose() { leave(); disposed = true; unwatchChat(); unwatchConnection(); unwatchAuth(); playback.dispose(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden); requests.clear(); },
  };
}
