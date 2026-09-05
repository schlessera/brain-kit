import { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  Square,
  CornerLeftUp,
  Paperclip,
  Camera,
  X,
  Check,
  ChevronDown,
  Lock,
} from "lucide-react";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { uiConfig } from "../../config.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import {
  fileToAttachment,
  validateAttachments,
  type PendingAttachment,
} from "../../lib/image-attachments.js";
import { ShareIntake } from "./share-card.js";
import { CommandPalette } from "./command-palette.js";
import { MicButton } from "../voice/mic-button.js";
import { DictationSheet } from "../voice/dictation-sheet.js";
import { ReviewCard } from "../voice/review-card.js";
import { useDictation } from "../../voice/use-dictation.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { detectClientEnvironment } from "../../lib/client-environment.js";
import { useChatCommands } from "./use-chat-commands.js";
import { cn } from "../../lib/utils.js";

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
 */
export function Composer({ send }: { send: (msg: ClientMessage) => void }) {
  const [input, setInput] = useState("");
  const [lastPrompt, setLastPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Image attachments. `attachmentsRef` mirrors state so async add/merge logic
  // reads the current set synchronously (avoids stale closures / updater races).
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [attachErrors, setAttachErrors] = useState<string[]>([]);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  // Revoke preview URLs of attachments that were never sent (unmount cleanup;
  // sent attachments transfer URL ownership to the message in the chat store).
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
    },
    []
  );

  // Provider picker
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const wsStatus = useConnectionStore((s) => s.wsStatus);

  const providers = useProviderStore((s) => s.available);
  const selectedProviderId = useProviderStore((s) => s.selectedId);
  const pinnedProviderId = useProviderStore((s) => s.pinnedId);
  const setSelectedProvider = useProviderStore((s) => s.setSelected);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const backends = useProviderStore((s) => s.backends);

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

  // Load the available provider combos once on mount.
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // Dismiss the provider popover on outside-click / Escape.
  useEffect(() => {
    if (!providerMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!providerMenuRef.current?.contains(e.target as Node)) {
        setProviderMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProviderMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [providerMenuOpen]);

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
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;

    const results = await Promise.all(list.map((f) => fileToAttachment(f)));
    const fresh: PendingAttachment[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if ("error" in r) {
        errors.push(r.error);
      } else {
        fresh.push({ ...r, name: list[i].name });
      }
    });

    const { accepted } = validateAttachments([
      ...attachmentsRef.current,
      ...fresh,
    ]);
    // Revoke URLs of freshly-decoded images that didn't make the cut.
    for (const f of fresh) {
      if (!accepted.includes(f)) {
        URL.revokeObjectURL(f.previewUrl);
        errors.push(`${f.name}: not added (message limit reached)`);
      }
    }
    attachmentsRef.current = accepted;
    setAttachments(accepted);
    setAttachErrors(errors);
  }

  function removeAttachment(index: number) {
    const next = attachmentsRef.current.filter((item, i) => {
      if (i === index) URL.revokeObjectURL(item.previewUrl);
      return i !== index;
    });
    attachmentsRef.current = next;
    setAttachments(next);
  }

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) await addFiles(files);
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
  }

  function handleSubmit() {
    const text = draftText();
    const hasAttachments = attachments.length > 0;
    if ((!text && !hasAttachments) || wsStatus !== "connected") return;

    if (text) setLastPrompt(text);
    const messageAttachments = attachments.map((a) => ({
      previewUrl: a.previewUrl,
      mediaType: a.attachment.mediaType,
    }));
    const chat = useChatStore.getState();
    chat.addUserMessage(
      sessionId,
      text,
      reviewText.trim() ? "voice-dictate" : "typed",
      messageAttachments.length > 0 ? messageAttachments : undefined
    );
    // A send while the session is already streaming is a follow-up — the server
    // queues it or delivers it live; don't pre-start a second assistant bubble
    // (the backend's next frames start it).
    if (!isStreaming) chat.startAssistantMessage(sessionId);
    // Correlate this turn when it is starting a NEW conversation, so its
    // session_info can be told apart from a background turn's.
    const draftId = sessionId ? undefined : chat.startDraftTurn();
    send({
      type: "chat_message",
      text,
      sessionId: sessionId ?? undefined,
      ...(draftId ? { draftId } : {}),
      // Provider only applies to new conversations; resumed sessions are
      // pinned server-side to their original combo.
      // Only send a provider the server actually offers — a stale persisted
      // id (e.g. key removed server-side) falls back to the server default
      // instead of erroring with PROVIDER_UNAVAILABLE.
      providerId:
        sessionId || !providers.some((p) => p.id === selectedProviderId)
          ? undefined
          : selectedProviderId,
      attachments: hasAttachments
        ? attachments.map((a) => a.attachment)
        : undefined,
      // Measured per send, not once per session: the same tab can rotate,
      // move to an external display, or be installed as a PWA mid-conversation.
      client: detectClientEnvironment(),
    });
    setInput("");
    clearReview();
    // Ownership of the preview URLs transfers to the rendered user message
    // (revoked later by the chat store on clear/resume) — don't revoke here.
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachErrors([]);
  }

  function handleMicTap() {
    if (voiceMode === "dictate") {
      void dictation.stop(true);
    } else {
      // Defensive: blur composer so the keyboard never fights the mic sheet on Android
      textareaRef.current?.blur();
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
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  function handleVoiceAppend() {
    // Review text stays in place; the next capture appends to it on stop.
    void dictation.start();
  }

  function handleRecall() {
    if (lastPrompt && !input.trim()) {
      setInput(lastPrompt);
      setTimeout(() => textareaRef.current?.focus(), 50);
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
    input.trim() || reviewText.trim() || attachments.length > 0
  );
  // A send while a session is running is a follow-up (not blocked by streaming).
  const canSend = hasDraft && wsStatus === "connected";

  // Provider picker: locked to the pinned combo once a session is live.
  // Lock while streaming too: the first send of a new conversation pins the
  // provider server-side before session_info delivers the sessionId.
  const providerLocked = sessionId != null || isStreaming;
  const displayProviderId = providerLocked
    ? pinnedProviderId ?? selectedProviderId
    : selectedProviderId;
  const displayProvider = providers.find((p) => p.id === displayProviderId);
  // A session can be pinned to a profile the user has since hidden — it is gone
  // from the picker but still running the turn. Show its id rather than
  // claiming "Default model", which would name a different model than the one
  // actually answering.
  const displayProviderLabel =
    displayProvider?.label ?? displayProviderId ?? "Default model";
  const showProviderPicker = providers.length > 1;
  // What happens if the user sends into the currently-running session.
  const displayBackendId = displayProvider?.backendId;
  const followUpLive = displayBackendId
    ? backends[displayBackendId]?.capabilities.followUp ?? false
    : false;
  const followUpHint =
    isStreaming && sessionId
      ? followUpLive
        ? "Follows up live"
        : "Will queue"
      : null;

  return (
    <>
      {/* Dictation sheet */}
      <DictationSheet
        open={voiceMode === "dictate"}
        onStop={() => dictation.stop(true)}
        onCancel={() => dictation.cancel()}
      />

      <div className="px-4 pt-2 pb-4 md:px-6 md:pb-6">
        <div className="mx-auto max-w-3xl">
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

          {/* Rejected-file errors */}
          {attachErrors.length > 0 && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
              <div className="flex-1 space-y-0.5">
                {attachErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setAttachErrors([])}
                title="Dismiss"
                className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Image attachment preview strip */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <div key={i} className="relative h-16 w-16 shrink-0">
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    className="h-16 w-16 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    title="Remove"
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground shadow transition-colors hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            className={cn(
              "relative rounded-2xl border border-border bg-surface shadow-lg transition-all duration-200",
              "focus-within:border-primary/40 focus-within:shadow-[0_0_20px_rgba(224,159,62,0.05)]"
            )}
          >
            {/* Command palette */}
            {showCommandPalette && (
              <CommandPalette
                filter={input.slice(1)}
                onSelect={handleCommand}
              />
            )}

            {/* Hidden file inputs for the paperclip / camera buttons */}
            <input
              ref={libraryInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onFilePick}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={onFilePick}
            />

            {/* The textarea grows by CSS, not by JavaScript: the wrapper's
                ::after mirrors the value and sets the row height, so the
                composer never reads scrollHeight. That read forced a full
                document layout on every keystroke, and its cost scaled with
                the size of the transcript behind it. */}
            <div className="composer-grow" data-value={input + " "}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setPaletteDismissed(false);
                }}
                onPaste={(e) => {
                  const files = e.clipboardData?.files;
                  if (files && files.length > 0) {
                    const images = Array.from(files).filter((f) =>
                      f.type.startsWith("image/")
                    );
                    if (images.length > 0) {
                      e.preventDefault();
                      void addFiles(images);
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    if (showCommandPalette) return;
                    // On desktop (>=768px), Enter sends. On mobile, Enter inserts newline.
                    if (window.matchMedia("(min-width: 768px)").matches) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }
                  if (e.key === "ArrowUp" && !input.trim()) {
                    handleRecall();
                  }
                  if (e.key === "Escape") {
                    setPaletteDismissed(true);
                  }
                }}
                placeholder={
                  wsStatus !== "connected"
                    ? "Connecting..."
                    : uiConfig.composerPlaceholder
                }
                disabled={wsStatus !== "connected"}
                rows={1}
                className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="flex items-center justify-between px-4 pb-3">
              {/* Provider picker + hints */}
              <div className="flex min-w-0 items-center gap-3 text-[11px] text-muted-foreground/50">
                {showProviderPicker && (
                  <div ref={providerMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() =>
                        !providerLocked && setProviderMenuOpen((v) => !v)
                      }
                      disabled={providerLocked}
                      title={
                        providerLocked
                          ? "Provider is fixed for this conversation"
                          : "Choose model"
                      }
                      className={cn(
                        "flex max-w-[9rem] items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors md:max-w-[14rem]",
                        providerLocked
                          ? "cursor-default text-muted-foreground/60"
                          : "text-muted-foreground hover:bg-surface-raised hover:text-foreground"
                      )}
                    >
                      {providerLocked && (
                        <Lock className="h-3 w-3 shrink-0 opacity-70" />
                      )}
                      <span className="truncate">
                        {displayProviderLabel}
                      </span>
                      {!providerLocked && (
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                      )}
                    </button>
                    {providerMenuOpen && !providerLocked && (
                      <div
                        role="menu"
                        className="absolute bottom-full left-0 z-50 mb-1 min-w-[14rem] overflow-hidden rounded-xl border border-border bg-surface-overlay py-1 shadow-2xl"
                      >
                        {providers.map((p) => (
                          <button
                            key={p.id}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setSelectedProvider(p.id);
                              setProviderMenuOpen(false);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
                          >
                            <Check
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-primary",
                                p.id === selectedProviderId
                                  ? "opacity-100"
                                  : "opacity-0"
                              )}
                            />
                            <span className="truncate">{p.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {followUpHint ? (
                  <span className="text-primary/70">{followUpHint}</span>
                ) : (
                  <>
                    <span className="hidden sm:inline">
                      <span className="font-[family-name:var(--font-mono)]">/</span>{" "}
                      for commands
                    </span>
                    <span className="hidden md:inline">Shift+Enter for newline</span>
                  </>
                )}
              </div>

              {/* Attach + Recall + Mic + Send / Cancel */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => libraryInputRef.current?.click()}
                  disabled={isStreaming || wsStatus !== "connected"}
                  title="Attach images"
                  aria-label="Attach images"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={isStreaming || wsStatus !== "connected"}
                  title="Take a photo"
                  aria-label="Take a photo"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Camera className="h-4 w-4" />
                </button>
                {lastPrompt && !input.trim() && !isStreaming && (
                  <button
                    type="button"
                    onClick={handleRecall}
                    title="Recall last prompt"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-surface-raised hover:text-foreground"
                  >
                    <CornerLeftUp className="h-4 w-4" />
                  </button>
                )}
                <MicButton
                  active={voiceMode === "dictate"}
                  disabled={isStreaming || wsStatus !== "connected"}
                  onTap={handleMicTap}
                />
                {isStreaming && !hasDraft ? (
                  // Streaming with nothing drafted: the primary action is cancel.
                  <button
                    type="button"
                    onClick={handleCancel}
                    title="Stop the running turn"
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive text-primary-foreground transition-all duration-150"
                  >
                    <Square className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  // A draft always sends — as a new turn, or a follow-up when a
                  // session is already running.
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSend}
                    title={followUpHint ?? "Send"}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all duration-150 hover:brightness-110 disabled:opacity-30"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
