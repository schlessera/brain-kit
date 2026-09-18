import { useEffect, useRef, useState } from "react";
import { TabBar, type TabItem } from "@schlessera/brain-ui-kit";
import {
  RefreshCw,
  History,
  SlidersHorizontal,
  Waypoints,
} from "lucide-react";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useActivityStore } from "../../stores/activity-store.js";

/**
 * The phone's bottom navigation, on the kit's `TabBar` (S5: the first kit
 * consumer in the app). Five slots, as the design draws them: Chat, New chat,
 * Activity (with the inbox count), Files, More. The kit owns the bar — the
 * roving tab stop, the amber active slot, the badge, the hit targets; this
 * file owns what the slots DO and the More menu, which is app behaviour the
 * kit has no component for.
 *
 * The menu is a sibling of the bar, anchored above its right edge, rather
 * than a child of the More slot: a kit tab is a leaf and cannot host it.
 */
export function MobileTabBar() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const toggleSessionPanel = useUIStore((s) => s.toggleSessionPanel);
  const toggleSyncPanel = useUIStore((s) => s.toggleSyncPanel);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSettingsPanel = useUIStore((s) => s.toggleSettingsPanel);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const inboxCount = useActivityStore((s) => s.inbox.length);

  /** Chat-scoped panels live in the chat page — surface it before opening them. */
  function inChat(toggle: () => void) {
    return () => {
      if (activeView !== "chat") setActiveView("chat");
      toggle();
    };
  }

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const items: TabItem[] = [
    { icon: "brain", label: "Chat", onClick: () => setActiveView("chat") },
    {
      icon: "compose",
      label: "New chat",
      onClick: () => {
        setMoreOpen(false);
        setActiveView("chat");
        clearMessages();
      },
    },
    // Activity holds the tab-bar slot; Graph moved into the More menu — the
    // phone glance-check ("is real work happening?") is the headline flow
    // and must stay one tap away (planning decision).
    {
      icon: "activity",
      label: "Activity",
      badge: inboxCount > 0 ? (inboxCount > 9 ? "9+" : String(inboxCount)) : undefined,
      onClick: () => setActiveView("activity"),
    },
    { icon: "files", label: "Files", onClick: toggleFilePanel },
    { icon: "more", label: "More", onClick: () => setMoreOpen((v) => !v) },
  ];
  // The amber slot. -1 is "none", which the kit renders as no active item
  // and still keeps the bar reachable (its stop falls back to the first
  // eligible slot).
  const active = moreOpen ? 4 : activeView === "chat" ? 0 : activeView === "activity" ? 2 : -1;

  return (
    <nav
      ref={moreRef}
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 pb-[env(safe-area-inset-bottom)]"
      // The safe-area strip below the bar takes the bar's own ground, from the
      // kit's token so it follows the theme.
      style={{ background: "var(--bk-color-surface)" }}
    >
      <TabBar items={items} active={active} />
      {moreOpen && (
        <div
          role="menu"
          className="absolute bottom-full right-2 z-50 mb-2 min-w-[10rem] overflow-hidden rounded-xl border border-border bg-surface-overlay py-1 shadow-2xl"
        >
          <MoreItem
            icon={Waypoints}
            label="Graph"
            onClick={() => {
              setMoreOpen(false);
              setActiveView("graph");
            }}
          />
          <MoreItem
            icon={RefreshCw}
            label="Sync"
            onClick={() => {
              setMoreOpen(false);
              inChat(toggleSyncPanel)();
            }}
          />
          <MoreItem
            icon={History}
            label="History"
            onClick={() => {
              setMoreOpen(false);
              inChat(toggleSessionPanel)();
            }}
          />
          <MoreItem
            icon={SlidersHorizontal}
            label="Settings"
            onClick={() => {
              setMoreOpen(false);
              toggleSettingsPanel();
            }}
          />
        </div>
      )}
    </nav>
  );
}

function MoreItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Waypoints;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      {label}
    </button>
  );
}
