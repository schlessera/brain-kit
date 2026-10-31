import { createConversationRecovery } from "./conversation-recovery.js";
import { createConversationPermissions } from "./conversation-permissions.js";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessage, ServerMessage, ServerConversationOpened, ConversationProfile, ServerConversationClosed, ConversationWireEvent, ConversationWorkReceipt, ConversationOutputRecord, DialoguePage, DialogueRecord } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { openConversationMicrophone, createConversationPlayback } from "./conversation-pcm.js";

export interface ConversationClientOutput extends ConversationOutputRecord {
  /** This projected readable segment contains only failed-write text. */
  unsaved?: true;
  /** Exact failed-write deltas, separate from the bounded generated cache. */
  unsavedGenerated?: string;
  unsavedFragments?: number;
  orderUnknown?: boolean;
  providerId?: string;
  conversationId: string;
  sessionId: string | null;
}

export interface UnassignedRecognition {
  utteranceId?: string;
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

/** Display evidence from transient capture or retained text; never an authenticated user message. */
export type ConversationRecognition = Extract<ConversationWireEvent, { kind: "input_fragment" | "unassigned_input_fragment" }> & {
  sessionId: string | null;
  conversationId: string;
  epoch: number;
  providerId: string;
  activation: number;
  restored?: boolean;
  unsaved?: true;
  orderUnknown?: boolean;
  moved?: true;
  contextual: boolean;
};
export function recognitionIdentity(f: ConversationRecognition) {
  return JSON.stringify(["recognition", f.conversationId, f.epoch, f.kind,
    f.kind === "input_fragment" ? f.utteranceId : null, f.sequence]);
}
export function conversationService(providerId: string) {
  return providerId === "gemini-live" ? "Gemini Live" : providerId === "gpt-live" ? "GPT-Live" : providerId;
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
  conversationProfile: ConversationProfile | null;
  durableAvailable: boolean;
  sessionId: string | null;
  agentProviderId: string | null;
  text: string;
  voiceDraft: { id: string; edit: number } | null;
  notice: string;
  announcement: string;
  playing: boolean;
  outputRecovery: "audible" | "speaking" | "checking" | "muted";
  work: Record<string, ConversationWorkReceipt>;
  outputs: ConversationClientOutput[];
  unassigned: UnassignedRecognition[];
  recognition: ConversationRecognition[];
  unassignedWork: number;
  dialogue: Record<string, DialoguePage>;
  dialogueNotice: string;
  dialogueRestoredThrough: Record<string,number>;
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
  const state = createStore<ConversationClientState>(() => ({ available: false, active: false, token: 0, connection: "Connecting", micOn: false, interaction: "Listening", disclosureOpen: false, profile: null, conversationProfile: null, durableAvailable: false, sessionId: null, agentProviderId: null, text: "", voiceDraft: null, notice: "", announcement: "", playing: false, outputRecovery: "audible", work: {}, outputs: [], unassigned: [], recognition: [], unassignedWork: 0, dialogue: {}, dialogueNotice: "", dialogueRestoredThrough: {} }));
  let durableAvailable = false;
  let dialoguePrincipalKey:string|undefined;
  const dialogueReads = new Map<string, { key: string; older: boolean }>();
  function historyOwnerFor(key:string):string|undefined {
    return root.stores.chat.getState().historyOwners[key];
  }
  function loadDialogue(key: string, older: boolean = false) {
    if (!durableAvailable || [...dialogueReads.values()].some(r => r.key === key)) return;
    const page = state.getState().dialogue[key];
    if (older && !page?.before) return;
    const requestId = crypto.randomUUID();
    dialogueReads.set(requestId, { key, older });
    const sent=send({ type: "dialogue_read", requestId, ...(historyOwnerFor(key) ? { ownerId: historyOwnerFor(key) } : {sessionId: key}),
      ...(older && page ? {cursor:page.cursor, generation: page.generation} : {}) });
    if(!sent)dialogueReads.delete(requestId);
  }
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
  let agreedEntry: number | undefined;
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
  // The host forwards unassigned sequence in strict arrival order. One scalar
  // fences evicted replay without an ever-growing contextual-epoch identity set.
  let unassignedThrough = -1;
  // Captured identities keep the existing finite capture/fragment limits.
  const seenRecognition = new Set<string>();
  const retiredInputs = new Set<string>();
  const capturedInputs = new Set<string>();
  const manualReview = new Set<string>();
  const incompleteReview = new Set<string>();
  const fragments = new Map<string, Map<number, Extract<ConversationWireEvent, { kind: "input_fragment" }>>>();
  const reviewIsIncomplete = () => [...fragments.keys()].some(id=>incompleteReview.has(id));
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
  let unsavedOverflow = false;
  let storageFailedScope: string | undefined;
  let storageFailureCode: "DIALOGUE_STORAGE" | "DIALOGUE_PENDING_PRESSURE" | undefined;
  const liveScopeKey = () => {const p=scope();return p ? JSON.stringify([p.conversationId,p.epoch]) : undefined;};
  function stopForStorageFailure(code?: "DIALOGUE_STORAGE" | "DIALOGUE_PENDING_PRESSURE") {
    const key=liveScopeKey(); if(!key)return;
    if(storageFailedScope===key){if(code)storageFailureCode=code;return;}
    storageFailedScope=key; storageFailureCode=code ?? "DIALOGUE_STORAGE";
    consent=false; permissions.lost(); clearTimers(); resetRecovery(); stopMic(); playback.cut();
  }
  function retainUnsaved(text: string): boolean {
    const current = state.getState();
    const words = [...current.recognition.filter(f=>f.unsaved).map(f=>f.text),...current.outputs.map(o=>o.unsavedGenerated ?? "")];
    const count = current.recognition.filter(f=>f.unsaved).length + current.outputs.reduce((n,o)=>n+(o.unsavedFragments ?? 0),0);
    if (count >= CONVERSATION_LIMITS.maxPendingDialogueObservations || words.reduce((n,t)=>n+new TextEncoder().encode(t).length,0)+new TextEncoder().encode(text).length > CONVERSATION_LIMITS.maxPendingDialogueBytes) {
      unsavedOverflow = true;
      state.setState({dialogueNotice:"Some unsaved conversation text exceeded this device's temporary buffer and is unavailable. Restore storage before restarting voice."});
      return false;
    }
    return true;
  }
  function retainRecognition(event: Extract<ConversationWireEvent, { kind: "input_fragment" | "unassigned_input_fragment" }>, unsaved: boolean = false) {
    const s = state.getState(), p = scope()!;
    const fragment: ConversationRecognition = { ...event, sessionId: s.sessionId, conversationId: p.conversationId,
      epoch: p.epoch, providerId: p.providerId, activation: entryLifetime, ...(unsaved ? {unsaved:true as const} : {}), contextual: p.capabilities.contextualTasks === "supported" };
    const key = recognitionIdentity(fragment);
    if (event.kind === "unassigned_input_fragment") {
      if (event.sequence <= unassignedThrough) return false;
      unassignedThrough = event.sequence;
    } else {
      if (seenRecognition.has(key)) return false;
      seenRecognition.add(key);
    }
    if (unsaved && !retainUnsaved(event.text)) return false;
    const recognition = [...s.recognition, fragment];
    let normal = recognition.filter(f=>!f.unsaved);
    let chars = normal.reduce((n, f) => n + f.text.length, 0);
    const allowance = event.kind === "unassigned_input_fragment" && !fragment.contextual ? 1 : 0;
    while (normal.length > CONVERSATION_LIMITS.maxFragmentsPerUtterance + allowance
      || chars > CONVERSATION_LIMITS.maxUtteranceChars + allowance * CONVERSATION_LIMITS.maxFragmentChars) {
      const removed = normal.shift()!; chars -= removed.text.length;
      recognition.splice(recognition.indexOf(removed),1);
    }
    state.setState({ recognition });
    return true;
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
  function updateOutput(epoch: number, outputId: string, patch: Partial<ConversationClientOutput>, restored = false) {
    const s = state.getState();
    const p = scope();
    if (!p) return;
    const old = s.outputs.find((output) => output.conversationId === p.conversationId && output.epoch === epoch && output.outputId === outputId);
    const next: ConversationClientOutput = { providerId: p.providerId, conversationId: p.conversationId, epoch, outputId, sessionId: s.sessionId, generated: "", playback: "unknown", ...old, ...patch };
    if (restored && !old || old && restoredOutputs.has(old)) restoredOutputs.add(next);
    const outputs = old ? s.outputs.map((output) => output === old ? next : output) : [...s.outputs, next];
    while (outputs.filter(o=>!o.unsavedGenerated).length > 128) outputs.splice(outputs.findIndex(o=>!o.unsavedGenerated),1);
    state.setState({ outputs });
  }
  function disclosureKey(profile: ConversationProfile, effectiveId = scope()?.agentProviderId ?? entryProfileId) {
    // Compare the effective profile disclosed at entry, not a later picker pin
    // from automatic task/session adoption. Same-ID metadata changes and removal
    // still invalidate consent. Sort fields so roster serialization order does not.
    const entryProfile = root.stores.provider.getState().available.find(p => p.id === effectiveId);
    return JSON.stringify([profile.providerId, Object.entries(profile.capabilities).sort(([a],[b])=>a.localeCompare(b)), profile.disclosure, root.apiBase(), entryProfileId, effectiveId,
      entryProfile ? Object.entries(entryProfile).sort(([a], [b]) => a.localeCompare(b)) : null]);
  }
  function requireCurrentDisclosure() {
    const profile = state.getState().conversationProfile;
    if (!state.getState().active || !profile || agreedDisclosure === undefined || agreedDisclosure === disclosureKey(profile)) return false;
    consent = false; agreedEntry = undefined; entryLifetime++;
    const changedEngine=scope()?.providerId !== profile.providerId;
    pause(false,true);
    if(changedEngine) state.setState({profile:null});
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
    if (!draftId || reviewIsIncomplete()) return;
    // Interim recognition is never retained. Unknown finality is the explicit
    // manual-review candidate, as required by the GPT-Live profile.
    const text = [...fragments.values()].flatMap((items) => [...items.values()].filter((f) => f.finalization !== "interim").sort((a, b) => a.sequence - b.sequence).map((f) => f.text)).join(" ").trim();
    const drafts = root.stores.drafts.getState();
    const id = drafts.resolveId(draftId);
    const old = drafts.drafts[id]?.text ?? "";
    const prefix = savedVoice && old.endsWith(savedVoice) ? old.slice(0, -savedVoice.length).trimEnd() : old;
    const next = [prefix, text].filter(Boolean).join("\n\n");
    if (next !== old) drafts.edit(id, state.getState().sessionId, { text: next });
    const retained = root.stores.drafts.getState().drafts[id];
    state.setState({ voiceDraft: text && retained ? { id, edit: retained.edit } : null });
    savedVoice = text;
  }
  function removeSavedDraft() {
    if (!draftId || !savedVoice) return;
    const drafts = root.stores.drafts.getState();
    const id = drafts.resolveId(draftId);
    const old = drafts.drafts[id]?.text ?? "";
    if (old.endsWith(savedVoice)) drafts.edit(id, state.getState().sessionId, { text: old.slice(0, -savedVoice.length).trimEnd() });
    savedVoice = "";
    state.setState({ voiceDraft: null });
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
  function dialogueDiagnostic(code: "DIALOGUE_UNAVAILABLE" | "DIALOGUE_STORAGE" | "DIALOGUE_PENDING_PRESSURE") {
    const notices = {
      DIALOGUE_UNAVAILABLE: "Conversation history unavailable. Try opening this chat again.",
      // A failed journal write does not prove loss of a complete native answer.
      DIALOGUE_STORAGE: "Conversation history writes failed. Restore storage before restarting voice.",
      DIALOGUE_PENDING_PRESSURE: "Conversation text is arriving faster than it can be saved. Voice capture stopped at the pending-write limit. Any unsaved text is unavailable after reload. Let pending writes finish and check storage before restarting voice.",
    };
    return notices[code];
  }
  function closeDiagnostic(reason: ServerConversationClosed["reason"], closed: Pick<ServerConversationClosed,"conversationId"|"epoch">) {
    if(storageFailureCode && storageFailedScope===JSON.stringify([closed.conversationId,closed.epoch])) return dialogueDiagnostic(storageFailureCode);
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
    const leaving = scope();
    const retainedOwner = leaving?.historyOwnerId;
    entryLifetime++; agreedEntry = undefined; agreedDisclosure = undefined;
    pause(false, false);
    fragments.clear(); lastInput = undefined; utterance = null;
    state.setState(s => ({ active: false, text: "", disclosureOpen: false, recognition: s.recognition.filter(f => f.unsaved || f.finalization !== "interim") }));
    if (root.stores.voice.getState().mode === "conversation") root.stores.voice.getState().setMode("idle");
    if (retainedOwner && !state.getState().sessionId) {
      const key = `dialogue:${retainedOwner}`;
      root.stores.chat.getState().setHistoryOwner(key, retainedOwner);
      // This is the existing host-only UI target, never a backend session.
      // Move this source's volatile evidence with its owner before selection;
      // a later missing-native-history error must not orphan its unsaved tail.
      state.setState(current=>({sessionId:key,
        recognition:current.recognition.map(f=>f.sessionId===null && f.conversationId===leaving?.conversationId ? {...f,sessionId:key} : f),
        outputs:current.outputs.map(o=>o.sessionId===null && o.conversationId===leaving?.conversationId ? outputInSession(o,key) : o),
        unassigned:current.unassigned.map(f=>f.sessionId===null && f.conversationId===leaving?.conversationId ? {...f,sessionId:key} : f),
      }));
      root.stores.chat.getState().setActiveSession(key);
    }
  }
  function startEpoch() {
    if (disposed || !state.getState().active || requested || openingId || (typeof document !== "undefined" && document.hidden) || root.stores.connection.getState().wsStatus !== "connected") return;
    const advertised = state.getState().conversationProfile;
    if (!advertised || agreedEntry !== entryLifetime || agreedDisclosure === undefined) return;
    if (requireCurrentDisclosure()) return;
    clearClosedNotice();
    requested = true; ready = false; resync = 0; generation++; state.setState({ token: generation });
    sequence = 0; utterance = null; ended = false; clearTimers(); resetRecovery();
    const s = state.getState();
    openingId = crypto.randomUUID(); openingEntry = entryLifetime;
    send({ type: "conversation_start", disclosed: advertised, contextualTasks: true, requestId: openingId, ...((!s.sessionId || historyOwnerFor(s.sessionId)) && s.agentProviderId ? { agentProviderId: s.agentProviderId } : {}), ...(s.profile ? { conversationId: s.profile.conversationId } : {}), ...(s.sessionId && historyOwnerFor(s.sessionId) ? {historyOwnerId:historyOwnerFor(s.sessionId)} : s.sessionId ? { sessionId: s.sessionId } : {}) });
  }
  async function capture() {
    const profile = scope();
    if (requireCurrentDisclosure()) return;
    if (!state.getState().active || !consent || !profile || mic || (typeof document !== "undefined" && document.hidden)) return;
    const reason = storageFailedScope === liveScopeKey() ? dialogueDiagnostic(storageFailureCode ?? "DIALOGUE_STORAGE")
      : state.getState().disclosureOpen ? "Review the voice service disclosure. Microphone off."
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
    if (reviewIsIncomplete()) {
      state.setState({notice:"Only bounded recognition context remains. Review retained dialogue and send typed text instead."}); return false;
    }
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
      || s.sessionId !== null && !historyOwnerFor(s.sessionId) || root.stores.chat.getState().activeSessionId !== s.sessionId) return;
    const provisionalKey = s.sessionId;
    const priorPage = provisionalKey ? s.dialogue[provisionalKey] : undefined;
    state.setState({ sessionId, ...(priorPage ? {dialogue:{...Object.fromEntries(Object.entries(s.dialogue).filter(([key])=>key!==provisionalKey)),[sessionId]:{...priorPage,sessionId}}} : {}),
      recognition: s.recognition.map(f => f.conversationId === work.conversationId && f.sessionId === null ? { ...f, sessionId } : f),
      outputs: s.outputs.map(o => o.conversationId === work.conversationId && o.sessionId === null ? outputInSession(o, sessionId) : o),
      unassigned: s.unassigned.map(f => f.conversationId === work.conversationId && f.sessionId === null ? { ...f, sessionId } : f),
    });
    // This task has no reviewed composer draft. Materialize its own buffer so
    // ordinary session_info routing cannot adopt the independent typed draft.
    root.stores.chat.getState().setActiveSession(sessionId);
  }
  /** Principal/auth boundaries drop all volatile evidence and old callback identities. */
  function clearPrivateDialogue() {
    entryLifetime++; generation++; consent=false; ready=false; requested=false; openingId=undefined;
    // Retire the source before cutting playback: no old identity is sent on a new principal socket.
    state.setState({active:false,profile:null});
    clearTimers(); resetRecovery(); stopMic(); playback.cut();
    unsavedOverflow=false; storageFailedScope=undefined; storageFailureCode=undefined; dialogueReads.clear();
    requests.clear(); restoredRequests.clear(); agreedDisclosure=undefined; agreedEntry=undefined;
    permissions.clear(); localTones.clear(); fragments.clear(); capturedInputs.clear(); retiredInputs.clear();
    manualReview.clear(); incompleteReview.clear(); unassignedThrough=-1; seenRecognition.clear();
    lastInput=undefined; utterance=null; draftId=null; savedVoice="";
    state.setState({active:false,token:generation,profile:null,conversationProfile:null,voiceDraft:null,dialogue:{},dialogueRestoredThrough:{},dialogueNotice:"",work:{},outputs:[],unassigned:[],recognition:[],unassignedWork:0,available:false});
    if (root.stores.voice.getState().mode === "conversation") root.stores.voice.getState().setMode("idle");
  }
  let inputFormat: Extract<ConversationWireEvent, { kind: "ready" }>["input"] | undefined;
  function frame(message: ServerMessage): ServerMessage | null {
    // Preserve only exact fixed admission copy; request identity does not make diagnostics safe.
    if (message.type === "error" && message.code === "SESSION_LOAD_ERROR" && ![
      "The host cannot verify this conversation. No work was started; your draft is kept.",
      "The host could not verify this conversation. No work was started; your draft is kept.",
      "The host could not load this conversation. No work was started; your draft is kept.",
    ].includes(message.message)) message = { ...message, message: "Unable to load conversation history. Try again; your draft is kept." };
    permissions.frame(message);
    if (message.type === "server_hello") {
      if(dialoguePrincipalKey !== undefined && dialoguePrincipalKey !== message.principalKey) clearPrivateDialogue();
      dialoguePrincipalKey=message.principalKey;
      durableAvailable = message.capabilities?.sessionDialogue === true;
      state.setState({durableAvailable});
    }
    if (message.type === "session_info") loadDialogue(message.sessionId);
    if (message.type === "dialogue_history") {
      const read = message.requestId ? dialogueReads.get(message.requestId) : undefined;
      if (message.requestId && !read) return null;
      if (message.requestId) dialogueReads.delete(message.requestId);
      const key = message.sessionId ?? read?.key ?? `dialogue:${message.ownerId}`;
      if(!message.sessionId) root.stores.chat.getState().setHistoryOwner(key,message.ownerId);
      const selected=root.stores.chat.getState().activeSessionId;
      if(message.sessionId && selected && historyOwnerFor(selected) && state.getState().dialogue[selected]?.ownerId === message.ownerId){
        const oldBuffer=root.stores.chat.getState().buffers[selected];
        if(state.getState().sessionId===selected) state.setState({sessionId:message.sessionId});
        if(oldBuffer)root.stores.chat.getState().setMessages(message.sessionId,oldBuffer.messages);
        root.stores.chat.getState().setActiveSession(message.sessionId);
      }

      if (read && read.key !== key && !historyOwnerFor(read.key)) return null;
      if(read && historyOwnerFor(read.key) && message.sessionId && selected === read.key){
        root.stores.chat.getState().setActiveSession(message.sessionId);
        send({type:"session_resume",sessionId:message.sessionId});
      }
      if (read && historyOwnerFor(read.key) && !message.sessionId) {
        root.stores.chat.getState().setMessages(read.key, []);
        root.stores.chat.getState().noteHistoryLoaded(read.key);
        // There is deliberately no backend transcript or synthetic turn.
      }
      let refreshCursor=false;
      state.setState(current => {
        const old = current.dialogue[key] ?? Object.values(current.dialogue).find(p=>p.ownerId===message.ownerId);
        if (old && old.generation !== message.generation && !read) return current;
        const merged = new Map<number, DialogueRecord>();
        // A new snapshot replaces old pages, retaining a live tail above H.
        if (old && old.generation === message.generation) for (const r of old.records) if (!read || read.older || r.sequence > message.through) merged.set(r.sequence, r);
        for (const r of message.records) merged.set(r.sequence, r);
        let records = [...merged.values()].sort((a,b) => a.sequence-b.sequence);
        const overflow = records.length > 2000;
        if(overflow && !read) refreshCursor=true;
        if (overflow) records = read?.older ? records.slice(0,2000) : records.slice(-2000);
        const page = {...message, through: Math.max(old?.generation === message.generation ? old.through : 0,message.through), records,
          before: read ? message.before : old?.before, cursor:read ? message.cursor : old?.cursor,
          ...(overflow && !read?.older ? {before:message.before ?? old?.before} : {})};
        const entries = Object.entries({...current.dialogue,[key]:page}).filter(([k,p])=>k===key || (k!==read?.key && p.ownerId!==message.ownerId)).slice(-8);
        return {dialogue: Object.fromEntries(entries), dialogueRestoredThrough: Object.fromEntries(entries.map(([k])=>[k,k===key && read ? message.through : current.dialogueRestoredThrough[k] ?? -1])), dialogueNotice: unsavedOverflow ? current.dialogueNotice : message.coverage === "partial" ? "Voice history may be incomplete." : ""};
      });
      if(refreshCursor) queueMicrotask(()=>loadDialogue(key));
      return null;
    }
    if (message.type === "error" && message.requestId && dialogueReads.has(message.requestId)
      && (message.code === "SESSION_NOT_FOUND" || message.code === "SESSION_LOAD_ERROR")) {
      const read = dialogueReads.get(message.requestId)!;
      dialogueReads.delete(message.requestId);
      state.setState(current => ({
        dialogue: Object.fromEntries(Object.entries(current.dialogue).filter(([key]) => key !== read.key)),
        dialogueRestoredThrough: Object.fromEntries(Object.entries(current.dialogueRestoredThrough).filter(([key]) => key !== read.key)),
      }));
      // This is a failed read, not a task or provider-opening rejection. The
      // ordinary restoration path owns its readable failure and keeps drafts.
      return { ...message, requestId: undefined };
    }
    if (message.type === "error" && (message.code === "DIALOGUE_UNAVAILABLE" || message.code === "DIALOGUE_STORAGE" || message.code === "DIALOGUE_PENDING_PRESSURE")) {
      if (message.requestId) dialogueReads.delete(message.requestId);
      if ((message.code === "DIALOGUE_STORAGE" || message.code === "DIALOGUE_PENDING_PRESSURE") && state.getState().active && (message.historyOwnerId ? message.historyOwnerId === scope()?.historyOwnerId : !message.sessionId || message.sessionId === state.getState().sessionId)) {
        // Stop new capture/automation, not the already observed current-epoch tail.
        // The host closes the epoch after these callbacks drain. Ready and all
        // identity/disclosure fences remain intact until that ordinary close.
        stopForStorageFailure(message.code);
      }
      if (!unsavedOverflow) state.setState({dialogueNotice: dialogueDiagnostic(message.code)}); return null;
    }
    if (message.type === "server_hello") {
      const profile = message.conversationProfile ?? null;
      state.setState({ conversationProfile: profile, available: !!profile && message.capabilities?.liveConversation === true && message.capabilities?.conversationPause === true });
      if (state.getState().active) {
        if (profile && !requireCurrentDisclosure()) startEpoch();
        else if (!profile) { agreedEntry=undefined; entryLifetime++; pause(false,true); state.setState({disclosureOpen:true,notice:"Voice is unavailable until this host supplies its disclosure."}); }
      }
    }
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
        state.setState({ sessionId: message.sessionId, recognition: state.getState().recognition.map(f => f.conversationId === request.conversationId && f.sessionId === null ? { ...f, sessionId: message.sessionId } : f), outputs: state.getState().outputs.map((output) => output.conversationId === request.conversationId && output.sessionId === null ? outputInSession(output, message.sessionId) : output) });
      }
      return request.draftCorrelation ? { ...message, draftId: request.draftCorrelation } : message;
    }
    const openingRejected = message.type === "error" && !!openingId && message.requestId === openingId
      && !message.turnId && !message.failure
      && (message.code === "SESSION_NOT_FOUND" || message.code === "SESSION_LOAD_ERROR" || message.code.startsWith("CONVERSATION_"));
    if (openingRejected && (!state.getState().active || openingEntry !== entryLifetime)) {
      // Settle the request that owns this rejection even after selection/entry
      // changed. It never opened a provider and cannot retire the new entry.
      openingId = undefined; requested = false;
      if (state.getState().active) queueMicrotask(startEpoch);
      return null;
    }
    if (message.type === "error" && (!message.requestId || message.requestId === openingId) && !message.turnId && !message.failure
      && (message.code === "SESSION_NOT_FOUND" || (message.code === "SESSION_LOAD_ERROR" && openingId !== undefined))
      && message.sessionId === state.getState().sessionId) {
      // A history read and provider opening can overlap. Only the opening's
      // own rejection consumes its request; otherwise keep the token so a late
      // provider response is stopped by the retired-entry path below.
      if (openingRejected) openingId = undefined;
      leave(); state.setState({ profile: null, notice: message.message });
      // Opening correlation is not a backend task request. Let ordinary chat
      // restoration handle the selected chat failure after consuming it here.
      return openingRejected ? { ...message, requestId: undefined } : message;
    }
    if (message.type === "error" && message.code.startsWith("CONVERSATION_")) {
      if (message.requestId && message.requestId !== openingId) return null;
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
      if (message.type === "conversation_closed") { closedNotice = closeDiagnostic(message.reason,message); send({ type: "conversation_stop", conversationId: message.conversationId }); pause(true, true, false); return null; }
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
      generation++; state.setState({ token: generation }); stopMic(); resetRecovery(); playback.dispose(); playback = makePlayback(); fragments.clear(); unassignedThrough = -1; seenRecognition.clear(); retiredInputs.clear(); capturedInputs.clear(); manualReview.clear(); incompleteReview.clear(); lastInput = undefined;
      state.setState({ profile: message, connection: "Connected", text: "", interaction: "Listening", disclosureOpen: agreedEntry !== entryLifetime || agreedDisclosure !== disclosureKey(message, message.agentProviderId ?? entryProfileId) });
      if (agreedEntry !== entryLifetime || agreedDisclosure !== disclosureKey(message, message.agentProviderId ?? entryProfileId)) consent = false;
      resync = message.resync.work + message.resync.outputs;
      ready = false; if (consent) void capture();
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
        closedNotice = closeDiagnostic(message.reason,message); suspend(); startEpoch();
      } else { closedNotice = closeDiagnostic(message.reason,message); pause(true); }
      return null;
    }
    if (message.type !== "conversation_event") return null;
    const event = message.event;
    if (event.kind === "ready") { inputFormat = event.input; ready = true; refresh(); if (consent) void capture(); return null; }
    if (!ready) return null;
    if (message.retention === "unsaved") {
      stopForStorageFailure();
      if (event.kind === "unassigned_input_fragment") retainRecognition(event,true);
      else if (event.kind === "input_fragment" && capturedInputs.has(event.utteranceId) && !retiredInputs.has(event.utteranceId)) retainRecognition(event,true);
      else if (event.kind === "output_transcript" && retainUnsaved(event.text)) {
        const old = state.getState().outputs.find(o=>o.conversationId===p.conversationId && o.epoch===p.epoch && o.outputId===event.outputId);
        updateOutput(p.epoch,event.outputId,{unsavedGenerated:(old?.unsavedGenerated ?? "")+event.text,unsavedFragments:(old?.unsavedFragments ?? 0)+1});
      }
      // Historical failure evidence never enters review, permissions, tasks or playback.
      return null;
    }
    if (storageFailedScope === liveScopeKey()) return null;
    if (event.kind === "unassigned_input_fragment") {
      if (!retainRecognition(event)) return null;
      const retained = state.getState().unassigned;
      if (retained.some(f => f.conversationId === p.conversationId && f.epoch === p.epoch && !f.utteranceId && f.sequence === event.sequence)) return null;
      // Review context is separate from exact archived recognition. Never merge
      // approximate session intervals into captured utterances.
      const unassigned = [...retained, { sessionId: s.sessionId, conversationId: p.conversationId, epoch: p.epoch, taskContext: p.capabilities.contextualTasks === "supported", ...event }];
      if (p.capabilities.contextualTasks === "supported") { retainContext(unassigned.at(-1)!); return null; }
      let reviewChars=unassigned.reduce((n,f)=>n+f.text.length,0), trimmed=false;
      while (unassigned.length > CONVERSATION_LIMITS.maxFragmentsPerUtterance || reviewChars > CONVERSATION_LIMITS.maxUtteranceChars) {
        reviewChars-=unassigned.shift()!.text.length; trimmed=true;
      }
      state.setState({unassigned,...(trimmed ? {notice:"Only recent recognition remains in the review buffer. Review retained dialogue before sending typed text."} : {})});
      return null;
    }
    if (event.kind === "unassigned_delegation") {
      state.setState({ unassignedWork: state.getState().unassignedWork + 1 }); return null;
    }
    if (event.kind === "input_fragment") {
      if (!capturedInputs.has(event.utteranceId) || retiredInputs.has(event.utteranceId)) return null;
      // Display deduplication must not intercept the existing permission or
      // manual-review path, including its attribution/finality validation.
      const newRecognition = retainRecognition(event);
      if (permissions.input(event)) {
        retiredInputs.add(event.utteranceId); fragments.delete(event.utteranceId); lastInput = undefined;
        state.setState({ text: [...fragments.values()].flatMap(items => [...items.values()].map(f => f.text)).join(" ").trim() });
        saveDraft(); refresh(); return null;
      }
      if (p.capabilities.contextualTasks === "supported") {
        if (!newRecognition) return null;
        // Bounded ephemeral context, never a manual-review draft or grant.
        retainContext({ sessionId: s.sessionId, conversationId: p.conversationId, epoch: p.epoch, taskContext: true, utteranceId: event.utteranceId, sequence: event.sequence, text: event.text, timing: { kind: "unavailable" }, finalization: event.finalization === "final" ? "final" : "unknown" });
        return null;
      }
      const items = fragments.get(event.utteranceId) ?? new Map();
      if (event.certainty !== "known" || event.origin !== "user" || (event.confidence ?? 0) < 0.9) manualReview.add(event.utteranceId);
      finalAfterSpeech = event.finalization === "final";
      items.set(event.sequence, event); fragments.set(event.utteranceId, items); lastInput = event;
      let reviewChars=[...fragments.values()].reduce((n,f)=>n+[...f.values()].reduce((sum,item)=>sum+item.text.length+1,0),0);
      while (items.size > CONVERSATION_LIMITS.maxFragmentsPerUtterance || reviewChars > p.limits.maxCommitChars) {
        const oldest=Math.min(...items.keys()); const removed=items.get(oldest);
        if (!removed) break;
        reviewChars-=removed.text.length+1; items.delete(oldest);
        incompleteReview.add(event.utteranceId); manualReview.add(event.utteranceId);
      }
      const text = [...fragments.values()].flatMap((f) => [...f.values()].sort((a, b) => a.sequence - b.sequence).map((f) => f.text)).join(" ").trim();
      state.setState({ text, notice: event.certainty === "unknown" || event.origin !== "user" ? "I couldn't hear that clearly. Review before sending." : s.notice });
      if (reviewIsIncomplete()) {
        removeSavedDraft(); clearTimeout(hold); hold=undefined;
        state.setState({notice:"Only bounded recognition context remains. Review retained dialogue and send typed text instead."});
        refresh(); return null;
      }
      saveDraft();
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
    if(next.wsStatus !== previous.wsStatus && next.wsStatus !== "connected") {dialogueReads.clear(); state.setState({conversationProfile:null,available:false});}
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
  const unwatchAuth = root.authLock.registerStop(async () => { leave(); clearPrivateDialogue(); });
  return {
    loadDialogue, historyOwnerFor,
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
      if (disposed || !state.getState().available || state.getState().active || root.stores.voice.getState().mode !== "idle" || root.stores.voice.getState().local !== "idle") return;
      const sessionId = root.stores.chat.getState().activeSessionId;
      if (state.getState().unassigned.some(f => !f.taskContext && f.sessionId !== sessionId)) { state.setState({ notice: "Return to the previous chat to review its recognized speech." }); return; }
      draftId = root.stores.drafts.getState().idFor(sessionId); savedVoice = "";
      const providers = root.stores.provider.getState();
      const agentProviderId = providers.available.some((provider) => provider.id === providers.selectedId) ? providers.selectedId : null;
      entryLifetime++;
      entryProfileId = providers.pinnedId ?? agentProviderId;
      state.setState({ active: true, sessionId, agentProviderId, recognition: state.getState().recognition.filter(f => !f.contextual || f.sessionId === sessionId), unassigned: state.getState().unassigned.filter(f => !f.taskContext || f.sessionId === sessionId), profile: null, work: {}, connection: "Connecting", disclosureOpen: true, text: "", notice: "", interaction: "Listening" });
      // A new entry needs Start even when the service matches the last visit.
      agreedDisclosure = undefined;
      root.stores.voice.getState().setMode("conversation");
      agreedEntry = undefined; consent = false; permissions.refresh();
    },
    start() {
      const profile = state.getState().conversationProfile;
      if (!state.getState().active || !profile || (typeof document !== "undefined" && document.hidden) || root.stores.connection.getState().wsStatus !== "connected") return;
      agreedDisclosure = disclosureKey(profile); agreedEntry = entryLifetime; consent = true;
      state.setState({ disclosureOpen: false }); startEpoch(); void capture();
    },
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
      state.setState({ unassigned: s.unassigned.filter(f => !selected.includes(f)), recognition: state.getState().recognition.map(f => selected.some(r => r.conversationId === f.conversationId && r.epoch === f.epoch && r.sequence === f.sequence && (f.kind === "input_fragment" ? r.utteranceId === f.utteranceId : !r.utteranceId)) ? { ...f, text: "", moved: true as const } : f), unassignedWork: 0 });
      return true;
    },
    discard() {
      if (ready && mic) endpoint(generation);
      clearTimers();
      // Replay retirement spans the epoch; deletion owns only this draft.
      // Earlier submitted/consumed input must keep its retained display evidence.
      const discardedInputs = new Set(fragments.keys());
      for (const id of discardedInputs) retiredInputs.add(id);
      removeSavedDraft(); fragments.clear(); lastInput = undefined;
      state.setState(s => ({ text: "", recognition: s.recognition.filter(f => f.kind !== "input_fragment" || !discardedInputs.has(f.utteranceId)) }));
      refresh();
    },
    stopReply, leave,
    dispose() { leave(); disposed = true; unwatchChat(); unwatchProvider(); unwatchConnection(); unwatchAuth(); playback.dispose(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden); requests.clear(); },
  };
}
