import { SideRail as KitSideRail, type RailItem } from "@schlessera/brain-ui-kit";
import { useEffect } from "react";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";

/**
 * The desktop navigation, on the kit's `SideRail` (S7, the last of the
 * `layout` directory). The kit owns the rail — the one roving tab stop, the
 * amber destination, the badge, the collapsed and expanded widths; this file
 * owns what the destinations DO, which of them is "here", and the ⌘1–⌘5
 * keys the design prints beside them (D36: anything global takes a
 * modifier).
 *
 * Five destinations, as the design draws them and as the phone's bar
 * already chose: Chat, Activity (with the inbox count), Files, Graph and
 * Settings. The old rail also carried New chat, Sync, Whatsup and Sessions;
 * those are actions rather than places, and on desktop they live in the ⌘K
 * palette (`DesktopPalette`), which is where D22 puts anything that is not
 * one of the rail's five.
 *
 * Widths follow D22's ladder: collapsed to the 60px icon rail below 900px,
 * expanded from 900px up. The rail appears at the same `md` breakpoint the
 * phone bar disappears at, so the two never show together; moving that
 * boundary to the ladder's 480px is a shell-wide change (every pane keys on
 * `md:`) and waits for the desktop screens the design has not drawn yet.
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
  const expanded = useMediaQuery("(min-width: 900px)");

  const items: RailItem[] = [
    { icon: "brain", label: "Chat", shortcut: "⌘1", onClick: () => setActiveView("chat") },
    {
      icon: "activity",
      label: "Activity",
      shortcut: "⌘2",
      badge: inboxCount > 0 ? (inboxCount > 9 ? "9+" : String(inboxCount)) : undefined,
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
