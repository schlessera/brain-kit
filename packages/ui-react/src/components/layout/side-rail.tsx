import {
  Brain,
  RefreshCw,
  Newspaper,
  History,
  KeyRound,
  SquarePen,
  FolderTree,
} from "lucide-react";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";

export function SideRail() {
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const toggleSessionPanel = useUIStore((s) => s.toggleSessionPanel);
  const toggleSyncPanel = useUIStore((s) => s.toggleSyncPanel);
  const toggleWhatsupPanel = useUIStore((s) => s.toggleWhatsupPanel);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSecurityPanel = useUIStore((s) => s.toggleSecurityPanel);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const hasMessages = useChatStore((s) => activeChat(s).messages.length > 0);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);

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
        onClick={toggleSyncPanel}
        disabled={isStreaming}
      />
      <RailButton
        icon={Newspaper}
        label="Whatsup"
        onClick={toggleWhatsupPanel}
        disabled={isStreaming}
      />
      <RailButton
        icon={FolderTree}
        label="Files"
        onClick={toggleFilePanel}
      />

      {/* Spacer */}
      <div className="flex-1" />

      {/* History */}
      <RailButton
        icon={History}
        label="Sessions"
        onClick={toggleSessionPanel}
      />

      {/* Security (passkeys, sign out) */}
      <RailButton
        icon={KeyRound}
        label="Security"
        onClick={toggleSecurityPanel}
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
}: {
  icon: typeof Brain;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="group relative flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-surface-raised hover:text-foreground hover:scale-110 disabled:opacity-40 disabled:hover:scale-100"
    >
      <Icon className="h-4.5 w-4.5" />
      {/* Tooltip */}
      <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md bg-surface-overlay px-2.5 py-1 text-xs font-medium text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 border border-border">
        {label}
      </span>
    </button>
  );
}
