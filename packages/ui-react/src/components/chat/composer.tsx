import { InlineToast } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useState, useRef, useEffect, useImperativeHandle, useReducer, type Ref } from "react";
import { resolveThinkingLevel } from "@schlessera/brain-ui-sdk/internal/client";
import { SHARE_MAX_FILES, SHARE_MAX_TOTAL_BYTES, type ClientMessage, type ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { deriveConnectionIssue } from "../connectivity/connection-state.js";
import { useProviderStore } from "../../stores/provider-store.js";
import {
  fileToAttachment,
  validateAttachments,
  type PendingAttachment,
} from "../../lib/image-attachments.js";
import { ShareIntake } from "./share-card.js";
import { CommandPalette } from "./command-palette.js";
import { ComposerView } from "./composer-view.js";
import { DictationSheet } from "../voice/dictation-sheet.js";
import { ReviewCard } from "../voice/review-card.js";
import { useDictation } from "../../voice/use-dictation.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { detectClientEnvironment } from "../../lib/client-environment.js";
import { useChatCommands } from "./use-chat-commands.js";
import { takeComposerTextAsAnswer } from "./ask-user-typed.js";
import { trackPending, trackReady } from "../../lib/track-uploads.js";
import { trackKey, tracksFor } from "../../lib/draft-tracks.js";
import { insertSuggestion } from "../../lib/answer-suggestions.js";
import { HANDOFF_ENTRY_LABEL, useHandoffEntry } from "../../hooks/use-handoff-entry.js";
import { DraftSaveLine } from "./draft-save-line.js";

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
  const sessionId = useChatStore((s) => s.activeSessionId);
  // The draft this view shows (D52 §5): its session's, or the new chat's.
  const draftId = useRootStore("drafts", (s) => s.idFor(sessionId));
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const input = draft?.text ?? "";
  const attachments = draft?.attachments ?? NO_ATTACHMENTS;
  /** Write the view's draft. A function reads the draft as it is now, not as rendered. */
  const setInput = (value: string | ((current: string) => string)) => {
    const store = root.stores.drafts.getState();
    const current = store.drafts[draftId]?.text ?? "";
    store.edit(draftId, sessionId, { text: typeof value === "function" ? value(current) : value });
  };
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
  const attachmentsOf = (id: string) => root.stores.drafts.getState().drafts[id]?.attachments ?? NO_ATTACHMENTS;
  const setAttachmentsOf = (id: string, owner: string | null, next: PendingAttachment[]) =>
    root.stores.drafts.getState().edit(id, owner, { attachments: next });
  const [attachErrors, setAttachErrors] = useState<string[]>([]);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const trackInputRef = useRef<HTMLInputElement>(null);
  const [, updateTrackView] = useReducer((n: number) => n + 1, 0);
  const trackEntry = tracksFor(root, trackKey(sessionId, draftId));
  const trackUploads = trackEntry.uploads;
  useEffect(() => {
    trackEntry.listeners.add(updateTrackView);
    return () => { trackEntry.listeners.delete(updateTrackView); };
  }, [trackEntry]);
  const tracks = trackUploads.files;
  const [heldSend, setHeldSend] = useState(false);

  // Provider picker
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  // A conversation with a settled reply can be continued on another backend (#61).
  const hasSettledTurn = useChatStore((s) => activeChat(s).messages.some((m) => m.role === "assistant" && !m.isStreaming));
  const handoffEntry = useHandoffEntry(sessionId, hasSettledTurn);
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  useEffect(() => {
    const changed = () => trackUploads.setOnline(wsStatus === "connected" && navigator.onLine !== false);
    changed();
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => { window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
  }, [wsStatus, trackUploads]);
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
  const sendState = useRootStore("drafts", (s) => pendingSend ? s.sends[pendingSend.requestId] : undefined);
  // A send of this view still unanswered: another would start a second
  // conversation, or repeat this one, so it waits (#942).
  const waiting = useRootStore("drafts", (s) => Object.values(s.sends).some((x) => x.state === "pending" && x.sessionId === sessionId && (sessionId !== null || x.draftId === draftId)));
  useEffect(() => {
    // Naming our accepted new conversation is not a conversation switch.
    // Carry a newer choice to its identity; consume only the sent choice.
    const namedDraft = pendingSend?.key === null && sendState?.state === "accepted" && sendState.acceptedSessionId === sessionId;
    setEffort((current) => namedDraft && current !== pendingSend.effort ? { ...current, key: sessionId } : { key: sessionId });
    setEffortNotice("");
    setHeldSend(false);
    setAttachErrors([]);
    // Settled sends consume a choice below; this runs only when identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, draftId]);
  useEffect(() => {
    if (!pendingSend || !sendState || sendState.state === "pending") return;
    const visible = sessionId === pendingSend.key || (pendingSend.key === null && sessionId === sendState.acceptedSessionId);
    if (sendState.state === "accepted" && visible) {
      setEffortNotice("");
      setEffort((current) => current === pendingSend.effort ? { key: sessionId } : current);
    }
    setPendingSend(null);
  }, [sendState, pendingSend, sessionId]);

  // Voice dictation state
  const voiceMode = useVoiceStore((s) => s.mode);
  const reviewText = useVoiceStore((s) => s.reviewText);
  const clearReview = useVoiceStore((s) => s.clearReview);
  const dictation = useDictation();

  const runCommand = useChatCommands();

  // Derived during render, not synchronised through an effect: an effect would
  // cost a second render pass on every single keystroke. Escape dismisses the
  // palette without clearing the draft; typing brings it back.
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const showCommandPalette = input.startsWith("/") && !paletteDismissed;

  // An answer suggestion the reader took (#40, D50): merged into the draft,
  // never sent. The draft is kept byte for byte, the suggestion lands on its
  // own line, and the caret goes to the end so the reader can edit straight
  // away. A draft that is a command keeps its text but closes the palette:
  // the reader is writing a message now, not picking a command.
  const composerInsert = useChatStore((s) => s.composerInsert);
  const [insertNotice, setInsertNotice] = useState("");
  const [effortNotice, setEffortNotice] = useState("");
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

  // Dismiss the provider popover and the attach menu on outside-click / Escape.
  useEffect(() => {
    if (!providerMenuOpen && !attachMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!providerMenuRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-model-trigger]")) setProviderMenuOpen(false);
      if (!(e.target as HTMLElement).closest?.('[role="menu"][aria-label="Attach"], [role="dialog"][aria-label="Attach"]')) setAttachMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProviderMenuOpen(false);
        setAttachMenuOpen(false);
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
   * The draft is whatever is visible above the send button: composer text
   * plus any voice text under review. Both send paths submit the combined
   * draft so nothing is silently dropped.
   */
  function draftText() {
    return [input.trim(), reviewText.trim()].filter(Boolean).join("\n");
  }

  /**
   * Decode, downscale and validate incoming image files, merging them with any
   * already-pending attachments. Rejected files (bad type / oversize / over the
   * per-message caps) surface as inline error lines; their object URLs are
   * revoked so nothing leaks.
   */
  async function addFiles(files: FileList | File[]) {
    // The draft that asked: decoding is async, and the view may move on.
    const target = draftId;
    const owner = sessionId;
    const incoming = Array.from(files);
    const list = incoming.filter(file => file.type.startsWith("image/"));
    const trackErrors = trackUploads.add(incoming.filter(file => !file.type.startsWith("image/")), attachmentsOf(target).length + list.length,
      attachmentsOf(target).reduce((sum, image) => sum + image.bytes, 0));
    if (list.length === 0) { setAttachErrors(trackErrors); return; }

    const results = await Promise.all(list.map((f) => fileToAttachment(f)));
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
    let combinedBytes = trackUploads.files.reduce((sum, track) => sum + track.file.size, 0);
    const accepted = imageAccepted.filter((image, index) => {
      combinedBytes += image.bytes;
      return index + trackUploads.files.length < SHARE_MAX_FILES && combinedBytes <= SHARE_MAX_TOTAL_BYTES;
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
    const text = draftText();
    const currentTracks = trackUploads.files;
    const hasAttachments = attachments.length > 0 || currentTracks.length > 0;
    if ((!text && !hasAttachments) || wsStatus !== "connected" || waiting) return;

    if (currentTracks.some(track => track.state === "failed")) {
      setHeldSend(false);
      setEffortNotice("Your draft is kept. Retry or remove the failed track before sending.");
      return;
    }
    if (currentTracks.some(trackPending)) { setHeldSend(true); return; }
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
      clearReview();
      return;
    }

    if (text) setLastPrompt(text);
    const messageAttachments = attachments.map((a) => ({
      previewUrl: a.previewUrl,
      mediaType: a.attachment.mediaType,
    }));
    const chat = root.stores.chat.getState();
    const source = reviewText.trim() ? "voice-dictate" : "typed";
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
        readyFiles.length ? readyFiles : undefined
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
        // Staged tracks stay in the field until the host accepts the message.
        ...(currentTracks.length ? { tracks: { key: trackKey(sessionId, draftId), ids: currentTracks.map((t) => t.id) } } : {}),
        message: snapshot,
      }, input);
      if (draftRef) message.draftRef = draftRef;
      setPendingSend({ requestId, key: sessionId, effort });
    }
    const sent = send(message);
    if (requestId) {
      if (sent === false) {
        setPendingSend(null);
        // Nothing left: the snapshot goes back into the draft, whole.
        drafts.sendFailed(requestId);
        chat.withdrawSend(sessionId, requestId);
        if (pendingFollowUp) root.stores.followUp.getState().dropLocal(requestId);
        root.stores.connection.getState().reportError("CHAT_NOT_SENT", "The message could not be sent. Your draft is kept.");
        return;
      }
      clearReview();
      setAttachErrors([]);
      return;
    }
    // A host without request receipts: the message is gone the moment it is
    // sent, so is the draft. Ownership of the preview URLs transfers to the
    // rendered user message (revoked later by the chat store) — not revoked here.
    drafts.transfer(attachments);
    drafts.edit(draftId, sessionId, { text: "", attachments: [] });
    clearReview();
    for (const track of currentTracks) trackUploads.remove(track.id);
    setAttachErrors([]);
  }

  const submitHeldDraft = useRef(handleSubmit);
  useEffect(() => { submitHeldDraft.current = handleSubmit; });

  // The visible draft remains editable while waiting. Submit its current text,
  // once, only after every remaining file has a validated ready result.
  useEffect(() => {
    if (!heldSend) return;
    if (tracks.some(track => track.state === "failed")) {
      setHeldSend(false);
      setEffortNotice("Your draft is kept. Retry or remove the failed track before sending.");
    } else if (!tracks.some(trackPending) && wsStatus === "connected") {
      setHeldSend(false);
      submitHeldDraft.current();
    }
  }, [heldSend, tracks, wsStatus]);

  function stopDictation() {
    // Read synchronously: another stop may arrive before React paints the
    // disabled Done button. The driver owns the drain and review handoff.
    if (root.stores.voice.getState().draining) return;
    void dictation.stop(true);
  }

  function handleMicTap() {
    if (root.stores.voice.getState().mode === "dictate") {
      stopDictation();
    } else {
      setAttachMenuOpen(false);
      setProviderMenuOpen(false);
      setPaletteDismissed(true);
      // Defensive: blur composer so the keyboard never fights the mic sheet on Android
      frameRef.current?.querySelector("textarea")?.blur();
      // Any existing review text stays put — the new capture appends to it.
      void dictation.start();
    }
  }

  function handleVoiceSend() {
    if (!draftText() || isStreaming || wsStatus !== "connected") {
      // If we cannot send right now, fall back to editing
      handleVoiceEdit();
      return;
    }
    handleSubmit();
  }

  function handleVoiceEdit() {
    setInput((prev) => (prev ? `${prev}\n${reviewText}` : reviewText));
    clearReview();
    setTimeout(focusField, 50);
  }

  function handleVoiceAppend() {
    // Review text stays in place; the next capture appends to it on stop.
    void dictation.start();
  }

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
    input.trim() || reviewText.trim() || attachments.length > 0 || tracks.length > 0
  );
  // A send while a session is running is a follow-up (not blocked by streaming).
  const canSend = hasDraft && wsStatus === "connected" && !waiting;

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
  const showProviderPicker = providers.length > 1 || Boolean(effortLevels?.length) || (providerLocked && handoffEntry.shown);
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
      <div className="px-4 pt-2 pb-4 md:px-6 md:pb-6">
        {/* Says where a taken suggestion went, since focus moves with it. */}
        <div className="sr-only" aria-live="polite" data-composer-notice="">
          {insertNotice}
        </div>
        <div className="mx-auto max-w-3xl">
          {effortNotice && <div className="mb-2"><InlineToast text={effortNotice} target="" effect="" undoLabel="" tone="amber" /></div>}
          {/* Anything shared from the OS waits here for a tap. Above the
              composer, so it reads as something to act on rather than a
              notification that has already happened. */}
          <ShareIntake />

          {/* Voice review card sits above the composer */}
          <ReviewCard
            text={reviewText}
            onSend={handleVoiceSend}
            onEdit={handleVoiceEdit}
            onDiscard={clearReview}
            onAppend={handleVoiceAppend}
          />
        </div>

        {/* Hidden file inputs for the paperclip / camera buttons */}
        <input ref={libraryInputRef} type="file" accept="image/*" multiple hidden onChange={onFilePick} />
        <input ref={trackInputRef} type="file" accept=".gpx,application/gpx+xml,.kml,application/vnd.google-earth.kml+xml,.geojson,application/geo+json,.json,application/json" multiple hidden onChange={onFilePick} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={onFilePick} />

        <ComposerView
          dictation={<DictationSheet open={voiceMode === "dictate"}
            composerRef={frameRef} onStop={stopDictation} onCancel={() => dictation.cancel()} />}
          value={input}
          // The kit's `state` drives placeholder, hint and the trailing control
          // together (D37): streaming shows the stop, reconnecting keeps send
          // live, offline disables it and keeps the draft. Dictating keeps the
          // draft read-only and makes the mic the explicit capture stop.
          state={
            voiceMode === "dictate"
              ? "dictating"
              : wsStatus === "connected"
              ? isStreaming
                ? "streaming"
                : "ready"
              : wsStatus === "connecting" && connectionIssue === null
                ? "reconnecting"
                : "offline"
          }
          placeholder={
            voiceMode === "dictate" ? "Dictating…" : wsStatus !== "connected"
              ? connectionIssue === "capacity"
                ? "Server connection limit reached"
                : connectionIssue === "refused"
                  ? "Server refused the connection"
                  : "Connecting..."
              : root.config.composerPlaceholder
          }
          hint={heldSend ? `sends when ${tracks.filter(trackPending).length} file${tracks.filter(trackPending).length === 1 ? " finishes" : "s finish"}` : voiceMode === "dictate" ? "Dictating… · stop to review your words" : followUpHint ? `${followUpHint} · esc or the stop button ends the run` : undefined}
          blockedWhy={
            wsStatus === "connected" ? undefined : `${connectionIssue === "capacity" ? "the host is full" : connectionIssue === "refused" ? "the host refused the connection" : "needs the host"} · your draft is kept`
          }
          paletteOpen={showCommandPalette}
          palette={showCommandPalette ? <CommandPalette filter={input.slice(1)} onSelect={handleCommand} /> : null}
          attachMenuOpen={attachMenuOpen}
          attachments={attachments.map((a) => ({ previewUrl: a.previewUrl, name: a.name }))}
          tracks={tracks}
          onRemoveTrack={id => trackUploads.remove(id)}
          onRetryTrack={id => trackUploads.retry(id)}
          attachErrors={attachErrors}
          provider={
            showProviderPicker && voiceMode !== "dictate"
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
            if (voiceMode === "dictate") return;
            setInput(value);
            setPaletteDismissed(false);
          }}
          onSend={() => {
            if (voiceMode !== "dictate" && canSend) handleSubmit();
          }}
          onStop={handleCancel}
          onMic={handleMicTap}
          onAttachToggle={() => setAttachMenuOpen((v) => !v)}
          onPickLibrary={() => {
            setAttachMenuOpen(false);
            libraryInputRef.current?.click();
          }}
          onPickTracks={() => { setAttachMenuOpen(false); trackInputRef.current?.click(); }}
          onPickCamera={() => {
            setAttachMenuOpen(false);
            cameraInputRef.current?.click();
          }}
          onPasteFiles={(files) => void addFiles(files)}
          onRecall={handleRecall}
          onEscape={() => setPaletteDismissed(true)}
          onRemoveAttachment={removeAttachment}
          onDismissErrors={() => setAttachErrors([])}
          onProviderToggle={() => setProviderMenuOpen((v) => !v)}
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
        {/* What became of this draft's save, under the field (D52 §5). */}
        <DraftSaveLine draftId={draftId} />
      </div>
    </>
  );
}
