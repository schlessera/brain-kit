import type { AskUserFormAnswers } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { ChevronUp } from "lucide-react";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import type { AskUserAnnotation } from "@schlessera/brain-ui-sdk/protocol";
import type { AnswerPayload } from "../../lib/answer-delivery/types.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useWebSocket } from "../../hooks/use-websocket.js";
import { MaskEditor } from "../images/mask-editor.js";
import { MessageBubble } from "./message-bubble.js";
import { WelcomeState } from "./welcome-state.js";
import { SessionDrawer } from "./session-drawer.js";
import { SubagentView } from "./subagent-view.js";
import { DigestCard } from "../activity/digest-card.js";
import { SettingsPanel } from "../settings/settings-panel.js";
import { StreamingPanel } from "../quick-actions/streaming-modal.js";
import { WhatsupPanel } from "../quick-actions/whatsup-modal.js";
import { SearchPanel } from "../quick-actions/search-modal.js";
import { AddPanel } from "../quick-actions/add-modal.js";
import { FilePanel } from "../files/file-panel.js";
import { Composer } from "./composer.js";
import { ChatComposerRow } from "./composer-row.js";
import { sendReask } from "./reask-send.js";
import { HandoffSheet } from "./handoff-sheet.js";
import { HandoffMarker } from "./handoff-links.js";
import { useHandoffStore, type HandoffLink } from "../../stores/handoff-store.js";
import { markerPosition } from "../../lib/handoff.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { useChatCommands } from "./use-chat-commands.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { DiscButton, DiscRow } from "@schlessera/brain-ui-kit";
import {
  primeClientEnvironment,
  READING_COLUMN_ATTR,
} from "../../lib/client-environment.js";

/**
 * How much of a long transcript is rendered at once, and how much more each
 * "show earlier" reveals.
 *
 * The transcript is the one part of this app with no natural size limit: a
 * resumed session can replay hundreds of messages, and every one of them is a
 * parsed markdown tree that the browser then has to lay out and keep. Rendering
 * a window instead bounds the DOM without a virtualiser — messages are wildly
 * variable in height, and estimating that is where virtualisers get scroll
 * position wrong.
 */
const WINDOW_SIZE = 40;

const NO_LINKS: HandoffLink[] = [];

/**
 * After how many messages a forward marker sits: after the turn where the
 * source stood when it was handed off, so it keeps its place as the source
 * continues; at the end when that is unknown.
 */
function markerAfter(link: HandoffLink, messages: readonly ChatMessage[]): number {
  return markerPosition(messages, link.afterTurns);
}
const WINDOW_STEP = 40;

/**
 * The chat surface: transcript, panels, and the composer.
 *
 * This component holds transcript-scale state only. The draft lives one level
 * down in <Composer>, so a keystroke never reaches the message list — see the
 * note there. Every callback handed to a message is wrapped in useCallback for
 * the same reason: MessageBubble is memoized, and an unstable prop would undo
 * that on the first re-render.
 */
export function ChatPage() {
  const root = useBrainUiRoot();
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const { send } = useWebSocket();

  const messages = useChatStore((s) => activeChat(s).messages);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setActiveSession = useChatStore((s) => s.setActiveSession);

  const sessionPanelOpen = useUIStore((s) => s.sessionPanelOpen);
  const setSessionPanelOpen = useUIStore((s) => s.setSessionPanelOpen);
  const subagentStack = useUIStore((s) => s.subagentStack);
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

  const runCommand = useChatCommands();
  // The phone Search disc is drawn only below `tablet:` (480px), where no
  // rail carries Search (D52 §8).
  const phone = !useMediaQuery("(min-width: 480px)");
  // The welcome briefing chip's printed reason, the same one the palette and
  // More print: offline first, then a running turn.
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const briefingWhy = !connected ? "needs the host" : isStreaming ? "a turn is running" : undefined;

  // Handoff links (#61): the session list carries them; refresh them when
  // a stored session comes into view, so its card and markers can draw.
  const forward = useHandoffStore((s) => (sessionId ? s.forward[sessionId] : undefined)) ?? NO_LINKS;
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    root.api.sessions().then((data) => { if (live) root.stores.handoff.getState().setLinks(data.sessions); }, () => {});
    return () => { live = false; };
  }, [sessionId, root]);

  // Only the tail of a long transcript is rendered; the rest is one tap away.
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE);
  // Switching sessions starts a fresh window. Adjusted during render rather
  // than in an effect, so the new session never paints with the old window.
  const [windowedSession, setWindowedSession] = useState(sessionId);
  if (windowedSession !== sessionId) {
    setWindowedSession(sessionId);
    setVisibleCount(WINDOW_SIZE);
  }
  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // Revealing earlier messages prepends content, which would otherwise shove
  // the view down by the height of everything added. Remember the distance to
  // the BOTTOM across the change and restore it, so the message the user was
  // reading stays where it was.
  const scrollAnchorRef = useRef<number | null>(null);
  const showEarlier = useCallback(() => {
    const el = scrollRef.current;
    scrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setVisibleCount((n) => n + WINDOW_STEP);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchorRef.current;
    if (el && anchor !== null) {
      el.scrollTop = el.scrollHeight - anchor;
      scrollAnchorRef.current = null;
    }
  });

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

  const handleToolApproval = useCallback(
    (toolUseId: string, approved: boolean, always?: boolean) => {
      root.stores.chat.getState().resolveToolApproval(sessionId, toolUseId, approved);
      // The transcript's approval card is the only caller: channel "card" (#113).
      if (approved) {
        send({ type: "tool_approval", toolUseId, ...(always ? { always: true } : {}), channel: "card" });
      } else {
        send({ type: "tool_denial", toolUseId, message: "Denied by user", channel: "card" });
      }
    },
    [send, sessionId, root]
  );

  /**
   * Every ask answer goes to the answer queue (#910), never straight to the
   * socket: it is saved on this device first, and the card says "answered"
   * only when the host's receipt does. The binding is the exchange's own:
   * this session, and the turn its request frame named.
   */
  const submitAnswer = useCallback(
    (requestId: string, payload: AnswerPayload) => {
      const chat = root.stores.chat.getState();
      const buffer = sessionId === null ? chat.draft : chat.buffers[sessionId];
      const exchange = buffer?.messages
        .flatMap((m) => m.askUserExchanges ?? [])
        .find((e) => e.requestId === requestId);
      void root.answers.submit({
        requestId,
        sessionId,
        ...(exchange?.turnId ? { turnId: exchange.turnId } : {}),
        payload,
      });
    },
    [sessionId, root]
  );

  const handleAskUserSubmit = useCallback(
    (
      requestId: string,
      answers: Record<string, string>,
      annotations?: Record<string, AskUserAnnotation>
    ) => submitAnswer(requestId, { kind: "ask_user", answers, ...(annotations ? { annotations } : {}) }),
    [submitAnswer]
  );

  const handleAskUserListSubmit = useCallback(
    (requestId: string, answers: Record<string, string>, notes?: Record<string, string>) =>
      submitAnswer(requestId, { kind: "ask_user_list", answers, ...(notes ? { notes } : {}) }),
    [submitAnswer]
  );

  const handleAskUserRankSubmit = useCallback(
    (requestId: string, order: string[], unchanged: boolean) =>
      submitAnswer(requestId, { kind: "ask_user_rank", order, unchanged }),
    [submitAnswer]
  );

  const handleAskUserFormSubmit = useCallback(
    (requestId: string, answers: AskUserFormAnswers, visibleNodes: string[]) =>
      submitAnswer(requestId, { kind: "ask_user_form", answers, visibleNodes }),
    [submitAnswer]
  );

  const handleAskUserCancel = useCallback(
    (requestId: string) => {
      root.stores.chat.getState().cancelAskUser(sessionId, requestId);
      root.answers.dismissed(requestId);
      send({ type: "ask_user_cancel", requestId, reason: "User dismissed" });
    },
    [send, sessionId, root]
  );

  /** A dismissed question asked again (seventh drop, ruling 7). */
  const handleAskUserReask = useCallback(
    (text: string) => sendReask(root.stores, sessionId, text, send),
    [send, sessionId, root]
  );

  const handleSessionResume = useCallback(
    (resumeSessionId: string) => {
      clearMessages();
      setActiveSession(resumeSessionId);
      send({ type: "session_resume", sessionId: resumeSessionId });
    },
    [send, clearMessages, setActiveSession]
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Mask editor: modal, mounted here because it answers over the socket
          this page owns. Renders nothing unless the agent has asked. */}
      <MaskEditor
        onSubmit={(requestId, maskPng) => send({ type: "mask_response", requestId, maskPng })}
        onCancel={(requestId, message) =>
          send({ type: "mask_error", requestId, code: "cancelled", message })
        }
      />

      {/* Subagent drill-in: an overlay stack — chat is the residence, the
          drill-in opens over it and backs out level by level. */}
      {subagentStack.length > 0 && (
        <div className="fixed inset-0 z-40 bg-background">
          <SubagentView
            spanId={subagentStack[subagentStack.length - 1]!}
            onApproval={handleToolApproval}
          />
        </div>
      )}

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
        endpoint="/api/brain/sync"
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

      {/* Message area. A size container, so the transcript can tell whether
          its reading column clears the New chat disc (below). */}
      <div className="@container relative flex-1 overflow-hidden">
        {/* New chat is the Chat header's primary action (D37): a tab is a
            place and starting a chat is an act, so it is neither a rail row
            nor a bar slot. It only appears once there is a conversation to
            leave. Drawn over the transcript rather than in a row above it, so
            the transcript keeps that height (#93), and first in the area so
            Tab reaches it before the messages.

            The kit's overlay disc (D52 §7): a 32px paint in a 44px button
            that reaches 12px left and 6px up and down, and not right, so it
            never sits over a classic scrollbar. Ink at rest as the primary
            act; hover and keyboard focus open the pill leftward. There is no
            confirmation: every session keeps its own draft (D52 §5).

            Below 480 the phone Search disc sits left of it, muted as the
            secondary act, so Search is one tap from occupied Chat (D52 §2).
            It comes first in DOM and tab order. The row is right-anchored,
            so New chat's pill pushes Search leftward and never covers it.
            The empty chat has its Search chip instead. */}
        {hasMessages && (
          <DiscRow label="Chat actions" style={{ position: "absolute", right: 16, top: 10, zIndex: 10 }}>
            {phone && (
              <DiscButton name="Search the brain" icon="search" tone="mute" label="Search" onClick={() => runCommand("search")} />
            )}
            <DiscButton name="New chat" icon="compose" tone="ink" label="New chat" onClick={clearMessages} />
          </DiscRow>
        )}
        {messages.length === 0 ? (
          <div className="h-full overflow-y-auto">
            <div className="px-4 pt-3 md:px-6">
              <DigestCard />
            </div>
            <WelcomeState onAction={runCommand} briefingWhy={briefingWhy} />
          </div>
        ) : (
          // The top padding keeps the resting first message's text below the
          // New chat target (54px down; a message pads its own 16px). From
          // 888px the 768px column is centred clear of the target's 60px, so
          // the padding goes. It scrolls away with the content either way.
          <div ref={scrollRef} className="h-full overflow-y-auto px-4 pt-10 md:px-6 @min-[888px]:pt-0">
            {/* Tagged so the client-environment probe reports the width text
                actually renders into, not the whole window. */}
            <div
              {...{ [READING_COLUMN_ATTR]: "" }}
              className="mx-auto max-w-3xl divide-y divide-border/20"
            >
              {hiddenCount > 0 && (
                <div className="flex justify-center py-3">
                  <button
                    type="button"
                    onClick={showEarlier}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                    Show {Math.min(hiddenCount, WINDOW_STEP)} earlier message
                    {Math.min(hiddenCount, WINDOW_STEP) === 1 ? "" : "s"}
                    <span className="text-muted-foreground/50">
                      ({hiddenCount} hidden)
                    </span>
                  </button>
                </div>
              )}
              {visibleMessages.map((msg, index) => (
                <Fragment key={msg.id}>
                  <MessageBubble
                    message={msg}
                    onToolApproval={handleToolApproval}
                    onAskUserSubmit={handleAskUserSubmit}
                    onAskUserCancel={handleAskUserCancel}
                    onAskUserReask={handleAskUserReask}
                    onAskUserListSubmit={handleAskUserListSubmit}
                    onAskUserRankSubmit={handleAskUserRankSubmit}
                    onAskUserFormSubmit={handleAskUserFormSubmit}
                    closing={msg === messages[messages.length - 1]}
                  />
                  {/* Where this conversation was continued elsewhere (#61). */}
                  {forward
                    .filter((link) => markerAfter(link, messages) === hiddenCount + index + 1)
                    .map((link) => <HandoffMarker key={link.sessionId} sessionId={link.sessionId} backendId={link.backendId} title={link.title} />)}
                </Fragment>
              ))}
            </div>
          </div>
        )}

        {/* The paint stays 16px above the area's bottom (D52 §3); its 44px
            box reaches 6px past it on every side. */}
        {showScrollButton && (
          <DiscButton
            name="Scroll to latest"
            icon="latest"
            anchor="center"
            onClick={scrollToBottom}
            style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)" }}
          />
        )}
      </div>

      <HandoffSheet />
      <ChatComposerRow />
      <Composer send={send} />
    </div>
  );
}
