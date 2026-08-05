import {
  Brain,
  Newspaper,
  RefreshCw,
  History,
  KeyRound,
  FolderTree,
} from "lucide-react";
import { useUIStore } from "../../stores/ui-store.js";
import { cn } from "../../lib/utils.js";

export function MobileTabBar() {
  const toggleSessionPanel = useUIStore((s) => s.toggleSessionPanel);
  const toggleSyncPanel = useUIStore((s) => s.toggleSyncPanel);
  const toggleWhatsupPanel = useUIStore((s) => s.toggleWhatsupPanel);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSecurityPanel = useUIStore((s) => s.toggleSecurityPanel);

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 flex h-14 items-center justify-around border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)]">
      <TabIcon icon={Brain} label="Chat" active />
      <TabIcon icon={Newspaper} label="Brief" onClick={toggleWhatsupPanel} />
      <TabIcon icon={FolderTree} label="Files" onClick={toggleFilePanel} />
      <TabIcon icon={RefreshCw} label="Sync" onClick={toggleSyncPanel} />
      <TabIcon icon={History} label="History" onClick={toggleSessionPanel} />
      <TabIcon icon={KeyRound} label="Security" onClick={toggleSecurityPanel} />
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
