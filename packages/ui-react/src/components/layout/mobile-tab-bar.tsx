import { useEffect, useRef, useState } from "react";
import {
  Brain,
  RefreshCw,
  History,
  SlidersHorizontal,
  FolderTree,
  SquarePen,
  MoreHorizontal,
} from "lucide-react";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";

export function MobileTabBar() {
  const toggleSessionPanel = useUIStore((s) => s.toggleSessionPanel);
  const toggleSyncPanel = useUIStore((s) => s.toggleSyncPanel);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSettingsPanel = useUIStore((s) => s.toggleSettingsPanel);
  const clearMessages = useChatStore((s) => s.clearMessages);

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

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 flex h-14 items-center justify-around border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)]">
      <TabIcon icon={Brain} label="Chat" active />
      <TabIcon
        icon={SquarePen}
        label="New chat"
        onClick={() => {
          setMoreOpen(false);
          clearMessages();
        }}
      />
      <TabIcon icon={FolderTree} label="Files" onClick={toggleFilePanel} />
      <div ref={moreRef} className="relative">
        <TabIcon
          icon={MoreHorizontal}
          label="More"
          active={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        />
        {moreOpen && (
          <div
            role="menu"
            className="absolute bottom-full right-0 z-50 mb-2 min-w-[10rem] overflow-hidden rounded-xl border border-border bg-surface-overlay py-1 shadow-2xl"
          >
            <MoreItem
              icon={RefreshCw}
              label="Sync"
              onClick={() => {
                setMoreOpen(false);
                toggleSyncPanel();
              }}
            />
            <MoreItem
              icon={History}
              label="History"
              onClick={() => {
                setMoreOpen(false);
                toggleSessionPanel();
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
      </div>
    </nav>
  );
}

function TabIcon({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Brain;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-0.5 px-2 py-1 text-[10px]",
        active ? "text-primary" : "text-muted-foreground"
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

function MoreItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Brain;
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
