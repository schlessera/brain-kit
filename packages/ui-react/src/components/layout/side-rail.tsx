import {
  Activity,
  Brain,
  RefreshCw,
  Newspaper,
  History,
  SlidersHorizontal,
  SquarePen,
  FolderTree,
  Waypoints,
} from "lucide-react";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";
import { CountBadge } from "../activity/span-bits.js";

export function SideRail() {
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const toggleSessionPanel = useUIStore((s) => s.toggleSessionPanel);
  const toggleSyncPanel = useUIStore((s) => s.toggleSyncPanel);
  const toggleWhatsupPanel = useUIStore((s) => s.toggleWhatsupPanel);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSettingsPanel = useUIStore((s) => s.toggleSettingsPanel);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const hasMessages = useChatStore((s) => activeChat(s).messages.length > 0);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const inboxCount = useActivityStore((s) => s.inbox.length);

  /** Chat-scoped panels live in the chat page — surface it before opening them. */
  function inChat(toggle: () => void) {
    return () => {
      if (activeView !== "chat") setActiveView("chat");
      toggle();
    };
  }

  return (
    <nav className="hidden md:flex w-16 shrink-0 flex-col items-center border-r border-border bg-surface py-4 gap-1">
      {/* Logo */}
      <div className="mb-4">
        <Brain className="h-7 w-7 text-primary" />
      </div>

      {/* New chat */}
      {hasMessages && (
        <RailButton
          icon={SquarePen}
          label="New chat"
          onClick={clearMessages}
        />
      )}

      {/* Divider */}
      <div className="my-2 h-px w-8 bg-border" />

      {/* Quick actions */}
      <RailButton
        icon={RefreshCw}
        label="Sync"
        onClick={inChat(toggleSyncPanel)}
        disabled={isStreaming}
      />
      <RailButton
        icon={Newspaper}
        label="Whatsup"
        onClick={inChat(toggleWhatsupPanel)}
        disabled={isStreaming}
      />
      <RailButton
        icon={FolderTree}
        label="Files"
        onClick={toggleFilePanel}
      />
      <RailButton
        icon={Waypoints}
        label="Graph"
        active={activeView === "graph"}
        onClick={() =>
          setActiveView(activeView === "graph" ? "chat" : "graph")
        }
      />
      <RailButton
        icon={Activity}
        label="Activity"
        active={activeView === "activity"}
        badge={inboxCount}
        onClick={() =>
          setActiveView(activeView === "activity" ? "chat" : "activity")
        }
      />

      {/* Spacer */}
      <div className="flex-1" />

      {/* History */}
      <RailButton
        icon={History}
        label="Sessions"
        onClick={inChat(toggleSessionPanel)}
      />

      {/* Settings (models, passkeys, sign out) */}
      <RailButton
        icon={SlidersHorizontal}
        label="Settings"
        onClick={toggleSettingsPanel}
      />

      {/* Connection status */}
      <div className="mt-2 flex flex-col items-center gap-1">
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full",
            wsStatus === "connected" && "bg-green-500",
            wsStatus === "connecting" && "bg-primary animate-pulse",
            wsStatus === "disconnected" && "bg-destructive"
          )}
        />
        <span className="text-[10px] text-muted-foreground">
          {wsStatus === "connected"
            ? "Live"
            : wsStatus === "connecting"
              ? "..."
              : "Off"}
        </span>
      </div>
    </nav>
  );
}

function RailButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  badge,
}: {
  icon: typeof Brain;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  /** Unread-count dot (the inbox badge). Hidden at 0. */
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        "group relative flex h-10 w-10 items-center justify-center rounded-lg transition-all duration-150 hover:bg-surface-raised hover:text-foreground hover:scale-110 disabled:opacity-40 disabled:hover:scale-100",
        active ? "bg-surface-raised text-primary" : "text-muted-foreground"
      )}
    >
      <Icon className="h-4.5 w-4.5" />
      {badge !== undefined && <CountBadge count={badge} className="-right-0.5 -top-0.5" />}
      {/* Tooltip */}
      <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md bg-surface-overlay px-2.5 py-1 text-xs font-medium text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 border border-border">
        {label}
      </span>
    </button>
  );
}
