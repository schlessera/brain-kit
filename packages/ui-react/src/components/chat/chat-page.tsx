import { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  ArrowDown,
  Square,
  CornerLeftUp,
  Paperclip,
  Camera,
  X,
  Check,
  ChevronDown,
  Lock,
} from "lucide-react";
import {
  useChatStore,
  activeChat,
  type MessageAttachment,
} from "../../stores/chat-store.js";
import type { MessageSource, AskUserAnnotation } from "@schlessera/brain-ui-sdk/protocol";
import { uiConfig } from "../../config.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useWebSocket } from "../../hooks/use-websocket.js";
import {
  fileToAttachment,
  validateAttachments,
  type PendingAttachment,
} from "../../lib/image-attachments.js";
import { MessageBubble } from "./message-bubble.js";
import { WelcomeState } from "./welcome-state.js";
import { CommandPalette } from "./command-palette.js";
import { SessionDrawer } from "./session-drawer.js";
import { SettingsPanel } from "../settings/settings-panel.js";
import { StreamingPanel } from "../quick-actions/streaming-modal.js";
import { WhatsupPanel } from "../quick-actions/whatsup-modal.js";
import { SearchPanel } from "../quick-actions/search-modal.js";
import { AddPanel } from "../quick-actions/add-modal.js";
import { FilePanel } from "../files/file-panel.js";
import { MicButton } from "../voice/mic-button.js";
import { DictationSheet } from "../voice/dictation-sheet.js";
import { ReviewCard } from "../voice/review-card.js";
import { useDictation } from "../../voice/use-dictation.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { api } from "../../lib/api-client.js";
import { getBackendUrl } from "../../lib/backend.js";
import {
  detectClientEnvironment,
  primeClientEnvironment,
  READING_COLUMN_ATTR,
} from "../../lib/client-environment.js";
import { cn } from "../../lib/utils.js";

export function ChatPage() {
  const [input, setInput] = useState("");
  const [lastPrompt, setLastPrompt] = useState("");
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { send } = useWebSocket();

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

  const messages = useChatStore((s) => activeChat(s).messages);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  // Key-bound buffer actions: this page always operates on the buffer in view
  // (the active session, or the draft when no session is bound yet).
  const startAssistantMessage = () =>
    useChatStore.getState().startAssistantMessage(sessionId);
  const addUserMessage = (
    text: string,
    source?: MessageSource,
    atts?: MessageAttachment[]
  ) => useChatStore.getState().addUserMessage(sessionId, text, source, atts);
  const resolveToolApproval = (toolUseId: string, approved: boolean) =>
    useChatStore.getState().resolveToolApproval(sessionId, toolUseId, approved);
  const submitAskUserAnswers = (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) =>
    useChatStore.getState().submitAskUserAnswers(sessionId, requestId, answers, annotations);
  const cancelAskUser = (requestId: string) =>
    useChatStore.getState().cancelAskUser(sessionId, requestId);
  const appendText = (text: string) =>
    useChatStore.getState().appendText(sessionId, text);
  const finishAssistantMessage = () =>
    useChatStore.getState().finishAssistantMessage(sessionId);
  const wsStatus = useConnectionStore((s) => s.wsStatus);

  const providers = useProviderStore((s) => s.available);
  const selectedProviderId = useProviderStore((s) => s.selectedId);
  const pinnedProviderId = useProviderStore((s) => s.pinnedId);
  const setSelectedProvider = useProviderStore((s) => s.setSelected);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const backends = useProviderStore((s) => s.backends);

  const sessionPanelOpen = useUIStore((s) => s.sessionPanelOpen);
  const setSessionPanelOpen = useUIStore((s) => s.setSessionPanelOpen);
  const syncPanelOpen = useUIStore((s) => s.syncPanelOpen);
  const setSyncPanelOpen = useUIStore((s) => s.setSyncPanelOpen);
  const whatsupPanelOpen = useUIStore((s) => s.whatsupPanelOpen);
  const setWhatsupPanelOpen = useUIStore((s) => s.setWhatsupPanelOpen);
  const searchPanelOpen = useUIStore((s) => s.searchPanelOpen);
  const setSearchPanelOpen = useUIStore((s) => s.setSearchPanelOpen);
  const addPanelOpen = useUIStore((s) => s.addPanelOpen);
  const setAddPanelOpen = useUIStore((s) => s.setAddPanelOpen);
  const filePanelOpen = useUIStore((s) => s.filePanelOpen);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const setSettingsPanelOpen = useUIStore((s) => s.setSettingsPanelOpen);

  // Voice dictation state
  const voiceMode = useVoiceStore((s) => s.mode);
  const reviewText = useVoiceStore((s) => s.reviewText);
  const clearReview = useVoiceStore((s) => s.clearReview);
  const dictation = useDictation();

  // Auto-scroll on new content when tailing is active
  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Probe the device inventory once on mount so the FIRST message already
  // carries the camera/microphone facts (enumerateDevices is async).
  useEffect(() => {
    void primeClientEnvironment();
  }, []);

  // Scroll listener: disable tailing when user scrolls up, re-enable at bottom
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
      autoScrollRef.current = atBottom;
      setShowScrollButton(!atBottom);
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [hasMessages]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [input]);

  // Show/hide command palette based on input
  useEffect(() => {
    if (input.startsWith("/")) {
      setShowCommandPalette(true);
    } else {
      setShowCommandPalette(false);
    }
  }, [input]);

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
    addUserMessage(
      text,
      reviewText.trim() ? "voice-dictate" : "typed",
      messageAttachments.length > 0 ? messageAttachments : undefined
    );
    // A send while the session is already streaming is a follow-up — the server
    // queues it or delivers it live; don't pre-start a second assistant bubble
    // (the backend's next frames start it).
    if (!isStreaming) startAssistantMessage();
    send({
      type: "chat_message",
      text,
      sessionId: sessionId ?? undefined,
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

  function handleToolApproval(toolUseId: string, approved: boolean) {
    resolveToolApproval(toolUseId, approved);
    if (approved) {
      send({ type: "tool_approval", toolUseId });
    } else {
      send({ type: "tool_denial", toolUseId, message: "Denied by user" });
    }
  }

  function handleAskUserSubmit(
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) {
    submitAskUserAnswers(requestId, answers, annotations);
    send({ type: "ask_user_response", requestId, answers, annotations });
  }

  function handleAskUserCancel(requestId: string) {
    cancelAskUser(requestId);
    send({ type: "ask_user_cancel", requestId, reason: "User dismissed" });
  }

  function handleSessionResume(resumeSessionId: string) {
    clearMessages();
    setActiveSession(resumeSessionId);
    send({ type: "session_resume", sessionId: resumeSessionId });
  }

  function handleCommand(command: string) {
    setInput("");
    setShowCommandPalette(false);

    // Search and add talk to the brain CLI over REST, not to the agent — they
    // stay available while a turn streams or the socket is down.
    switch (command) {
      case "search":
        setSearchPanelOpen(true);
        return;
      case "add":
        setAddPanelOpen(true);
        return;
    }

    const disabled = wsStatus !== "connected" || isStreaming;
    if (disabled) return;

    switch (command) {
      case "sync":
        setSyncPanelOpen(true);
        break;
      case "whatsup":
        setWhatsupPanelOpen(true);
        break;
      case "stats":
        runStatsAction();
        break;
    }
  }

  async function runStatsAction() {
    addUserMessage("Stats");
    startAssistantMessage();
    try {
      const stats = await api.brainStats();
      const result = [
        `**Brain Statistics**`,
        `- Documents: ${stats.documents}`,
        `- Tags: ${stats.tags}`,
        `- Links: ${stats.links}`,
        ``,
        `**By Type:** ${Object.entries(stats.byType)
          .sort(([, a], [, b]) => b - a)
          .map(([t, n]) => `${t} (${n})`)
          .join(", ")}`,
        ``,
        `**By Status:** ${Object.entries(stats.byStatus)
          .map(([s, n]) => `${s} (${n})`)
          .join(", ")}`,
      ].join("\n");
      appendText(result);
    } catch (err) {
      appendText(
        `**Error:** ${err instanceof Error ? err.message : "Action failed"}`
      );
    } finally {
      finishAssistantMessage();
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  }

  function handleWelcomeAction(action: string) {
    handleCommand(action);
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
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Panels */}
      <SessionDrawer
        open={sessionPanelOpen}
        onClose={() => setSessionPanelOpen(false)}
        onResume={handleSessionResume}
      />
      <SettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />
      <StreamingPanel
        open={syncPanelOpen}
        onClose={() => setSyncPanelOpen(false)}
        title="Brain Sync"
        endpoint={getBackendUrl("/api/brain/sync")}
      />
      <WhatsupPanel
        open={whatsupPanelOpen}
        onClose={() => setWhatsupPanelOpen(false)}
      />
      <SearchPanel
        open={searchPanelOpen}
        onClose={() => setSearchPanelOpen(false)}
      />
      <AddPanel
        open={addPanelOpen}
        onClose={() => setAddPanelOpen(false)}
      />
      <FilePanel
        open={filePanelOpen}
        onClose={() => setFilePanelOpen(false)}
      />

      {/* Message area */}
      <div className="relative flex-1 overflow-hidden">
        {messages.length === 0 ? (
          <div className="h-full overflow-y-auto">
            <WelcomeState onAction={handleWelcomeAction} />
          </div>
        ) : (
          <div ref={scrollRef} className="h-full overflow-y-auto px-4 md:px-6">
            {/* Tagged so the client-environment probe reports the width text
                actually renders into, not the whole window. */}
            <div
              {...{ [READING_COLUMN_ATTR]: "" }}
              className="mx-auto max-w-3xl divide-y divide-border/20"
            >
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onToolApproval={handleToolApproval}
                  onAskUserSubmit={handleAskUserSubmit}
                  onAskUserCancel={handleAskUserCancel}
                />
              ))}
            </div>
          </div>
        )}

        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            title="Scroll to bottom"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface shadow-md text-muted-foreground transition-all duration-150 hover:text-foreground"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Dictation sheet */}
      <DictationSheet
        open={voiceMode === "dictate"}
        onStop={() => dictation.stop(true)}
        onCancel={() => dictation.cancel()}
      />

      {/* Input composer */}
      <div className="px-4 pt-2 pb-4 md:px-6 md:pb-6">
        <div className="mx-auto max-w-3xl">
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

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
                  setShowCommandPalette(false);
                }
              }}
              placeholder={
                wsStatus !== "connected"
                  ? "Connecting..."
                  : uiConfig.composerPlaceholder
              }
              disabled={wsStatus !== "connected"}
              rows={1}
              className="w-full resize-none bg-transparent px-5 py-4 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-50"
              style={{ minHeight: "56px", maxHeight: "200px" }}
            />

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
    </div>
  );
}
