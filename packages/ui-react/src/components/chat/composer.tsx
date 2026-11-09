import { useStore } from "zustand";
import { ConversationUnassigned } from "../voice/conversation-unassigned.js";
import { ConversationStrip } from "../voice/conversation-strip.js";
import { Button, Callout, InlineToast, VoiceNotice } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useState, useRef, useEffect, useLayoutEffect, useImperativeHandle, useReducer, type Ref } from "react";
import { resolveThinkingLevel } from "@schlessera/brain-ui-sdk/internal/client";
import { SHARE_MAX_FILES, SHARE_MAX_TOTAL_BYTES, type ClientMessage, type ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore, activeChat, restorationOf } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { deriveConnectionIssue } from "../../lib/connection-issue.js";
import { useProviderStore } from "../../stores/provider-store.js";
import {
  fileToAttachment,
  validateAttachments,
  type PendingAttachment,
} from "../../lib/image-attachments.js";
import { ShareIntake } from "./share-card.js";
import { CommandPalette, exactCommand, matchCommands } from "./command-palette.js";
import { ComposerView } from "./composer-view.js";
import { ComposerMic } from "./composer-mic.js";
import { RecordingsTray } from "../voice/recordings-tray.js";
import { LocalRecordingSheet } from "../voice/local-recording-sheet.js";
import { DictationCapture, DictationNotices, useDictationCapturing } from "../voice/dictation-field.js";
import { useDictation } from "../../voice/use-dictation.js";
import { dictationTarget, loadDiscovery, providerShortLabel } from "../../voice/dictation-providers.js";
import { useLocalCapture, useLocalCaptureSupport } from "../../voice/use-local-capture.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { detectClientEnvironment } from "../../lib/client-environment.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { useChatCommands } from "./use-chat-commands.js";
import { takeComposerTextAsAnswer } from "./ask-user-typed.js";
import { trackPending, trackReady } from "../../lib/track-uploads.js";
import { trackKey, tracksFor } from "../../lib/draft-tracks.js";
import { filesFor } from "../../lib/draft-files.js";
import { queuedBlocking, queuedPending } from "../../lib/attachment-queue.js";
import { bindableFiles, draftFiles as draftFilesOf, draftSnapshots, type ComposerSnapshot, type DraftFile } from "../../stores/draft-state.js";
import { focusOldestSnapshot } from "./outgoing-snapshots.js";
import { insertSuggestion } from "../../lib/answer-suggestions.js";
import { HANDOFF_ENTRY_LABEL, useHandoffEntry } from "../../hooks/use-handoff-entry.js";
import { DraftIndicator } from "./draft-indicator.js";
import { WorkerHostNotice } from "./worker-host-notice.js";
import { useSessionProfile } from "../../hooks/use-session-profile.js";
import { useLocalWorkStatus, useWorkRestore } from "../../hooks/use-local-work.js";

/** The hint when the work context could not be written to this device (#1014). */
const LOCAL_SAVE_FAILED = "Couldn't save your draft on this device.";

/**
 * The composer — everything below the transcript: draft text, attachments,
 * voice review, provider picker, send/cancel.
 *
 * It is its own component for one reason: it owns the draft, and the draft
 * changes on every keystroke. While this lived inside ChatPage, a character
 * typed re-rendered the entire transcript, so typing cost grew with the length
 * of the conversation. Keeping the state here bounds a keystroke to this
 * subtree. Nothing above it re-renders, whatever the transcript holds.
 *
 * The corollary is a rule for future edits: transcript-scale state does not
 * belong in this file, and draft state does not belong above it.
 *
 * This is the container (S7): every store read, the provider choice and the
 * voice review live here; `ComposerView` draws the field.
 *
 * **The draft is the session's, not the composer's (D52 §5, #951).** Text
 * and images live in the root's draft store under the view's draft id: the
 * session's own, or the new-chat view's fresh one. Switching sessions,
 * destinations and panels, and remounting this component, restore it by
 * that id; nothing typed here can appear in another session. The store is
 * not the transcript's, so a keystroke still re-renders only this subtree.
 * A send is a snapshot the store keeps apart from the draft: the field
 * empties at once, and only the host's answer for that request settles it.
 */
type DraftEffort = { key: string | null; level?: ThinkingLevel; requested?: ThinkingLevel };
/** The effort choice a send carried, consumed only once the host accepts it. */
type PendingSend = { requestId: string; key: string | null; effort: DraftEffort };

const NO_ATTACHMENTS: PendingAttachment[] = [];
const NO_FILES: DraftFile[] = [];

/** The reload notice (rev 5 §1): a fact about the binding, never about what the host stored. */
function uploadNoticeCopy(names: readonly string[]): string {
  if (names.length === 1) return `${names[0]} was still uploading when the page closed. It isn't attached. Choose it again to attach it.`;
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} were still uploading when the page closed. They aren't attached. Choose them again to attach them.`;
}

/**
 * What the chat page may ask of the composer without reaching into its DOM:
 * a press of Chat puts the caret at the end of the draft (D52 N3).
 */
export interface ComposerHandle {
  /** Focuses the field with the caret at the end; false when it cannot take focus. */
  focusEnd: () => boolean;
}

export function Composer({ send, handle }: { send: (msg: ClientMessage) => void | boolean; handle?: Ref<ComposerHandle> }) {
  const root = useBrainUiRoot();
  const conversation = useStore(root.connection.conversation.state);
  const finePointer = useFinePointer();
  const sessionId = useChatStore((s) => s.activeSessionId);
  // The selected session's history has not arrived (#1328): the draft stays
  // editable, and nothing is sent into a conversation the reader cannot see.
  const restorePhase = useChatStore((s) => restorationOf(s)?.phase ?? null);
  // The draft this view shows (D52 §5): its session's, or the new chat's.
  const draftId = useRootStore("drafts", (s) => s.idFor(sessionId));
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const input = draft?.text ?? "";
  const attachments = draft?.attachments ?? NO_ATTACHMENTS;
  const draftFiles = draft?.files ?? NO_FILES;
  // The draft's content is the revision the host acknowledged, file bindings included.
  const draftClean = !!draft && draft.host !== null && draft.host.edit === draft.edit && draft.conflict === null;
  const draftFailure = draft?.failure ?? null;
  // A Send whose snapshot the host has not acknowledged yet (#3155): a
  // refusal gives its text back to the field, so nothing typed meanwhile may
  // land there to be joined with it. The window is one save.
  const creatingSnapshot = draftSnapshots(draft).some((x) => !x.replaces && !draft?.host?.snapshots?.some((h) => h.snapshotId === x.snapshotId));
  /** Write the view's draft. A function reads the draft as it is now, not as rendered. */
  const setInput = (value: string | ((current: string) => string)) => {
    const store = root.stores.drafts.getState();
    const current = store.drafts[draftId]?.text ?? "";
    store.edit(draftId, sessionId, { text: typeof value === "function" ? value(current) : value });
  };
  // The work context kept on this device (#1014): where the caret was goes
  // into each snapshot, and a restore after reload puts it back once the
  // restored text is in the field.
  const localSaveFailed = useLocalWorkStatus((s) => s.failed);
  const restoreSelection = useWorkRestore((s) => s.selection);
  const restoreFocus = useWorkRestore((s) => s.focusId);
  // Files that were still uploading when the page closed (#3155, rev 5 §1).
  // A session's view matches by its session too: its draft id may be new after the reload.
  const closedUploadsFor = (u: { draftId: string; sessionId: string | null }) => u.draftId === draftId || (sessionId !== null && u.sessionId === sessionId);
  const closedUploads = useWorkRestore((s) => s.uploads?.find(closedUploadsFor)?.names ?? null);
  useEffect(() => root.localWork?.register(() => {
    const field = frameRef.current?.querySelector("textarea");
    return field ? { selectionStart: field.selectionStart, selectionEnd: field.selectionEnd } : {};
  }), [root]);
  useLayoutEffect(() => {
    const work = root.localWork;
    if (!work || !restoreSelection || restoreSelection.draftId !== draftId) return;
    const field = frameRef.current?.querySelector("textarea");
    if (!field || field.value !== input) return;
    const { start, end } = restoreSelection;
    if (end <= input.length && start <= end) {
      if (restoreFocus === "composer") field.focus({ preventScroll: true });
      field.setSelectionRange(start, end);
    }
    work.restore.setState({ selection: null, ...(restoreFocus === "composer" ? { focusId: null } : {}) });
  }, [root, restoreSelection, restoreFocus, draftId, input]);
  const [lastPrompt, setLastPrompt] = useState("");
  const [effort, setEffort] = useState<DraftEffort>({ key: null });
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  /** The kit owns the textarea; the frame finds it when a recall or a voice edit needs focus. */
  const focusField = () => frameRef.current?.querySelector("textarea")?.focus();
  useImperativeHandle(handle, () => ({
    focusEnd: () => {
      const field = frameRef.current?.querySelector("textarea");
      if (!field || field.disabled || field.getClientRects().length === 0) return false;
      field.focus({ preventScroll: true });
      if (document.activeElement !== field) return false;
      field.setSelectionRange(field.value.length, field.value.length);
      return true;
    },
  }), []);

  // Image attachments live in the draft; the store owns their preview URLs.
  // Async add/merge logic reads the draft's current set from the store, for
  // the draft that started it, so a session switch mid-decode cannot carry
  // an image into another session.
  const attachmentsOf = (id: string) => {
    const store = root.stores.drafts.getState();
    return store.drafts[store.resolveId(id)]?.attachments ?? NO_ATTACHMENTS;
  };
  const setAttachmentsOf = (id: string, owner: string | null, next: PendingAttachment[]) =>
    root.stores.drafts.getState().edit(id, owner, { attachments: next });
  const [attachErrors, setAttachErrors] = useState<string[]>([]);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const trackInputRef = useRef<HTMLInputElement>(null);
  const [, updateTrackView] = useReducer((n: number) => n + 1, 0);
  // A new chat's tracks follow its draft through rotations, by its first id.
  const trackOwner = useRootStore("drafts", (s) => s.originOf(draftId));
  const trackEntry = tracksFor(root, trackKey(sessionId, trackOwner));
  const trackUploads = trackEntry.uploads;
  useEffect(() => {
    trackEntry.listeners.add(updateTrackView);
    return () => { trackEntry.listeners.delete(updateTrackView); };
  }, [trackEntry]);
  const tracks = trackUploads.files;
  // Composer originals (#3155): offered only when the host keeps them.
  const fileLimits = useRootStore("drafts", (s) => s.fileLimits);
  const filesOn = fileLimits !== null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [, updateFileView] = useReducer((n: number) => n + 1, 0);
  const fileEntry = filesFor(root, trackKey(sessionId, trackOwner), sessionId);
  const fileQueue = fileEntry.queue;
  useEffect(() => {
    fileEntry.listeners.add(updateFileView);
    return () => { fileEntry.listeners.delete(updateFileView); };
  }, [fileEntry]);
  // A held snapshot's uploads are that message's (#3155): the composer neither shows nor waits for them.
  const queuedFiles = fileQueue.files.filter((item) => !item.snapshotId);
  // The host keeps outgoing snapshots: Send is one durable snapshot (rev 5 §2).
  const snapshotsOn = useRootStore("drafts", (s) => s.snapshotsOn);
  const outgoingFull = useRootStore("drafts", (s) => s.outgoingFull !== null && (s.outgoingFull.draftId === draftId || (sessionId !== null && s.outgoingFull.sessionId === sessionId)) ? s.outgoingFull : null);
  // Terminal transitions only, once each (§8.4): progress is never announced.
  const [fileAnnouncement, setFileAnnouncement] = useState("");
  const lastFileStates = useRef(new Map<string, string>());
  const lastStoredIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = lastFileStates.current;
    for (const item of queuedFiles) {
      if (before.get(item.id) === item.state) continue;
      if (item.state === "failed" || item.state === "refused") setFileAnnouncement(`${item.name}: ${item.status ?? "upload failed"}.`);
    }
    lastFileStates.current = new Map(queuedFiles.map((item) => [item.id, item.state] as const));
  }, [queuedFiles]);
  useEffect(() => { lastStoredIds.current = null; setFileAnnouncement(""); }, [draftId]);
  useEffect(() => {
    const ids = new Set(draftFiles.map((f) => f.file.fileId));
    // The first look at a draft (a switch, a restore) announces nothing.
    const before = lastStoredIds.current;
    lastStoredIds.current = ids;
    if (!before) return;
    const added = draftFiles.filter((f) => !before.has(f.file.fileId) && f.lineage === draftId);
    if (added.length) setFileAnnouncement(`${added.map((f) => f.file.incomingName || f.file.name).join(", ")} uploaded.`);
  }, [draftFiles, draftId]);
  // A send pressed while tracks upload is held for the draft it was pressed
  // in, by id: another draft opened meanwhile is never sent for it (#951).
  const [heldFor, setHeldFor] = useState<string | null>(null);
  const heldSend = heldFor !== null && heldFor === draftId;
  const setHeldSend = (held: boolean) => setHeldFor(held ? draftId : null);

  // Provider picker
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  // A conversation with a settled reply can be continued on another backend (#61).
  const hasSettledTurn = useChatStore((s) => activeChat(s).messages.some((m) => m.role === "assistant" && !m.isStreaming));
  const handoffEntry = useHandoffEntry(sessionId, hasSettledTurn);
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  // The browser's own word on the network, for the draft indicator's offline state (#3155).
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const changed = () => {
      setBrowserOnline(navigator.onLine !== false);
      const online = wsStatus === "connected" && navigator.onLine !== false;
      trackUploads.setOnline(online);
      fileQueue.setOnline(online);
    };
    changed();
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => { window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
  }, [wsStatus, trackUploads, fileQueue]);
  const profilesSupported = useConnectionStore(s => s.sessionProfiles);
  const profileEpoch = useConnectionStore(s => s.profileEpoch);
  const sessionProfile = useSessionProfile(sessionId, draftId, wsStatus === "connected", isStreaming, profilesSupported, profileEpoch);
  const chatRequestAck = useConnectionStore((s) => s.chatRequestAck);
  const followUpQueue = useConnectionStore((s) => s.followUpQueue);
  const vpnStatus = useConnectionStore((s) => s.vpnStatus);
  const handshakeFailures = useConnectionStore((s) => s.handshakeFailures);
  const lastCloseCode = useConnectionStore((s) => s.lastCloseCode);
  const connectionIssue = deriveConnectionIssue({
    vpnStatus,
    handshakeFailures,
    lastCloseCode,
  });

  const providers = useProviderStore((s) => s.available);
  const selectedProviderId = useProviderStore((s) => s.selectedId);
  const pinnedProviderId = useProviderStore((s) => s.pinnedId);
  const setSelectedProvider = useProviderStore((s) => s.setSelected);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const backends = useProviderStore((s) => s.backends);
  // Followed by the id it was first sent under: Send again re-keys it.
  const sendState = useRootStore("drafts", (s) => pendingSend ? Object.values(s.sends).find((x) => (x.origin ?? x.requestId) === pendingSend.requestId) : undefined);
  // A send of this view still unanswered: another would start a second
  // conversation, or repeat this one, so it waits (#942).
  // A new chat's first message held for review waits too: another send
  // from the same new chat could start a second conversation beside it.
  const waiting = useRootStore("drafts", (s) => Object.values(s.sends).some((x) => x.sessionId === sessionId
    && (x.state === "pending" || (sessionId === null && x.state === "unconfirmed"))
    && (sessionId !== null || s.sendDraftId(x.requestId) === draftId)));
  useEffect(() => {
    // Naming our accepted new conversation is not a conversation switch.
    // Carry a newer choice to its identity; consume only the sent choice.
    const namedDraft = pendingSend?.key === null && sendState?.state === "accepted" && sendState.acceptedSessionId === sessionId;
    setEffort((current) => namedDraft && current !== pendingSend.effort ? { ...current, key: sessionId } : { key: sessionId });
    setEffortNotice("");
    setHeldSend(false);
    // Settled sends consume a choice below; this runs only when identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  // Another draft in view (a Draft entry, or a send's content moved to a new
  // id): its errors are not this one's. Effort follows the session, not the id.
  // A send held for its tracks belongs to the draft it was pressed in.
  useEffect(() => { setAttachErrors([]); }, [draftId]);
  const draftStore = root.stores.drafts;
  useEffect(() => {
    if (!pendingSend) return;
    // A snapshot still held, or not yet sent: the choice waits with it.
    if (!sendState && Object.values(draftStore.getState().drafts).some((d) => draftSnapshots(d).some((x) => x.requestId === pendingSend.requestId && x.state !== "returned"))) return;
    // Taken back by Edit: nothing was sent, so nothing is consumed.
    if (!sendState) { setPendingSend(null); return; }
    // Still waiting, or held for review: the choice stays until the host answers.
    if (sendState.state === "pending" || sendState.state === "unconfirmed") return;
    const visible = sessionId === pendingSend.key || (pendingSend.key === null && sessionId === sendState.acceptedSessionId);
    if (sendState.state === "accepted" && visible) {
      setEffortNotice("");
      setEffort((current) => current === pendingSend.effort ? { key: sessionId } : current);
    }
    setPendingSend(null);
  }, [sendState, pendingSend, sessionId, draftStore]);

  const voiceDraft = useStore(root.connection.conversation.state, s => s.voiceDraft);
  const knownVoiceDraft = useStore(root.stores.drafts, s => {
    if (!voiceDraft) return false;
    const id = s.resolveId(voiceDraft.id);
    const draft = s.drafts[id];
    return id === draftId && !!draft?.text && draft.edit === voiceDraft.edit;
  });

  // Voice dictation state
  const voiceMode = useVoiceStore((s) => s.mode);
  const reviewText = useVoiceStore((s) => s.reviewText);
  const clearReview = useVoiceStore((s) => s.clearReview);
  const dictation = useDictation();
  // Dc, D2 and D3–D5: the voice field stands in for the composer (#3694).
  const capturing = useDictationCapturing();
  // D6 (#3694): what a take heard joins the draft as plain editable text,
  // caret at the end. The draft this happened to is remembered, so its send
  // still reads as dictated and its mic says "Dictate more".
  const [dictatedDraft, setDictatedDraft] = useState<string | null>(null);
  const dictated = dictatedDraft === draftId && input.trim() !== "";
  useLayoutEffect(() => {
    if (!reviewText) return;
    const heard = reviewText.trim();
    root.stores.voice.getState().setReviewText("");
    if (!heard) return;
    const drafts = root.stores.drafts.getState();
    const current = drafts.drafts[draftId]?.text ?? "";
    drafts.edit(draftId, sessionId, { text: current === "" ? heard : /\s$/.test(current) ? `${current}${heard}` : `${current} ${heard}` });
    setDictatedDraft(draftId);
    heardTake.current = true;
  }, [root, reviewText, draftId, sessionId]);
  /** The dictated draft was sent: its review, and any notice about its take, are over. */
  const endReview = () => { clearReview(); setDictatedDraft(null); };
  // The mic names the service the next take goes to (D4), from the read-only
  // discovery snapshot. Reading it mints nothing and opens no microphone.
  // A stale snapshot may no longer be the server's, so it names nothing.
  const discovery = useVoiceStore((s) => s.discovery && !s.discovery.stale ? s.discovery.snapshot : null);
  const discoveryStale = useVoiceStore((s) => s.discovery?.stale === true);
  // Before the microphone opens (the acknowledgement or a blocked take), nothing is being dictated yet.
  const gated = useVoiceStore((s) => s.dictationGate !== null);
  const nextTarget = discovery ? dictationTarget(discovery) : null;
  const dictateLabel = nextTarget?.kind === "ready" ? `Dictate · ${providerShortLabel(nextTarget.provider)}` : undefined;
  const localCapture = useLocalCapture();
  const localSupported = useLocalCaptureSupport();
  const localPhase = useVoiceStore((s) => s.local);
  const localNotice = useVoiceStore((s) => s.localNotice);
  // What the mic does (#1012). It is decided at the tap and kept for the
  // capture's life: a recording on the device stays one when the host comes
  // back, and a dictation never turns into one when the host goes away.
  // Without local recording on this root, the mic dictates as it always has.
  const micMode: "dictate" | "local" | "unsupported" | "pending" =
    voiceMode === "dictate" ? "dictate"
      : localPhase !== "idle" ? "local"
      : wsStatus === "connected" || root.localCapture === null ? "dictate"
      : localSupported === null ? "pending"
      : localSupported ? "local" : "unsupported";

  useEffect(() => {
    if (micMode === "dictate") void loadDiscovery(root).catch(() => {});
  }, [root, micMode, discoveryStale]);
  // Plan §7: with no dictation service registered, the mic is disabled and
  // says why. Recording on the device does not depend on one.
  const dictationUnavailable = micMode === "dictate" && voiceMode !== "dictate" && discovery?.providers.length === 0
    ? "Dictation isn\u0027t set up on this host." : undefined;

  const micLabel = micMode !== "local" ? dictated ? "Dictate more" : voiceMode === "dictate" && !gated ? undefined : dictateLabel : localPhase === "idle" || localPhase === "opening" ? "Record on this device" : "Stop and save";
  // The hold-to-talk mic at rest (#3693, drawn as signed off on #3727): it
  // dictates, or records on the device with no hold (M1). Dictating, a
  // recording in progress and a mic still deciding keep the kit's own mic.
  // With neither dictation nor live conversation here, the kit's disabled
  // mic still says why, since a hold would have nothing to offer.
  // D0 and Dx keep it drawn beside them: the take has not started (#3694).
  const restingMic = (micMode === "dictate" && (voiceMode !== "dictate" || gated) && !(dictationUnavailable && !conversation.available))
    || (micMode === "local" && (localPhase === "idle" || localPhase === "opening"));
  const [dismissedLocalNotice, setDismissedLocalNotice] = useState<string | null>(null);
  const captureNotice = micMode === "unsupported"
    ? "This browser can't save recordings on the device. You can type a note and send it when you're back online."
    : localNotice === "denied" && micMode === "local"
      ? "Brain can't use the microphone. Allow it in your browser's site settings, then tap Record again."
      : undefined;
  useEffect(() => { setDismissedLocalNotice(null); }, [captureNotice]);
  function dismissLocalNotice() {
    const frame = frameRef.current;
    const heldFocus = frame?.querySelector('[aria-label="Dismiss capture notice"]') === document.activeElement;
    setDismissedLocalNotice(captureNotice ?? null);
    root.stores.voice.getState().setLocalNotice(null);
    if (heldFocus) {
      const mic = frame?.querySelector<HTMLElement>('[aria-label^="Dictate"], [aria-label="Record on this device"]');
      if (mic) mic.focus(); else focusField();
    }
  }

  const runCommand = useChatCommands();

  // Derived during render, not synchronised through an effect: an effect would
  // cost a second render pass on every single keystroke. Escape dismisses the
  // palette without clearing the draft; typing brings it back.
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const showCommandPalette = input.startsWith("/") && !paletteDismissed;
  // The palette's active row (#1504): Enter runs it, the arrows move it, and
  // it returns to the first row whenever the filter changes.
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteMatches = showCommandPalette ? matchCommands(input.slice(1)) : [];
  const paletteActive = Math.min(paletteIndex, Math.max(paletteMatches.length - 1, 0));
  /** What Enter runs instead of sending: the active row, or a command typed in full. */
  const commandForEnter = (): string | null => paletteMatches[paletteActive]?.name ?? exactCommand(input);

  // An answer suggestion the reader took (#40, D50): merged into the draft,
  // never sent. The draft is kept byte for byte, the suggestion lands on its
  // own line, and the caret goes to the end so the reader can edit straight
  // away. A draft that is a command keeps its text but closes the palette:
  // the reader is writing a message now, not picking a command.
  const composerInsert = useChatStore((s) => s.composerInsert);
  const [insertNotice, setInsertNotice] = useState("");
  const [effortNotice, setEffortNotice] = useState("");
  /** Bumped when Send is pressed in a full chat: the notice is spoken again. */
  const [fullNotice, setFullNotice] = useState(0);
  useEffect(() => {
    if (!composerInsert) return;
    root.stores.chat.getState().clearComposerInsert(composerInsert.seq);
    const hadDraft = Boolean(input.trim());
    const next = insertSuggestion(input, composerInsert.text);
    setInput(next);
    if (next.startsWith("/")) setPaletteDismissed(true);
    setInsertNotice(hadDraft ? "Added below your draft" : "Added to the composer");
    setTimeout(() => {
      const field = frameRef.current?.querySelector("textarea");
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }, 0);
    // Only a new request runs this; `input` is read at that moment on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerInsert]);

  // Load the available provider combos once on mount.
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // The provider and desktop attach popovers keep their outside-click dismissal.
  // Phone Attach owns Escape and scrim dismissal through Overlay.
  useEffect(() => {
    if (!providerMenuOpen && !attachMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!providerMenuRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-model-trigger]")) setProviderMenuOpen(false);
      if (window.matchMedia("(min-width: 900px)").matches && !(e.target as HTMLElement).closest?.('[role="menu"][aria-label="Attach"]')) setAttachMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProviderMenuOpen(false);
        if (window.matchMedia("(min-width: 900px)").matches) setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [providerMenuOpen, attachMenuOpen]);

  /**
   * Decode, downscale and validate incoming image files, merging them with any
   * already-pending attachments. Rejected files (bad type / oversize / over the
   * per-message caps) surface as inline error lines; their object URLs are
   * revoked so nothing leaks.
   */
  async function addFiles(files: FileList | File[]) {
    // The draft that asked: decoding is async, and the view may move on.
    let target = draftId;
    const owner = sessionId;
    const incoming = Array.from(files);
    const list = incoming.filter(file => file.type.startsWith("image/"));
    const others = incoming.filter(file => !file.type.startsWith("image/"));
    const heldFiles = root.stores.drafts.getState().drafts[target]?.files ?? NO_FILES;
    // With composer files every other file is uploaded unfiltered and the host
    // decides what it is (#3155); an older host keeps the tab-only track queue.
    const trackErrors = filesOn
      ? fileQueue.add(others, target, {
        count: attachmentsOf(target).length + list.length + heldFiles.length,
        bytes: attachmentsOf(target).reduce((sum, image) => sum + image.bytes, 0) + heldFiles.reduce((sum, f) => sum + f.file.bytes, 0),
      }, fileLimits)
      : trackUploads.add(others, attachmentsOf(target).length + list.length,
        attachmentsOf(target).reduce((sum, image) => sum + image.bytes, 0));
    if (list.length === 0) { setAttachErrors(trackErrors); return; }

    const authEpoch = root.authLock.epoch();
    // Keep the operation's ownership when opening the other version removes
    // a navigation redirect. The subscription sees each committed fork first.
    const unwatch = root.stores.drafts.subscribe(state => { target = state.resolveId(target); });
    try {
      const results = await Promise.all(list.map((f) => fileToAttachment(f)));
      if (authEpoch !== root.authLock.epoch() || root.authLock.state.getState().phase !== "active") {
        for (const result of results) if (!("error" in result)) URL.revokeObjectURL(result.previewUrl);
        return;
      }
      const fresh: PendingAttachment[] = [];
      const errors: string[] = [...trackErrors];
      results.forEach((r, i) => {
        if ("error" in r) {
          errors.push(r.error);
        } else {
          fresh.push({ ...r, name: list[i].name });
        }
      });

      const current = attachmentsOf(target);
      const { accepted: imageAccepted } = validateAttachments([
        ...current,
        ...fresh,
      ]);
      const otherFiles = root.stores.drafts.getState().drafts[target]?.files ?? NO_FILES;
      const otherCount = trackUploads.files.length + fileQueue.files.length + otherFiles.length;
      let combinedBytes = trackUploads.files.reduce((sum, track) => sum + (track.meta?.bytes ?? track.file.size), 0)
        + fileQueue.files.reduce((sum, item) => sum + item.file.size, 0) + otherFiles.reduce((sum, f) => sum + f.file.bytes, 0);
      const maxFiles = fileLimits?.maxFiles ?? SHARE_MAX_FILES;
      const accepted = imageAccepted.filter((image, index) => {
        combinedBytes += image.bytes;
        return index + otherCount < maxFiles && combinedBytes <= SHARE_MAX_TOTAL_BYTES;
      });
      // Revoke URLs of freshly-decoded images that didn't make the cut.
      for (const f of fresh) {
        if (!accepted.includes(f)) {
          URL.revokeObjectURL(f.previewUrl);
          errors.push(`${f.name}: not added (message limit reached)`);
        }
      }
      setAttachmentsOf(target, owner, accepted);
      if (target === draftIdRef.current) setAttachErrors(errors);
    } finally { unwatch(); }
  }

  /** One chip removes only that image, in the draft's next revision (D52 §5). */
  function removeAttachment(index: number) {
    setAttachmentsOf(draftId, sessionId, attachmentsOf(draftId).filter((_, i) => i !== index));
  }

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) await addFiles(files);
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
  }

  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;

  function handleSubmit() {
    // Dictated words are in the field by now (D6), so the field is the draft.
    const text = input.trim();
    const currentTracks = trackUploads.files;
    const currentQueued = fileQueue.files;
    const currentDraft = root.stores.drafts.getState().drafts[draftId];
    const currentFiles = currentDraft ? bindableFiles(currentDraft) : [];
    const hasAttachments = attachments.length > 0 || currentTracks.length > 0 || currentQueued.length > 0 || draftFilesOf(currentDraft).length > 0;
    if ((!text && !hasAttachments) || wsStatus !== "connected" || waiting || sessionProfile.saving || sessionProfile.awaitingDraftFacts) return;
    if (restorationOf(root.stores.chat.getState())) return;

    // A host that keeps outgoing snapshots (#3155): Send writes one, durably,
    // in the save that clears the composer. A draft with legacy inline
    // images keeps the tab-local path below: a snapshot cannot hold them.
    if (snapshotsOn && chatRequestAck && attachments.length === 0 && currentTracks.length === 0) {
      submitSnapshot(text, hasAttachments);
      return;
    }

    if (currentTracks.some(track => track.state === "failed")) {
      setHeldSend(false);
      setEffortNotice("Your draft is kept. Retry or remove the failed track before sending.");
      return;
    }
    if (currentTracks.some(trackPending)) { setHeldSend(true); return; }
    const fileHold = composerFilesHold();
    if (fileHold.blocked) { setHeldSend(false); setEffortNotice(fileHold.blocked); return; }
    if (fileHold.pending) { setHeldSend(true); return; }
    const readyFiles = currentTracks.filter(trackReady).map(track => track.meta!);

    // A send while a question is pending is the ANSWER to it, not a new
    // message (D38 §1): the text binds to the question, the card quotes it,
    // and nothing goes out as `chat_message`. Attachments are not an answer
    // to a question, so a send that carries one stays a message.
    if (
      text &&
      !hasAttachments &&
      takeComposerTextAsAnswer(root.stores.chat.getState(), sessionId, text, (answer) =>
        // An answer the queue could not admit lived only in the composer:
        // put it back there rather than let it vanish with the draft.
        void root.answers.submit(answer).then((result) => {
          if (result === "refused") root.stores.chat.getState().requestComposerInsert(text);
        })
      )
    ) {
      setInput("");
      endReview();
      return;
    }

    if (text) setLastPrompt(text);
    const messageAttachments = attachments.map((a) => ({
      previewUrl: a.previewUrl,
      mediaType: a.attachment.mediaType,
    }));
    const chat = root.stores.chat.getState();
    const source = dictated ? "voice-dictate" : "typed";
    const requestId = chatRequestAck ? crypto.randomUUID() : undefined;
    // A send while the session is busy is a follow-up the host queues. On a
    // host that reports its queue it waits as a pending pill, not in the
    // chat, and enters the transcript when its own turn starts (#1002).
    const pendingFollowUp = isStreaming && sessionId !== null && requestId !== undefined && followUpQueue;
    if (pendingFollowUp) {
      root.stores.followUp.getState().addLocal(sessionId, {
        requestId,
        text,
        source,
        ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
        ...(readyFiles.length ? { files: readyFiles } : {}),
        ...(selectedEffort !== undefined ? { thinkingLevel: selectedEffort } : {}),
        queuedAt: Date.now(),
      });
    } else {
      chat.addUserMessage(
        sessionId,
        text,
        source,
        messageAttachments.length > 0 ? messageAttachments : undefined,
        requestId ? { requestId, thinkingLevel: selectedEffort } : undefined,
        readyFiles.length ? readyFiles : undefined,
        currentFiles.length ? currentFiles.map((f) => f.file) : undefined
      );
    }
    // A send while the session is already streaming is a follow-up — the server
    // queues it or delivers it live; don't pre-start a second assistant bubble
    // (the backend's next frames start it).
    if (!isStreaming) chat.startAssistantMessage(sessionId, undefined, requestId);
    // Correlate this turn when it is starting a NEW conversation, so its
    // session_info can be told apart from a background turn's.
    const correlation = sessionId ? undefined : chat.startDraftTurn();
    const message: Extract<ClientMessage, { type: "chat_message" }> = {
      type: "chat_message",
      text,
      sessionId: sessionId ?? undefined,
      ...(correlation ? { draftId: correlation } : {}),
      ...(sessionProfile.profileDraftId ? { profileDraftId: sessionProfile.profileDraftId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(selectedEffort !== undefined ? { thinkingLevel: selectedEffort } : {}),
      // Provider only applies to new conversations; resumed sessions are
      // pinned server-side to their original combo.
      // Only send a provider the server actually offers — a stale persisted
      // id (e.g. key removed server-side) falls back to the server default
      // instead of erroring with PROVIDER_UNAVAILABLE.
      providerId:
        sessionId || !providers.some((p) => p.id === selectedProviderId)
          ? undefined
          : selectedProviderId,
      ...(readyFiles.length ? { files: readyFiles.map(file => ({ kind: "file" as const, path: file.path })) } : {}),
      // The originals the saved revision binds; the host resolves each against
      // that revision (`draftRef`), so they are sent only with one (#3153).
      ...(currentFiles.length ? { attachmentRefs: currentFiles.map((f) => ({ kind: "attachment" as const, fileId: f.file.fileId })) } : {}),
      attachments: attachments.length > 0
        ? attachments.map((a) => a.attachment)
        : undefined,
      // Measured per send, not once per session: the same tab can rotate,
      // move to an external display, or be installed as a PWA mid-conversation.
      client: detectClientEnvironment(),
      // Kept by the host and returned on replay, so the message still reads
      // as dictated after a reload or on another device.
      source,
    };
    const drafts = root.stores.drafts.getState();
    if (requestId) {
      // The snapshot the host's answer settles (D52 §5). The field empties
      // now; the host keeps the revision the message names until it accepts
      // the message, and edits made from here on are the next revision.
      const { draftId: _correlation, ...snapshot } = message;
      const draftRef = drafts.beginSend({
        requestId, draftId, sessionId, text, attachments: [...attachments],
        ...(readyFiles.length ? { files: readyFiles } : {}),
        ...(currentFiles.length ? { attachmentFiles: currentFiles } : {}),
        // Staged tracks stay in the field until the host accepts the message.
        ...(currentTracks.length ? { tracks: { key: trackKey(sessionId, trackOwner), ids: currentTracks.map((t) => t.id) } } : {}),
        message: snapshot,
      }, input);
      if (draftRef) message.draftRef = draftRef;
      setPendingSend({ requestId, key: sessionId, effort });
    }
    const sent = send(message);
    if (requestId) {
      if (sent === false) {
        setPendingSend(null);
        // Nothing left: the snapshot goes back into the draft, whole,
        // dictated words included, so it still reads as dictated.
        drafts.sendFailed(requestId);
        chat.withdrawSend(sessionId, requestId);
        if (pendingFollowUp) root.stores.followUp.getState().dropLocal(requestId);
        root.stores.connection.getState().reportError("CHAT_NOT_SENT", "The message could not be sent. Your draft is kept.");
        return;
      }
      endReview();
      setAttachErrors([]);
      return;
    }
    // A host without request receipts: the message is gone the moment it is
    // sent, so is the draft. Ownership of the preview URLs transfers to the
    // rendered user message (revoked later by the chat store) — not revoked here.
    drafts.transfer(attachments);
    drafts.edit(draftId, sessionId, { text: "", attachments: [] });
    endReview();
    for (const track of currentTracks) trackUploads.remove(track.id);
    setAttachErrors([]);
  }

  /**
   * Send on a host that keeps snapshots (rev 5 §1–§2). The snapshot binds
   * the stored originals at once and owns the uploads still running; it is
   * `held` while any runs, else `dispatched`. Nothing is sent before the
   * host acknowledges the save that creates it: that save is the slot's
   * reservation, and a full chat refuses it with nothing sent.
   */
  function submitSnapshot(text: string, hasAttachments: boolean) {
    const store = root.stores.drafts.getState();
    if (outgoingFull) {
      setEffortNotice("");
      setFullNotice((n) => n + 1);
      return;
    }
    const own = fileQueue.files.filter((item) => !item.snapshotId);
    if (own.some(queuedBlocking)) { setEffortNotice("Your draft is kept. Retry or remove the file that wasn't stored before sending."); return; }
    const current = store.drafts[draftId];
    if (current && draftFilesOf(current).some((f) => f.lineage !== current.draftId)) { setEffortNotice("Your draft is kept. Remove the files marked not attached, or choose them again, before sending."); return; }
    if (current?.conflict) { setEffortNotice("Your draft is kept. Choose which version to keep before sending."); return; }
    if (current?.failure && current.failure.kind !== "unsaved") { setEffortNotice("Your draft is kept. Its files couldn't be saved with it; remove one and try again."); return; }
    // A typed answer to a pending question is still an answer, never a message (D38 §1).
    if (text && !hasAttachments && takeComposerTextAsAnswer(root.stores.chat.getState(), sessionId, text, (answer) =>
      void root.answers.submit(answer).then((result) => { if (result === "refused") root.stores.chat.getState().requestComposerInsert(text); }))) {
      setInput(""); endReview(); return;
    }
    if (text) setLastPrompt(text);
    const requestId = crypto.randomUUID();
    const pending = own.filter(queuedPending);
    const files = current ? bindableFiles(current) : [];
    const message: Extract<ClientMessage, { type: "chat_message" }> = {
      type: "chat_message", text,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionProfile.profileDraftId ? { profileDraftId: sessionProfile.profileDraftId } : {}),
      requestId,
      ...(selectedEffort !== undefined ? { thinkingLevel: selectedEffort } : {}),
      providerId: sessionId || !providers.some((p) => p.id === selectedProviderId) ? undefined : selectedProviderId,
      client: detectClientEnvironment(),
      source: dictated ? "voice-dictate" : "typed",
    };
    const snapshot: ComposerSnapshot = {
      snapshotId: crypto.randomUUID(), requestId, text,
      files: files.map((f) => ({ fileId: f.file.fileId, file: f.file })),
      state: pending.length > 0 ? "held" : "dispatched", createdAt: null, message,
      ...(pending.length > 0 ? { uploads: pending.map((item) => item.id) } : { dispatch: "due" as const }),
    };
    if (pending.length > 0) fileQueue.assign(pending.map((item) => item.id), snapshot.snapshotId);
    store.createSnapshot(draftId, sessionId, snapshot, input);
    setPendingSend({ requestId, key: sessionId, effort });
    endReview();
    setAttachErrors([]);
    setEffortNotice("");
  }

  /**
   * Whether composer files let this draft send now (#3155). Required uploads
   * and the save that binds their originals hold it; a file the host refused,
   * a failed upload or one carried from another draft id blocks it until
   * retried or removed. Unread PDF or text contents never hold it.
   */
  function composerFilesHold(): { blocked?: string; pending?: boolean } {
    const d = root.stores.drafts.getState().drafts[draftIdRef.current];
    const queued = fileQueue.files.filter((item) => !item.snapshotId);
    if (queued.some(queuedBlocking)) return { blocked: "Your draft is kept. Retry or remove the file that wasn't stored before sending." };
    if (d && draftFilesOf(d).some((f) => f.lineage !== d.draftId)) return { blocked: "Your draft is kept. Remove the files marked not attached, or choose them again, before sending." };
    if (queued.some(queuedPending)) return { pending: true };
    if (!d || draftFilesOf(d).length === 0) return {};
    if (d.failure && d.failure.kind !== "unsaved") return { blocked: "Your draft is kept. Its files couldn't be saved with it; remove one and try again." };
    if (d.conflict) return { blocked: "Your draft is kept. Choose which version to keep before sending its files." };
    // Sent only from an acknowledged revision: the message names it.
    if (!(d.host !== null && d.host.edit === d.edit)) return { pending: true };
    return {};
  }

  const submitHeldDraft = useRef(handleSubmit);
  useEffect(() => { submitHeldDraft.current = handleSubmit; });

  // The visible draft remains editable while waiting. Submit its current text,
  // once, only after every remaining file has a validated ready result.
  useEffect(() => {
    if (!heldSend) return;
    const fileHold = composerFilesHold();
    if (tracks.some(track => track.state === "failed")) {
      setHeldSend(false);
      setEffortNotice("Your draft is kept. Retry or remove the failed track before sending.");
    } else if (fileHold.blocked) {
      setHeldSend(false);
      setEffortNotice(fileHold.blocked);
    } else if (!tracks.some(trackPending) && !fileHold.pending && wsStatus === "connected") {
      setHeldSend(false);
      submitHeldDraft.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldSend, tracks, queuedFiles, draftClean, draftFailure, draftFiles, wsStatus]);

  /** What a held send waits for, in the hint row. */
  function heldHint(): string {
    const files = tracks.filter(trackPending).length + queuedFiles.filter(queuedPending).length;
    if (files > 0) return `sends when ${files} file${files === 1 ? " finishes" : "s finish"}`;
    return "sends when the draft with its files is saved";
  }

  function stopDictation() {
    // Read synchronously: another stop may arrive before React paints the
    // busy Finish button. The driver owns the drain and review handoff.
    if (root.stores.voice.getState().draining) return;
    void dictation.stop(true);
  }

  const [recordingNotice, setRecordingNotice] = useState("");
  useEffect(() => root.recordings?.onEvent(event => { if (event.message) setRecordingNotice(event.message); }), [root]);
  const focusMic = () => setTimeout(() => frameRef.current?.querySelector<HTMLElement>(
    '[aria-label="Record on this device"], [aria-label^="Dictate"], [aria-label="Stop and save"]'
  )?.focus({ preventScroll: true }), 0);
  // A take that ends while focus is in the voice field (Finish, V3's
  // silence stop, a provider end) hands focus back to the composer: the
  // field with the caret after the dictated words (D6), or the mic (D1).
  const refocusTake = useRef(false);
  const heardTake = useRef(false);
  useEffect(() => root.stores.voice.subscribe((state, previous) => {
    // Observe the end before React removes the sheet's focused control.
    // Automatic limits and track interruptions share this idle transition.
    if (state.local === "idle" && previous.local !== "idle" &&
      frameRef.current?.querySelector("[data-local-recording-sheet]")?.contains(document.activeElement)) focusMic();
    if (state.mode === "idle" && previous.mode === "dictate") {
      const active = document.activeElement;
      refocusTake.current = !active || active === document.body || Boolean(frameRef.current?.querySelector("[data-dictation-field]")?.contains(active));
    }
  }), [root]);
  useEffect(() => {
    if (voiceMode !== "idle" || !refocusTake.current) return;
    refocusTake.current = false;
    const heard = heardTake.current;
    heardTake.current = false;
    setTimeout(() => {
      const field = frameRef.current?.querySelector("textarea");
      if (!heard || !field) { focusMic(); return; }
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }, 0);
  }, [voiceMode]);
  const stopLocal = async () => { await localCapture.stop("user"); focusMic(); };
  const discardLocal = async () => {
    const active = localCapture.recording();
    try {
      await localCapture.stop("user");
      if (!active || !root.recordings) throw new Error("The recording identity is unavailable");
      await root.recordings.discard(active.partition, active.id);
      setRecordingNotice("Recording discarded from this device.");
    } catch (error) {
      setRecordingNotice("Couldn\u0027t discard this recording on this device. The recording is kept.");
      throw error;
    } finally { focusMic(); }
  };

  function handleMicTap() {
    const voice = root.stores.voice.getState();
    if (voice.mode === "dictate" && voice.dictationGate) {
      // The mic beside D0 or Dx: the take it asks about is not wanted.
      cancelDictation();
    } else if (voice.mode === "dictate") {
      stopDictation();
    } else if (micMode === "local") {
      setAttachMenuOpen(false);
      setProviderMenuOpen(false);
      setPaletteDismissed(true);
      // A recording on the device leaves the draft editable, and focus where
      // the tap put it: on the mic, which is also the stop.
      // A tap while the microphone is still opening cancels it.
      const phase = root.stores.voice.getState().local;
      if (phase === "recording" || phase === "opening") void stopLocal();
      else if (phase === "idle") void localCapture.start();
    } else if (micMode === "dictate") {
      setAttachMenuOpen(false);
      setProviderMenuOpen(false);
      setPaletteDismissed(true);
      // Defensive: blur composer so the keyboard never fights the voice field on Android
      frameRef.current?.querySelector("textarea")?.blur();
      // The draft stays put — what the new take hears is added after it.
      void dictation.start();
    }
  }

  /** Cancel, Esc or the mic on a take that has not started listening: focus returns to the mic. */
  function cancelDictation() {
    dictation.cancel();
    focusMic();
  }

  /** D8's Try again: a new take, whose words join the kept ones in the draft. */
  function retryDictation() {
    root.stores.voice.getState().dismissDictationNotice();
    if (root.stores.voice.getState().local !== "idle") return;
    void dictation.start();
  }

  /** D7's OK, D8's Dismiss: the words stay in the draft; focus goes to the mic, or the field without one. */
  function dismissDictationNotice() {
    root.stores.voice.getState().dismissDictationNotice();
    setTimeout(() => {
      const mic = frameRef.current?.querySelector<HTMLElement>('[aria-label^="Dictate"], [aria-label="Record on this device"]');
      if (mic) mic.focus({ preventScroll: true }); else focusField();
    }, 0);
  }

  // The mic's hold (#3693): Start when live conversation is offered here,
  // otherwise the S4 notice (V4). A hold itself captures nothing.
  const [liveNotice, setLiveNotice] = useState(false);
  function handleTalkLive() {
    setAttachMenuOpen(false);
    setProviderMenuOpen(false);
    const voice = root.stores.voice.getState();
    if (voice.mode !== "idle" || voice.local !== "idle") return;
    if (root.connection.conversation.state.getState().available) { setLiveNotice(false); root.connection.conversation.enter(); }
    else setLiveNotice(true);
  }
  function dismissLiveNotice() {
    setLiveNotice(false);
    focusMic();
  }
  // The notice answers one hold; it goes once the mic does something else.
  useEffect(() => { if (voiceMode !== "idle" || conversation.active) setLiveNotice(false); }, [voiceMode, conversation.active]);
  useEffect(() => {
    if (!liveNotice) return;
    const ok = [...frameRef.current?.querySelectorAll<HTMLElement>("[data-live-notice] button") ?? []].find(b => b.textContent === "OK");
    ok?.focus({ preventScroll: true });
  }, [liveNotice]);

  function handleRecall() {
    if (lastPrompt && !input.trim()) {
      setInput(lastPrompt);
      setTimeout(focusField, 50);
    }
  }

  function handleCancel() {
    // Scope the cancel to the session in view so it is unambiguous when several
    // sessions are running.
    send({ type: "cancel", sessionId: sessionId ?? undefined });
  }

  function handleCommand(command: string) {
    setInput("");
    runCommand(command);
  }

  const hasDraft = Boolean(
    input.trim() || attachments.length > 0 || tracks.length > 0 || queuedFiles.length > 0 || draftFiles.length > 0
  );
  // A send while a session is running is a follow-up (not blocked by streaming).
  const canSend = hasDraft && wsStatus === "connected" && !waiting && restorePhase === null && !sessionProfile.saving && !sessionProfile.awaitingDraftFacts && !outgoingFull;

  // Provider picker: locked to the pinned combo once a session is live.
  // Lock while streaming too: the first send of a new conversation pins the
  // provider server-side before session_info delivers the sessionId.
  const providerLocked = sessionId != null || isStreaming || waiting;
  const displayProviderId = providerLocked
    ? pinnedProviderId ?? selectedProviderId
    : selectedProviderId;
  const displayProvider = providers.find((p) => p.id === displayProviderId);
  const effortLevels = chatRequestAck ? displayProvider?.supportedThinkingLevels : undefined;
  const selectedEffort = effort.key === sessionId && effort.level !== undefined && effortLevels?.includes(effort.level) ? effort.level : undefined;
  // A session can be pinned to a profile the user has since hidden — it is gone
  // from the picker but still running the turn. Show its id rather than
  // claiming "Default model", which would name a different model than the one
  // actually answering.
  const displayProviderLabel =
    displayProvider?.label ?? displayProviderId ?? "Default model";
  // A pinned conversation's way to another backend lives in the locked
  // picker (#61), so the chip stays even with one profile: the entry is then
  // disabled with its reason, never hidden.
  const showProviderPicker = true;
  // What happens if the user sends into the currently-running session.
  const displayBackendId = displayProvider?.backendId;
  const followUpLive = !chatRequestAck && (displayBackendId ? backends[displayBackendId]?.capabilities.followUp ?? false : false);
  const followUpHint =
    isStreaming && sessionId
      ? followUpLive
        ? "Follows up live"
        : "Will queue"
      : null;

  return (
    <>
      {conversation.active ? <div className="px-2 md:px-6"><ConversationStrip backend={[displayProviderLabel, displayProvider?.backendId, displayProvider?.vendor].filter(Boolean).join(" · ")} onLeave={() => queueMicrotask(focusField)} /></div> : <div className="px-4 pt-2 pb-4 md:px-6 md:pb-6">
        {/* Says where a taken suggestion went, since focus moves with it. */}
        <div className="sr-only" aria-live="polite" data-composer-notice="">
          {insertNotice}
        </div>
        <div className="mx-auto max-w-3xl">
          {/* While the host cannot run agent turns (#1632): says so before a
              send, without blocking one. */}
          <WorkerHostNotice />
          {effortNotice && <div className="mb-2"><InlineToast text={effortNotice} target="" effect="" undoLabel="" tone="amber" /></div>}
          {/* The chat holds its limit of outgoing snapshots (rev 5 §2): drafting
              and every bubble action stay available; only Send waits. */}
          {outgoingFull && <div className="mb-2 flex items-start gap-2" data-outgoing-full="">
            <div className="min-w-0 flex-1" role="status" key={fullNotice}>
              <Callout tone="amber" variant="boxed" icon="attention" text={`${outgoingFull.limit} messages in this chat are waiting or need recovery. Send, cancel or delete one, then send this. Your text stays here.`} />
            </div>
            <Button label="Show" tone="ghost" size="md" block={false} reach onClick={() => { focusOldestSnapshot(); }} />
          </div>}
          {/* Anything shared from the OS waits here for a tap. Above the
              composer, so it reads as something to act on rather than a
              notification that has already happened. */}
          <ShareIntake />

          <RecordingsTray composerRef={frameRef} onAccepted={() => setPaletteDismissed(true)} />
          {recordingNotice && <p role="status" className="mb-2 text-xs text-muted-foreground">{recordingNotice}</p>}
        </div>

        {/* Hidden file inputs for the paperclip / camera buttons */}
        <input ref={libraryInputRef} type="file" accept="image/*" multiple hidden onChange={onFilePick} />
        <input ref={trackInputRef} type="file" accept=".gpx,application/gpx+xml,.kml,application/vnd.google-earth.kml+xml,.geojson,application/geo+json,.json,application/json" multiple hidden onChange={onFilePick} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={onFilePick} />
        {/* Files: no accept filter. The host decides what each file is (#3155). */}
        {filesOn && <input ref={fileInputRef} type="file" multiple hidden onChange={onFilePick} data-files-input="" />}

        <ComposerView
          // D6 is the review (#3694, M2 on #3727): the mic is "Dictate more", with no hold.
          micControl={restingMic ? <ComposerMic name={micLabel} onTap={handleMicTap} onTalkLive={micMode === "dictate" && !dictated ? handleTalkLive : undefined} /> : undefined}
          voiceField={capturing ? <DictationCapture onFinish={stopDictation} onCancel={cancelDictation} /> : undefined}
          dictation={<>{liveNotice && <div className="mb-2" data-live-notice="">
            <VoiceNotice tone="idle" icon="fyi" title="Live conversation isn’t set up here" body="Whoever runs this brain can add a live service. Dictation still works." actions={[{ label: "OK", onClick: dismissLiveNotice }]} />
          </div>}<DictationNotices onConfirm={dictation.confirm} onCancel={cancelDictation} onRetry={retryDictation} onDismiss={dismissDictationNotice}
            onOpenSettings={() => { dictation.cancel(); root.stores.ui.getState().openSettings("voice"); }} />
            {root.localCapture?.durable && <LocalRecordingSheet open={localPhase === "recording" || localPhase === "stopping"} onStop={stopLocal} onDiscard={discardLocal} />}</>}
          captureNotice={captureNotice !== dismissedLocalNotice ? captureNotice : undefined}
          onDismissCaptureNotice={dismissLocalNotice}
          mic={micMode !== "unsupported"}
          micLabel={micLabel}
          micTip={micMode === "dictate" && voiceMode !== "dictate" && dictateLabel !== undefined}
          micUnavailable={dictationUnavailable}
          value={input}
          // The kit's `state` drives placeholder, hint and the trailing control
          // together (D37): streaming shows the stop, reconnecting keeps send
          // live, offline disables it and keeps the draft. While dictation
          // captures, the voice field stands in for all of it.
          state={
            wsStatus === "connected" && (restorePhase !== null || sessionProfile.saving || sessionProfile.awaitingDraftFacts || (outgoingFull !== null && !isStreaming))
              // The kit's disabled send, with its own reason (#1328).
              ? "offline"
              : wsStatus === "connected"
              ? isStreaming
                ? "streaming"
                : "ready"
              : wsStatus === "connecting" && connectionIssue === null
                ? "reconnecting"
                : "offline"
          }
          placeholder={
            wsStatus === "connected" && restorePhase !== null
              ? "Sending waits until this conversation is restored"
              : wsStatus !== "connected"
              ? connectionIssue === "capacity"
                ? "Server connection limit reached"
                : connectionIssue === "refused"
                  ? "Server refused the connection"
                  : "Connecting..."
              : root.config.composerPlaceholder
          }
          hint={localPhase === "recording" ? "Recording on this device" : heldSend ? heldHint() : localSaveFailed ? LOCAL_SAVE_FAILED : followUpHint ? `${followUpHint} · ${finePointer ? "esc or " : ""}the stop button ends the run` : undefined}
          blockedWhy={
            wsStatus === "connected" && outgoingFull !== null && restorePhase === null && !sessionProfile.saving && !sessionProfile.awaitingDraftFacts ? `${outgoingFull.limit} messages waiting · your text stays here`
              : wsStatus === "connected" && sessionProfile.saving ? "saving this chat profile · your draft is kept"
              : wsStatus === "connected" && sessionProfile.awaitingDraftFacts ? "waiting for this chat profile · reopen the model picker to retry"
              : wsStatus === "connected" && restorePhase !== null
              ? `${restorePhase === "failed" ? "this conversation could not be restored" : "restoring this conversation"} · your draft is kept`
              : wsStatus === "connected" ? undefined : `${connectionIssue === "capacity" ? "the host is full" : connectionIssue === "refused" ? "the host refused the connection" : "needs the host"} · your draft is kept`
          }
          paletteOpen={showCommandPalette}
          palette={showCommandPalette ? <CommandPalette filter={input.slice(1)} activeIndex={paletteActive} onSelect={handleCommand} /> : null}
          onPaletteMove={paletteMatches.length ? (step) => setPaletteIndex((paletteActive + step + paletteMatches.length) % paletteMatches.length) : undefined}
          attachMenuOpen={attachMenuOpen}
          attachments={attachments.map((a) => ({ previewUrl: a.previewUrl, name: a.name }))}
          tracks={tracks}
          onRemoveTrack={id => {
            trackUploads.remove(id);
            // The last of the view's content (#1112): it is an empty chat now,
            // out of Drafts, and the field is where the reader goes on.
            const current = root.stores.drafts.getState().drafts[draftId];
            if (trackUploads.files.length === 0 && !current?.text && !current?.attachments.length) focusField();
          }}
          onRetryTrack={id => trackUploads.retry(id)}
          files={filesOn ? { queued: queuedFiles, stored: draftFiles.map((f) => ({ file: f.file, detached: f.lineage !== draftId })) } : undefined}
          onRemoveQueuedFile={(id) => fileQueue.remove(id)}
          onRetryQueuedFile={(id) => fileQueue.retry(id)}
          onRemoveStoredFile={(fileId) => {
            const current = root.stores.drafts.getState().drafts[draftId];
            if (current) root.stores.drafts.getState().edit(draftId, sessionId, { files: draftFilesOf(current).filter((f) => f.file.fileId !== fileId) });
          }}
          fileAnnouncement={fileAnnouncement}
          status={<DraftIndicator draftId={draftId} queued={queuedFiles} online={browserOnline && wsStatus === "connected"} />}
          uploadNotice={closedUploads?.length ? uploadNoticeCopy(closedUploads) : undefined}
          onDismissUploadNotice={() => root.localWork?.restore.setState((s) => ({ uploads: (s.uploads ?? []).filter((u) => !closedUploadsFor(u)) }))}
          attachErrors={attachErrors}
          chatProfile={sessionProfile.chat}
          provider={
            showProviderPicker
              ? {
                  label: displayProviderLabel,
                  locked: providerLocked,
                  menuOpen: providerMenuOpen,
                  options: providers.map((p) => ({ id: p.id, label: p.label })),
                  selectedId: displayProviderId,
                  defaultEffort: displayProvider?.thinkingLevel,
                  effortLevels,
                  selectedEffort,
                  effortExplanation: selectedEffort && effort.requested && !effortLevels?.includes(effort.requested)
                    ? `${effort.requested} not supported` : undefined,
                  ...(providerLocked && handoffEntry.shown ? {
                    lockedAction: {
                      label: HANDOFF_ENTRY_LABEL,
                      detail: "starts a new linked chat; this one stays",
                      ...(handoffEntry.why ? { why: handoffEntry.why } : {}),
                      onSelect: () => { setProviderMenuOpen(false); handoffEntry.open(); },
                    },
                  } : {}),
                }
              : null
          }
          frameRef={frameRef}
          providerMenuRef={providerMenuRef}
          onChange={(value) => {
            if (capturing || creatingSnapshot) return;
            setInput(value);
            setPaletteDismissed(false);
            setPaletteIndex(0);
          }}
          onSend={() => {
            if (capturing) return;
            // A slash command runs as clicking its row does; it is never sent.
            const command = commandForEnter();
            if (command) handleCommand(command);
            else if (canSend) handleSubmit();
          }}
          onStop={handleCancel}
          onMic={micMode === "pending" ? undefined : handleMicTap}
          onAttachToggle={() => setAttachMenuOpen((v) => !v)}
          onPickLibrary={() => {
            setAttachMenuOpen(false);
            libraryInputRef.current?.click();
          }}
          onPickTracks={() => { setAttachMenuOpen(false); trackInputRef.current?.click(); }}
          onPickFiles={filesOn ? () => { setAttachMenuOpen(false); fileInputRef.current?.click(); } : undefined}
          onPickCamera={() => {
            setAttachMenuOpen(false);
            cameraInputRef.current?.click();
          }}
          onPasteFiles={(files) => void addFiles(files)}
          onRecall={handleRecall}
          onEscape={() => setPaletteDismissed(true)}
          onRemoveAttachment={removeAttachment}
          onDismissErrors={() => setAttachErrors([])}
          onProviderToggle={() => { if (!providerMenuOpen) sessionProfile.refresh(); setProviderMenuOpen((v) => !v); }}
          onProviderSelect={(id) => {
            if (providerLocked) return;
            setSelectedProvider(id);
            const next = providers.find((profile) => profile.id === id);
            if (selectedEffort !== undefined) {
              const resolved = resolveThinkingLevel(selectedEffort, next?.supportedThinkingLevels ?? []);
              setEffort({ key: sessionId, level: resolved, requested: resolved ? effort.requested ?? selectedEffort : undefined });
              if (resolved !== selectedEffort) {
                setEffortNotice(resolved ? `Effort changed from ${selectedEffort} to ${resolved} for this model` : "This model has no effort setting; the next message uses its default");
              }
            }
          }}
          onProviderDismiss={() => {
            setProviderMenuOpen(false);
            setTimeout(() => frameRef.current?.querySelector<HTMLElement>("[data-model-trigger]")?.focus(), 0);
          }}
          onEffortSelect={(level) => {
            setEffortNotice("");
            setEffort({ key: sessionId, level: level ?? undefined });
            setInsertNotice(level ? `Effort ${level} for the next message` : `Default effort${displayProvider?.thinkingLevel ? ` ${displayProvider.thinkingLevel}` : ""} for the next message`);
            setProviderMenuOpen(false);
            setTimeout(focusField, 0);
          }}
        />
        {knownVoiceDraft && <p className="px-2 text-xs text-muted-foreground" data-voice-draft-explanation="">Voice draft · not submitted as a Brain task. The voice service already received audio. These words remain a draft for a separate Brain task. A voice reply does not submit this draft.</p>}
      </div>}
      <ConversationUnassigned onReview={() => queueMicrotask(focusField)} />
    </>
  );
}
