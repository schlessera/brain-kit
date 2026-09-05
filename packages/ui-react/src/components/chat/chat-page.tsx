import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowDown } from "lucide-react";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import type { AskUserAnnotation } from "@schlessera/brain-ui-sdk/protocol";
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
import { useChatCommands } from "./use-chat-commands.js";
import { getBackendUrl } from "../../lib/backend.js";
import {
  primeClientEnvironment,
  READING_COLUMN_ATTR,
} from "../../lib/client-environment.js";

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
      useChatStore.getState().resolveToolApproval(sessionId, toolUseId, approved);
      if (approved) {
        send({ type: "tool_approval", toolUseId, ...(always ? { always: true } : {}) });
      } else {
        send({ type: "tool_denial", toolUseId, message: "Denied by user" });
      }
    },
    [send, sessionId]
  );

  const handleAskUserSubmit = useCallback(
    (
      requestId: string,
      answers: Record<string, string>,
      annotations?: Record<string, AskUserAnnotation>
    ) => {
      useChatStore
        .getState()
        .submitAskUserAnswers(sessionId, requestId, answers, annotations);
      send({ type: "ask_user_response", requestId, answers, annotations });
    },
    [send, sessionId]
  );

  const handleAskUserCancel = useCallback(
    (requestId: string) => {
      useChatStore.getState().cancelAskUser(sessionId, requestId);
      send({ type: "ask_user_cancel", requestId, reason: "User dismissed" });
    },
    [send, sessionId]
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
            <div className="px-4 pt-3 md:px-6">
              <DigestCard />
            </div>
            <WelcomeState onAction={runCommand} />
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

      <Composer send={send} />
    </div>
  );
}
