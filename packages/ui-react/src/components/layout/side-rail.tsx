import { SideRail as KitSideRail, type RailItem } from "@schlessera/brain-ui-kit";
import { useEffect } from "react";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { useChatStore, pendingApprovals } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";

/**
 * The desktop navigation, on the kit's `SideRail`. The kit owns the rail —
 * the one roving tab stop, the amber destination, the badge, the collapsed
 * and expanded widths; this file owns what the destinations DO, which of
 * them is "here", and the ⌘1–⌘5 keys the design prints beside them (D36:
 * anything global takes a modifier).
 *
 * The five destinations are the design's (D37): Chat · Actions · Files ·
 * Graph · Settings, the same five and the same order as the phone bar.
 * Activity is not among them — "what needs me" and "what has been happening"
 * are two lenses on one queue, so the Actions pane carries a filter and the
 * badge counts what needs you: pending approvals plus the inbox. The acts
 * the old rail carried (New chat, Sessions, Sync, the briefing) live in the
 * ⌘K palette and the Chat header.
 *
 * Widths follow D22's ladder: collapsed to the 60px icon rail below 900px,
 * expanded from 900px up. The rail appears at the same `md` breakpoint the
 * phone bar disappears at, so the two never show together.
 *
 * The connection status takes the wordmark's line: teal while live, amber
 * while reconnecting, red when the socket is gone. No spend meter — the app
 * tracks no spend — and the ⌘K cap is real, because the palette is.
 */
export function SideRail() {
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const filePanelOpen = useUIStore((s) => s.filePanelOpen);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSettingsPanel = useUIStore((s) => s.toggleSettingsPanel);
  const inboxCount = useActivityStore((s) => s.inbox.length);
  const approvalCount = useChatStore((s) => pendingApprovals(s).length);
  const needsYou = inboxCount + approvalCount;
  const expanded = useMediaQuery("(min-width: 900px)");

  const items: RailItem[] = [
    { icon: "brain", label: "Chat", shortcut: "⌘1", onClick: () => setActiveView("chat") },
    {
      icon: "resolved",
      label: "Actions",
      shortcut: "⌘2",
      badge: needsYou > 0 ? (needsYou > 9 ? "9+" : String(needsYou)) : undefined,
      onClick: () => setActiveView("activity"),
    },
    { icon: "files", label: "Files", shortcut: "⌘3", onClick: toggleFilePanel },
    { icon: "graph", label: "Graph", shortcut: "⌘4", onClick: () => setActiveView("graph") },
    { icon: "settings", label: "Settings", shortcut: "⌘5", onClick: toggleSettingsPanel },
  ];

  // A panel over the view is "here" while it is open; otherwise the view is.
  const active = filePanelOpen ? 2 : settingsPanelOpen ? 4 : activeView === "chat" ? 0 : activeView === "activity" ? 1 : 3;

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > items.length) return;
      e.preventDefault();
      items[n - 1]!.onClick?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <nav aria-label="Primary" className="hidden md:flex shrink-0">
      <KitSideRail
        items={items}
        active={active}
        expanded={expanded}
        status={wsStatus === "connected" ? "live" : wsStatus === "connecting" ? "reconnecting" : "offline"}
        statusTone={wsStatus === "connected" ? "teal" : wsStatus === "connecting" ? "amber" : "red"}
        spendPct={null}
        hint="Command palette"
      />
    </nav>
  );
}
