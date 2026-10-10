import { Suspense, useMemo, useRef, type CSSProperties, type RefObject } from "react";
import { KeyRound, Laptop, Puzzle, SlidersHorizontal } from "lucide-react";
import { useUIStore, type SettingsTab } from "../../stores/ui-store.js";
import { SlidePanel, type SlidePanelClosedBy } from "../layout/slide-panel.js";
import { cn } from "../../lib/utils.js";
import { usePrincipalStore } from "../../stores/principal-store.js";
import { useBrainUiRoot } from "../../root-context.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { ThemeToggle } from "../layout/theme.js";
import { ShortcutSwitch } from "../layout/shortcut-switch.js";
import { Button, Callout, Icon, Label, ScreenHeader, Surface, type IconName } from "@schlessera/brain-ui-kit";
import { useDestinationPress } from "../../hooks/use-destination-press.js";
import { focusFirst, scrollToStart } from "../../lib/destination-start.js";
import { createModuleSettingsSession, type ModuleSettingsSessionStore } from "./module-settings-state.js";
import { lazyChunk } from "../../lib/lazy-chunk.js";

/**
 * Each tab is fetched the first time it is opened. Settings is the largest
 * surface in the app and most sessions never open it, so none of it belongs in
 * the bundle that has to arrive before the first message can be shown. The
 * panel frame and its tab strip stay eager, so opening settings is immediate
 * and only the body fills in.
 */
const ModelsTab = lazyChunk(() => import("./models-tab.js").then((m) => ({ default: m.ModelsTab })));
const PasskeyTab = lazyChunk(() => import("./passkey-tab.js").then((m) => ({ default: m.PasskeyTab })));
const DevicesAgentsTab = lazyChunk(() => import("./devices-agents-tab.js").then((m) => ({ default: m.DevicesAgentsTab })));
const SkillsTab = lazyChunk(() => import("./skills-tab.js").then((m) => ({ default: m.SkillsTab })));
const ModulesTab = lazyChunk(() => import("./modules-tab.js").then((m) => ({ default: m.ModulesTab })));

/** The phone strip's tabs. Appearance and input sit above the strip there. */
type StripTab = Exclude<SettingsTab, "appearance">;

const TABS: Array<{ id: StripTab; label: string; icon: typeof KeyRound }> = [
  { id: "models", label: "Models", icon: SlidersHorizontal },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "modules", label: "Modules", icon: Puzzle },
  { id: "security", label: "Security", icon: KeyRound },
  { id: "devices", label: "Devices & agents", icon: Laptop },
];

/**
 * D5's section column, from `laptop:` up. The mono meta names what the
 * section holds; it is not a count, because the column has no data of its
 * own to count.
 */
const SECTIONS: Array<{ id: SettingsTab; label: string; meta: string; icon: IconName }> = [
  { id: "appearance", label: "Appearance & input", meta: "this device", icon: "settings" },
  { id: "models", label: "Models", meta: "providers", icon: "model" },
  { id: "skills", label: "Skills", meta: "catalog", icon: "capability" },
  { id: "modules", label: "Modules", meta: "workflows", icon: "capability" },
  { id: "security", label: "Security", meta: "passkeys", icon: "passkey" },
  { id: "devices", label: "Devices & agents", meta: "credentials", icon: "agent" },
];

/** The rail is expanded from here (`laptop:`), and Settings becomes a pane. */
const PANE_QUERY = "(min-width: 900px)";

/**
 * The settings surface: one panel, one entry point in the menus, a section
 * per area. Only the selected section is mounted — each fetches its own data
 * on becoming active, so switching (or reopening the panel) always shows
 * current state.
 *
 * Two shapes. Below `laptop:` the drawer with its tab strip, unchanged: the
 * theme toggle and the single-key switch sit above the tabs. From `laptop:`
 * up it is D5's pane over the content area: a header row, a 216px section
 * column, and the section's form at a 720px measure. There, Appearance &
 * input is a section of its own.
 */
export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const tab = useUIStore((s) => s.settingsTab);
  const settingsProtected = useUIStore((s) => s.settingsNavigationProtected);
  const root = useBrainUiRoot();
  // A provider can replace its brain root without remounting this panel.
  // Keep drafts across responsive remounts, but never across root replacement.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const moduleSession = useMemo(() => createModuleSettingsSession(), [root]);
  const setTab = useUIStore((s) => s.setSettingsTab);
  const mintPending = usePrincipalStore((s) => s.mintPending);
  const oneTimeCredential = usePrincipalStore((s) => s.oneTimeCredential);
  const credentialProtected = mintPending || oneTimeCredential !== null;
  const pane = useMediaQuery(PANE_QUERY);
  // While a mint is in flight or its one-time value is unacknowledged, the
  // panel does not light-dismiss: a stray click or Escape must not hide the
  // surface the credential is about to land on. The panel header X stays live
  // under closedBy="none"; the credential dialog itself has no X.
  const closedBy = credentialProtected || settingsProtected ? "none" : "any";

  function select(id: SettingsTab) {
    if (!credentialProtected) setTab(id);
  }

  // Pressing Settings while it is open (D52 N3): the drawer body, or the
  // pane's section scroller, goes to the top, and focus goes to the selected
  // section tab. One section is always selected, and the press never changes
  // it, so the leave guard has nothing to ask.
  const panelRef = useRef<HTMLElement>(null);
  useDestinationPress("settings", ({ keyboard }) => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    scrollToStart(panel);
    focusFirst([panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')], keyboard);
  });

  if (pane) {
    return (
      <SettingsPane
        open={open}
        tab={tab}
        credentialProtected={credentialProtected}
        closedBy={closedBy}
        onSelect={select}
        onClose={onClose}
        moduleSession={moduleSession}
        panelRef={panelRef}
      />
    );
  }

  // The strip has no Appearance tab: a pane selection that survives a resize
  // down lands on the first tab, and the controls it named are right above.
  const stripTab: StripTab = tab === "appearance" ? "models" : tab;

  return (
    <SlidePanel open={open} onClose={onClose} title="Settings" wide closedBy={closedBy} destination panelRef={panelRef}>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 pt-2">
          {TABS.map(({ id, label, icon: TabIcon }) => (
            <button
              // raw-button: select — underline settings tab; the kit has no matching tab control
              style={{ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties}
              key={id}
              onClick={() => select(id)}
              disabled={credentialProtected && stripTab !== id}
              aria-selected={stripTab === id}
              role="tab"
              className={cn(
                "bk-row flex min-h-11 shrink-0 items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                stripTab === id
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <TabIcon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Appearance is not a tab: it is one control, it applies everywhere,
            and the design puts the three-way toggle in Settings without
            giving it a section of its own. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">Appearance</span>
          <ThemeToggle />
        </div>
        {/* Settings › Input (D37, as D5 draws it): the off switch for
            single-key shortcuts as a group row, with the banner that says what
            turning it off does. One control, applies everywhere, so it sits
            beside Appearance rather than in a tab. */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
          <Label text="Input" icon="capability" />
          <Surface pad={0}>
            <ShortcutSwitch />
          </Surface>
          <ShortcutBanner />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <SectionBody tab={stripTab} open={open} moduleSession={moduleSession} />
        </div>
      </div>
    </SlidePanel>
  );
}

/**
 * D5 from `laptop:` up: the pane. The header row carries the serif title and
 * the close control; under it the section column and the form area share the
 * height, and only the form area scrolls.
 */
function SettingsPane({
  open,
  tab,
  credentialProtected,
  closedBy,
  onSelect,
  onClose,
  moduleSession,
  panelRef,
}: {
  open: boolean;
  tab: SettingsTab;
  credentialProtected: boolean;
  closedBy: SlidePanelClosedBy;
  onSelect: (tab: SettingsTab) => void;
  onClose: () => void;
  moduleSession: ModuleSettingsSessionStore;
  panelRef: RefObject<HTMLElement | null>;
}) {
  const appName = useBrainUiRoot().config.appName;
  return (
    <SlidePanel open={open} onClose={onClose} title="Settings" mode="pane" closedBy={closedBy} panelRef={panelRef}>
      {/* The kit header is `width: 100%`; it needs a shrinking flex child
          around it, or it fills the row and pushes Close past the viewport
          (the Files pane wraps its header the same way). */}
      <div className="flex shrink-0 items-center border-b border-border pr-3">
        <div className="min-w-0 flex-1">
          <ScreenHeader variant="nav" title="Settings" back={false} divider={false} />
        </div>
        <div className="shrink-0">
          <Button label="Close" icon="dismiss" tone="quiet" size="sm" block={false} onClick={onClose} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="flex w-[216px] shrink-0 flex-col border-r border-border">
          <div role="tablist" aria-orientation="vertical" className="flex flex-1 flex-col gap-0.5 p-2">
            {SECTIONS.map(({ id, label, meta, icon }) => {
              const selected = tab === id;
              return (
                <button
                  // raw-button: select — composite vertical tab with icon, label and meta
                  style={{ "--hv-bg": "var(--bk-color-raised)" } as CSSProperties}
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  // The name is the label alone: the mono meta beside it is a
                  // descriptor, and a test or a screen reader asking for
                  // "Security" should find it.
                  aria-label={label}
                  disabled={credentialProtected && !selected}
                  onClick={() => onSelect(id)}
                  className={cn(
                    "bk-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    selected && "bg-surface-raised"
                  )}
                >
                  <Icon icon={icon} size={16} color={selected ? "var(--bk-amber-ink)" : "var(--bk-color-ink-mute)"} />
                  <span
                    className={cn("min-w-0 flex-1 truncate text-[12.5px] font-semibold", !selected && "text-foreground")}
                    style={selected ? { color: "var(--bk-amber-ink)" } : undefined}
                  >
                    {label}
                  </span>
                  <span className="shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">
                    {meta}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="shrink-0 border-t border-border px-4 py-3 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">
            {appName}
          </div>
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex h-full max-w-[720px] flex-col">
            {tab === "appearance" ? (
              <AppearanceSection />
            ) : (
              <SectionBody tab={tab} open={open} moduleSession={moduleSession} />
            )}
          </div>
        </div>
      </div>
    </SlidePanel>
  );
}

/**
 * D5's first section, as the drop draws it: the theme under "Appearance",
 * the single-key switch and its banner under "Input". Both controls apply to
 * this device only, which the header says.
 */
function AppearanceSection() {
  return (
    <div className="flex flex-col">
      <ScreenHeader
        variant="nav"
        title="Appearance & input"
        subtitle="applies on this device only"
        back={false}
        divider={false}
      />
      <div className="flex flex-col gap-2 px-4 pb-4">
        <Label text="Appearance" icon="settings" />
        <Surface pad={0}>
          <div className="flex items-center gap-3 px-3 py-3">
            <Icon icon="settings" size={17} color="var(--bk-color-ink-mute)" />
            <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-foreground">Theme</span>
            <ThemeToggle />
          </div>
        </Surface>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4">
        <Label text="Input" icon="capability" />
        <Surface pad={0}>
          <ShortcutSwitch />
        </Surface>
        <ShortcutBanner />
      </div>
    </div>
  );
}

function ShortcutBanner() {
  return (
    <Callout
      variant="banner"
      tone="neutral"
      icon="scope"
      text="Turning single-key shortcuts off also removes the printed keys from buttons — a key that no longer fires should not be advertised."
    />
  );
}

/** The lazily fetched section, mounted only while it is the selected one. */
function SectionBody({ tab, open, moduleSession }: { tab: StripTab; open: boolean; moduleSession: ModuleSettingsSessionStore }) {
  return (
    <Suspense fallback={null}>
      {tab === "models" ? (
        <ModelsTab active={open} />
      ) : tab === "skills" ? (
        <SkillsTab active={open} />
      ) : tab === "modules" ? (
        <ModulesTab active={open} session={moduleSession} />
      ) : tab === "security" ? (
        <PasskeyTab active={open} />
      ) : (
        <DevicesAgentsTab active={open} />
      )}
    </Suspense>
  );
}
