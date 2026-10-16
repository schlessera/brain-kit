import { Fragment, Suspense, useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronRight, HardDrive, KeyRound, Laptop, Puzzle, SlidersHorizontal, UserRound, Workflow } from "lucide-react";
import { useUIStore, type SettingsTab } from "../../stores/ui-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
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

// The frame stays eager; each data-owning pane loads only on activation.
const ModelsTab = lazyChunk(() => import("./models-tab.js").then((m) => ({ default: m.ModelsTab })));
const AccountsTab = lazyChunk(() => import("./accounts-tab.js").then((m) => ({ default: m.AccountsTab })));
const PasskeyTab = lazyChunk(() => import("./passkey-tab.js").then((m) => ({ default: m.PasskeyTab })));
const DevicesAgentsTab = lazyChunk(() => import("./devices-agents-tab.js").then((m) => ({ default: m.DevicesAgentsTab })));
const SkillsTab = lazyChunk(() => import("./skills-tab.js").then((m) => ({ default: m.SkillsTab })));
const ModulesTab = lazyChunk(() => import("./modules-tab.js").then((m) => ({ default: m.ModulesTab })));
const StorageTab = lazyChunk(() => import("./storage-tab.js").then((m) => ({ default: m.StorageTab })));

/** One logical inventory at every width; the groups label the desktop column. */
const SECTIONS: Array<{ id: SettingsTab; label: string; meta: string; group: string; icon: IconName; glyph: typeof KeyRound }> = [
  { id: "appearance", label: "Appearance & input", meta: "this device", group: "This device", icon: "settings", glyph: SlidersHorizontal },
  { id: "models", label: "Models", meta: "picker", group: "This brain", icon: "model", glyph: SlidersHorizontal },
  { id: "accounts", label: "Accounts", meta: "providers", group: "This brain", icon: "wallet", glyph: UserRound },
  { id: "skills", label: "Skills", meta: "catalog", group: "This brain", icon: "capability", glyph: Puzzle },
  { id: "modules", label: "Modules", meta: "workflows", group: "This brain", icon: "steps", glyph: Workflow },
  { id: "storage", label: "Storage", meta: "capacity", group: "This brain", icon: "ledger", glyph: HardDrive },
  { id: "security", label: "Security", meta: "passkeys", group: "Access", icon: "passkey", glyph: KeyRound },
  { id: "devices", label: "Devices & agents", meta: "credentials", group: "Access", icon: "agent", glyph: Laptop },
];
const PANE_QUERY = "(min-width: 900px)";

/** Approved #1773 placement: Appearance & input is a pane at every width. */
export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tab = useUIStore((s) => s.settingsTab);
  const settingsProtected = useUIStore((s) => s.settingsNavigationProtected);
  const setTab = useUIStore((s) => s.setSettingsTab);
  const root = useBrainUiRoot();
  // Drafts survive width changes, but never a replacement brain root.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const moduleSession = useMemo(() => createModuleSettingsSession(), [root]);
  const mintPending = usePrincipalStore((s) => s.mintPending);
  const oneTimeCredential = usePrincipalStore((s) => s.oneTimeCredential);
  const credentialProtected = mintPending || oneTimeCredential !== null;
  const closedBy = credentialProtected || settingsProtected ? "none" : "any";
  const pane = useMediaQuery(PANE_QUERY);
  const panelRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [focusTab, setFocusTab] = useState(tab);
  const [overflow, setOverflow] = useState(false);
  const previousTab = useRef(tab);
  const selected = () => panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

  useDestinationPress("settings", ({ keyboard }) => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    scrollToStart(panel);
    setFocusTab(tab);
    focusFirst([selected()], keyboard);
  });

  useEffect(() => {
    setFocusTab(tab);
    if (previousTab.current !== tab && open) {
      scrollToStart(panelRef.current);
      selected()?.focus({ preventScroll: true });
    }
    previousTab.current = tab;
  }, [tab, open]);

  // Scroll only the strip, never the form or an ancestor. Observe the actual
  // drawer width too (tablet drawers do not occupy the whole viewport).
  useEffect(() => {
    const strip = stripRef.current;
    if (!open || pane || !strip) return;
    const keepVisible = () => {
      const button = strip.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!button) return;
      const bounds = strip.getBoundingClientRect();
      const target = button.getBoundingClientRect();
      if (target.left < bounds.left + 8) strip.scrollLeft += target.left - bounds.left - 8;
      else if (target.right > bounds.right - 24) strip.scrollLeft += target.right - bounds.right + 24;
      setOverflow(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    };
    const cue = () => setOverflow(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    keepVisible();
    const observer = new ResizeObserver(keepVisible);
    observer.observe(strip);
    strip.addEventListener("scroll", cue);
    return () => { observer.disconnect(); strip.removeEventListener("scroll", cue); };
  }, [tab, open, pane]);

  function traverse(event: KeyboardEvent<HTMLButtonElement>) {
    const backward = pane ? "ArrowUp" : "ArrowLeft";
    const forward = pane ? "ArrowDown" : "ArrowRight";
    if (![backward, forward, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...event.currentTarget.closest('[role="tablist"]')!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(button => !button.disabled);
    const index = tabs.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === forward ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus({ preventScroll: true });
    if (!pane && stripRef.current && tabs[next]) {
      const bounds = stripRef.current.getBoundingClientRect();
      const target = tabs[next].getBoundingClientRect();
      if (target.left < bounds.left + 8) stripRef.current.scrollLeft += target.left - bounds.left - 8;
      else if (target.right > bounds.right - 24) stripRef.current.scrollLeft += target.right - bounds.right + 24;
    }
  }

  const tabs = SECTIONS.map(({ id: section, label, meta, group, icon, glyph: Glyph }, index) => (
    <Fragment key={section}>
      {pane && SECTIONS[index - 1]?.group !== group && <div id={`${id}-group-${group.replaceAll(" ", "-")}`} className="px-2.5 pb-1 pt-4 font-[family-name:var(--font-mono)] text-[9.5px] uppercase text-muted-foreground">{group}</div>}
      <button
        // raw-button: select — composite Settings tab with manual activation
        style={{ "--hv-bg": pane ? "var(--bk-color-raised)" : "var(--bk-hover-veil-strong)" } as CSSProperties}
        type="button" id={`${id}-tab-${section}`} role="tab" aria-label={label}
        aria-selected={tab === section} aria-controls={`${id}-panel-${section}`}
        aria-describedby={pane ? `${id}-group-${group.replaceAll(" ", "-")}` : undefined}
        tabIndex={(credentialProtected ? tab : focusTab) === section ? 0 : -1}
        disabled={credentialProtected && tab !== section}
        onFocus={() => setFocusTab(section)} onKeyDown={traverse}
        onClick={() => { if (!credentialProtected && section !== tab) setTab(section); }}
        className={cn("bk-row flex min-h-11 shrink-0 items-center transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          pane ? "w-full gap-2 rounded-lg px-2.5 py-2 text-left" : "gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium",
          tab === section ? pane ? "bg-surface-raised" : "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground")}
      >
        {pane ? <Icon icon={icon} size={16} color={tab === section ? "var(--bk-amber-ink)" : "var(--bk-color-ink-mute)"} /> : <Glyph aria-hidden className="h-3.5 w-3.5" />}
        <span className={pane ? "min-w-0 flex-1 text-[12.5px] font-semibold" : undefined} style={pane && tab === section ? { color: "var(--bk-amber-ink)" } : undefined}>{label}</span>
        {pane && <span aria-hidden className="shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{meta}</span>}
      </button>
    </Fragment>
  ));
  const body = <div key={tab} id={`${id}-panel-${tab}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <SectionBody tab={tab} open={open} moduleSession={moduleSession} />
  </div>;
  return <><SettingsFocusReturn open={open} /><SlidePanel open={open} onClose={onClose} title="Settings" wide mode={pane ? "pane" : "drawer"} closedBy={closedBy} destination panelRef={panelRef} returnFocus={false}>
    <div className="flex h-full min-h-0 flex-col">
      {pane && <div className="flex shrink-0 items-center border-b border-border pr-3">
        <div className="min-w-0 flex-1"><ScreenHeader variant="nav" title="Settings" back={false} divider={false} /></div>
        <div className="shrink-0"><Button label="Close" icon="dismiss" tone="quiet" size="sm" block={false} onClick={onClose} /></div>
      </div>}
      <div className={pane ? "flex min-h-0 flex-1" : "flex min-h-0 flex-1 flex-col"}>
        {pane ? <nav aria-label="Settings sections" className="flex w-[216px] shrink-0 flex-col border-r border-border">
          <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">{tabs}</div>
          <div className="shrink-0 border-t border-border px-4 py-3 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{root.config.appName}</div>
        </nav> : <div className="relative shrink-0 border-b border-border">
          <div ref={stripRef} role="tablist" aria-label="Settings sections" aria-orientation="horizontal" className="flex gap-1 overflow-x-auto pl-2 pt-2">{tabs}<span aria-hidden className="w-6 shrink-0" /></div>
          {overflow && <span aria-hidden className="pointer-events-none absolute bottom-0 right-0 top-0 flex w-6 items-center justify-center bg-surface"><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /></span>}
        </div>}
        {pane ? <div className="flex min-h-0 min-w-0 flex-1 flex-col"><div className="flex min-h-0 w-full max-w-[720px] flex-1 flex-col">{body}</div></div> : body}
      </div>
    </div>
  </SlidePanel></>;
}

/** Mounted before SlidePanel so its layout capture precedes native autofocus. */
function SettingsFocusReturn({ open }: { open: boolean }) {
  const root = useBrainUiRoot();
  const opener = useRef<HTMLElement | null>(null);
  const previousVisibility = useRef({ open: false, root });
  // This earlier sibling captures before the drawer's layout autofocus.
  // One owner spans widths; resizing or replacing a brain is not a close.
  useLayoutEffect(() => {
    const previous = previousVisibility.current;
    if (previous.root !== root) opener.current = null;
    else if (open && !previous.open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let restore = 0;
    if (!open && previous.open && previous.root === root) {
      const target = opener.current;
      // React restores pre-mutation focus after layout cleanups. Restore
      // after that commit, respecting a modal or a newly focused destination.
      restore = requestAnimationFrame(() => {
        const focused = document.activeElement;
        const needsFocus = !focused || focused === document.body || focused === document.documentElement;
        if (needsFocus && !previousVisibility.current.open && previousVisibility.current.root === root) focusFirst([target]);
      });
    }
    previousVisibility.current = { open, root };
    return () => { if (restore) cancelAnimationFrame(restore); };
  }, [open, root]);
  return null;
}

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

/** Mount only the activated pane, preserving lazy requests and leave guards. */
function SectionBody({ tab, open, moduleSession }: { tab: SettingsTab; open: boolean; moduleSession: ModuleSettingsSessionStore }) {
  return <Suspense fallback={null}>
    {tab === "appearance" ? <div className="min-h-0 flex-1 overflow-y-auto"><AppearanceSection /></div>
      : tab === "models" ? <ModelsTab active={open} />
      : tab === "accounts" ? <AccountsTab active={open} />
      : tab === "skills" ? <SkillsTab active={open} />
      : tab === "modules" ? <ModulesTab active={open} session={moduleSession} />
      : tab === "storage" ? <StorageTab active={open} />
      : tab === "security" ? <PasskeyTab active={open} />
      : <DevicesAgentsTab active={open} />}
  </Suspense>;
}
