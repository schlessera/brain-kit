import { useEffect, useRef, useState } from "react";
import { BottomSheet, ListRow, TabBar, type TabItem } from "@schlessera/brain-ui-kit";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat, pendingApprovals } from "../../stores/chat-store.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useChatCommands } from "../chat/use-chat-commands.js";

/**
 * The phone's bottom navigation, on the kit's `TabBar`. The five slots are
 * the desktop rail's five destinations with Settings folded into More (D37):
 * Chat · Actions · Files · Graph · More. Six into five does not go, and the
 * one you live in least is the one to fold — never one of the four you live
 * in. New chat is not a slot: a tab is a place and starting a chat is an
 * act, so it is the Chat header's primary action and a ⌘K command.
 *
 * More is the kit `BottomSheet`, docked over a scrim, holding Settings and
 * the acts — Sessions, Sync, Daily briefing, Brain statistics — as kit
 * `ListRow`s. The sheet is a sibling of the bar rather than a child of the
 * More slot, because a kit tab is a leaf and cannot host it.
 */
export function MobileTabBar() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const setSessionPanelOpen = useUIStore((s) => s.setSessionPanelOpen);
  const setSettingsPanelOpen = useUIStore((s) => s.setSettingsPanelOpen);
  const inboxCount = useActivityStore((s) => s.inbox.length);
  const approvalCount = useChatStore((s) => pendingApprovals(s).length);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const runCommand = useChatCommands();
  const needsYou = inboxCount + approvalCount;

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("keydown", onKey);
    // The sheet's first row takes focus; the More slot gets it back on close.
    moreRef.current?.querySelector<HTMLElement>('[role="button"]')?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  /** An act from the sheet: close it, land on chat, run. */
  function act(fn: () => void) {
    return () => {
      setMoreOpen(false);
      setActiveView("chat");
      fn();
    };
  }

  const items: TabItem[] = [
    { icon: "brain", label: "Chat", onClick: () => setActiveView("chat") },
    {
      icon: "resolved",
      label: "Actions",
      badge: needsYou > 0 ? (needsYou > 9 ? "9+" : String(needsYou)) : undefined,
      onClick: () => setActiveView("activity"),
    },
    { icon: "files", label: "Files", onClick: toggleFilePanel },
    { icon: "graph", label: "Graph", onClick: () => setActiveView("graph") },
    { icon: "more", label: "More", onClick: () => setMoreOpen((v) => !v) },
  ];
  // The amber slot. -1 is "none", which the kit renders as no active item
  // and still keeps the bar reachable (its stop falls back to the first
  // eligible slot).
  const active = moreOpen ? 4 : activeView === "chat" ? 0 : activeView === "activity" ? 1 : activeView === "graph" ? 3 : -1;
  const quiet = connected && !isStreaming;

  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 pb-[env(safe-area-inset-bottom)]"
      // The safe-area strip below the bar takes the bar's own ground, from the
      // kit's token so it follows the theme.
      style={{ background: "var(--bk-color-surface)" }}
    >
      {moreOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMoreOpen(false);
          }}
        >
          <div ref={moreRef} role="dialog" aria-label="More" className="absolute inset-x-0 bottom-0">
            <BottomSheet title="More" subtitle="Settings, and the things you run rather than visit." docked>
              <div className="flex flex-col">
                <ListRow variant="group" icon="settings" iconTone="neutral" title="Settings" chevron onClick={() => { setMoreOpen(false); setSettingsPanelOpen(true); }} />
                <ListRow variant="group" icon="history" iconTone="blue" title="Sessions" subtitle="Resume an earlier conversation" chevron onClick={act(() => setSessionPanelOpen(true))} />
                <ListRow variant="group" icon="repeat" iconTone="amber" title="Sync the brain" subtitle={quiet ? "Pull and push the repository" : "needs the host"} value={quiet ? "sync" : undefined} valueTone="amber" onClick={quiet ? act(() => runCommand("sync")) : undefined} />
                <ListRow variant="group" icon="sunrise" iconTone="gold" title="Daily briefing" subtitle={quiet ? "What happened since you looked" : "needs the host"} onClick={quiet ? act(() => runCommand("whatsup")) : undefined} />
                <ListRow variant="group" icon="ledger" iconTone="neutral" title="Brain statistics" subtitle={quiet ? "Documents, tags and links" : "needs the host"} last onClick={quiet ? act(() => runCommand("stats")) : undefined} />
              </div>
            </BottomSheet>
          </div>
        </div>
      )}
      <TabBar items={items} active={active} />
    </nav>
  );
}
