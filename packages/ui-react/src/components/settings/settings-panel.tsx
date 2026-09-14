import { Suspense, lazy } from "react";
import { KeyRound, Laptop, Puzzle, SlidersHorizontal } from "lucide-react";
import { useUIStore, type SettingsTab } from "../../stores/ui-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
import { cn } from "../../lib/utils.js";
import { usePrincipalStore } from "../../stores/principal-store.js";

/**
 * Each tab is fetched the first time it is opened. Settings is the largest
 * surface in the app and most sessions never open it, so none of it belongs in
 * the bundle that has to arrive before the first message can be shown. The
 * panel frame and its tab strip stay eager, so opening settings is immediate
 * and only the body fills in.
 */
const ModelsTab = lazy(() => import("./models-tab.js").then((m) => ({ default: m.ModelsTab })));
const PasskeyTab = lazy(() => import("./passkey-tab.js").then((m) => ({ default: m.PasskeyTab })));
const DevicesAgentsTab = lazy(() => import("./devices-agents-tab.js").then((m) => ({ default: m.DevicesAgentsTab })));
const SkillsTab = lazy(() => import("./skills-tab.js").then((m) => ({ default: m.SkillsTab })));

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof KeyRound }> = [
  { id: "models", label: "Models", icon: SlidersHorizontal },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "security", label: "Security", icon: KeyRound },
  { id: "devices", label: "Devices & agents", icon: Laptop },
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
  const mintPending = usePrincipalStore((s) => s.mintPending);
  const oneTimeCredential = usePrincipalStore((s) => s.oneTimeCredential);
  const credentialProtected = mintPending || oneTimeCredential !== null;

  function closeIfSafe() {
    if (!credentialProtected) onClose();
  }

  return (
    <SlidePanel open={open} onClose={closeIfSafe} title="Settings" wide>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 gap-1 border-b border-border px-2 pt-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                if (!credentialProtected) setTab(id);
              }}
              disabled={credentialProtected && tab !== id}
              aria-selected={tab === id}
              role="tab"
              className={cn(
                "flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
          <Suspense fallback={null}>
            {tab === "models" ? (
              <ModelsTab active={open && tab === "models"} />
            ) : tab === "skills" ? (
              <SkillsTab active={open && tab === "skills"} />
            ) : tab === "security" ? (
              <PasskeyTab active={open && tab === "security"} />
            ) : (
              <DevicesAgentsTab active={open && tab === "devices"} />
            )}
          </Suspense>
        </div>
      </div>
    </SlidePanel>
  );
}
