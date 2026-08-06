import { KeyRound, SlidersHorizontal } from "lucide-react";
import { useUIStore, type SettingsTab } from "../../stores/ui-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
import { cn } from "../../lib/utils.js";
import { ModelsTab } from "./models-tab.js";
import { PasskeyTab } from "./passkey-tab.js";

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof KeyRound }> = [
  { id: "models", label: "Models", icon: SlidersHorizontal },
  { id: "security", label: "Security", icon: KeyRound },
];

/**
 * The settings surface: one panel, one entry point in the menus, a tab per
 * area. Only the selected tab is mounted — each fetches its own data on becoming
 * active, so switching tabs (or reopening the panel) always shows current state.
 */
export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const tab = useUIStore((s) => s.settingsTab);
  const setTab = useUIStore((s) => s.setSettingsTab);

  return (
    <SlidePanel open={open} onClose={onClose} title="Settings">
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 gap-1 border-b border-border px-2 pt-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-selected={tab === id}
              role="tab"
              className={cn(
                "flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors",
                tab === id
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1">
          {tab === "models" ? (
            <ModelsTab active={open && tab === "models"} />
          ) : (
            <PasskeyTab active={open && tab === "security"} />
          )}
        </div>
      </div>
    </SlidePanel>
  );
}
