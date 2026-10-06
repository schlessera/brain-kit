import { createStore } from "zustand/vanilla";
import type { StoreEnvironment } from "./store-environment.js";

/**
 * The design's three-way theme toggle (system / paper / dark). `system` is
 * the browser's own `prefers-color-scheme`; the other two override it. The
 * value is written to `<html data-theme>` by `useApplyTheme`, and the kit's
 * tokens do the rest — no component knows which theme it is in.
 */
export type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "brain-theme";
const SINGLE_KEY_KEY = "brain-single-key-shortcuts";

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Which section the settings surface shows. `appearance` (D5: theme and
 * input) is a section column row from `laptop:` up only; the phone strip
 * keeps those controls above its tabs and folds the value to `models`.
 */
export type SettingsTab = "appearance" | "models" | "skills" | "security" | "devices" | "modules";

/** Full-screen surface currently shown inside the AppShell. */
export type ActiveView = "chat" | "graph" | "activity";

/** The panels a destination opens rather than a view it switches to. */
export type DestinationPanel = "sessions" | "files" | "settings";

/**
 * D52's five destinations, by the view or panel each one is: Chat, Sessions,
 * Actions (the `activity` view), Files and Settings.
 */
export type Destination = "chat" | "activity" | DestinationPanel;

/**
 * @internal A press of the destination already shown (D52 N3): which one,
 * and a count that grows by one with every such press, so the mounted
 * destination can tell a new press from the last one it answered.
 */
export interface DestinationPress {
  destination: Destination;
  n: number;
  /**
   * Pressed by its chord. A modifier chord does not count as keyboard input
   * for the browser's focus-visible heuristic, so the destination asks for a
   * visible ring itself: a keyboard press shows it, a tap does not.
   */
  keyboard: boolean;
}

/** @internal How a destination was pressed; see `DestinationPress.keyboard`. */
export interface DestinationPressHow {
  keyboard?: boolean;
}

/**
 * Which views mount each destination panel. Chat mounts all three; Graph
 * mounts its own Files and Settings; Actions mounts only Settings. A panel
 * opened from a view that does not mount it lands in Chat, so the panel is
 * actually drawn rather than a flag set behind the view (D52 §2).
 */
const PANEL_VIEWS: Record<DestinationPanel, readonly ActiveView[]> = {
  sessions: ["chat"],
  files: ["chat", "graph"],
  settings: ["chat", "graph", "activity"],
};

const PANEL_FLAG = {
  sessions: "sessionPanelOpen",
  files: "filePanelOpen",
  settings: "settingsPanelOpen",
} as const satisfies Record<DestinationPanel, keyof typeof CLOSED>;

export interface UIState {
  activeView: ActiveView;
  /**
   * Drill-in stack of open subagent views (Agent tool-call span ids). A
   * nested subagent pushes; back pops. Kept here rather than component state
   * so the Activity surface and the chat timeline share one drill-in.
   */
  subagentStack: string[];
  pushSubagentView: (spanId: string) => void;
  popSubagentView: () => void;
  sessionPanelOpen: boolean;
  syncPanelOpen: boolean;
  whatsupPanelOpen: boolean;
  searchPanelOpen: boolean;
  addPanelOpen: boolean;
  filePanelOpen: boolean;
  settingsPanelOpen: boolean;
  settingsTab: SettingsTab;
  /**
   * @internal The desktop command palette, open or not. Kept in the root's
   * store so the rail's `All commands` button opens this application's
   * palette and never another mounted root's (D52 §1). Not a panel: it
   * floats over whatever is open and leaves it be.
   */
  paletteOpen: boolean;
  /** @internal Opens or closes this root's command palette. */
  setPaletteOpen: (open: boolean) => void;
  settingsNavigationProtected: boolean;
  /**
   * @internal Runs `change` once Settings may be left: at once without a
   * guard, or when the guard lets the navigation through. A route that
   * changes the view AND then runs something (the palette's and rail's
   * `inChat`) passes both here, so nothing runs before consent.
   */
  afterLeavingSettings: (change: () => void) => void;
  setSettingsNavigationGuard: (guard: ((leave: () => void) => void) | null) => void;
  /** Switch the full-screen view; closes any open panel so the new view starts clean. */
  setActiveView: (view: ActiveView) => void;
  /**
   * Go to a destination that is a panel (D52 §2, N1 and N3). It replaces any
   * other open panel with no separate close step, lands in Chat when the
   * current view does not mount it, and never toggles: pressing the
   * destination that is already open leaves it open.
   */
  openPanel: (panel: DestinationPanel) => void;
  /**
   * @internal Press a destination, as the rail, ⌘1–⌘5, the palette's Jump to
   * and the phone bar do (D52 §2). A destination that is not shown is gone
   * to: `setActiveView` for Chat and Actions, `openPanel` for the panels.
   * Pressing the one already shown changes no view, panel, selection, draft
   * or tracker; it records a `destinationPress` that the mounted destination
   * answers by scrolling to its start and moving focus (N3).
   */
  pressDestination: (destination: Destination, how?: DestinationPressHow) => void;
  /** @internal The last press of the destination already shown; see `pressDestination`. */
  destinationPress: DestinationPress | null;
  /**
   * @internal How the panel now open was pressed open, when a press opened
   * it, so a surface that answers the panel elsewhere keeps the press's ring.
   */
  panelPress: { panel: DestinationPanel; keyboard: boolean } | null;
  /**
   * @internal At ≥1280 Sessions is the pane beside the transcript, not a
   * drawer (D52 §1–2): pressing it lands in Chat with focus moved into the
   * pane, and Chat stays the destination. Chat answers an open Sessions
   * drawer at that width with `focusSessionsPane`, which closes it and asks
   * the pane for focus; the pane takes the request with `takeSessionsPaneFocus`.
   */
  sessionsPaneFocus: { n: number; keyboard: boolean } | null;
  focusSessionsPane: () => void;
  takeSessionsPaneFocus: () => { n: number; keyboard: boolean } | null;
  toggleSessionPanel: () => void;
  toggleSyncPanel: () => void;
  toggleWhatsupPanel: () => void;
  toggleSearchPanel: () => void;
  toggleAddPanel: () => void;
  toggleFilePanel: () => void;
  toggleSettingsPanel: () => void;
  closeAllPanels: () => void;
  setSyncPanelOpen: (open: boolean) => void;
  setWhatsupPanelOpen: (open: boolean) => void;
  setSearchPanelOpen: (open: boolean) => void;
  setAddPanelOpen: (open: boolean) => void;
  setSessionPanelOpen: (open: boolean) => void;
  setFilePanelOpen: (open: boolean) => void;
  setSettingsPanelOpen: (open: boolean) => void;
  /** Open settings straight onto a tab (menu entries, deep links). */
  openSettings: (tab: SettingsTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Persisted per root; `dark` until the user says otherwise, which is what
   * the app has always been. A host that wants `system` as its default sets
   * it once through `setTheme`. */
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  /**
   * D36: `a` / `d` on a focused approval card and `j` / `k` in a focused
   * list. On by default; the off switch is WCAG 2.1.4's third escape hatch
   * for readers whose assistive tech or typing habits collide with single
   * letters. Persisted per root. Modifier shortcuts (⌘K, ⌘1–⌘5) are not
   * governed by it.
   */
  singleKeyShortcuts: boolean;
  setSingleKeyShortcuts: (on: boolean) => void;
}

const CLOSED = {
  sessionPanelOpen: false,
  syncPanelOpen: false,
  whatsupPanelOpen: false,
  searchPanelOpen: false,
  addPanelOpen: false,
  filePanelOpen: false,
  settingsPanelOpen: false,
};

/**
 * Whether `destination` is what the screen shows: a panel that is open over a
 * view that draws it, or a view with no panel over it. The same reading as
 * the amber rail row and phone slot.
 */
function isShown(s: UIState, destination: Destination): boolean {
  if (destination === "chat" || destination === "activity") {
    return s.activeView === destination && (Object.keys(CLOSED) as Array<keyof typeof CLOSED>).every((k) => !s[k]);
  }
  return s[PANEL_FLAG[destination]] && PANEL_VIEWS[destination].includes(s.activeView);
}

export function createUIStore(env?: Pick<StoreEnvironment, "storage" | "storageKey">) {
  const themeKey = env?.storageKey(THEME_KEY) ?? THEME_KEY;
  const stored = env?.storage()?.getItem(themeKey);
  const singleKeyKey = env?.storageKey(SINGLE_KEY_KEY) ?? SINGLE_KEY_KEY;
  const storedSingleKey = env?.storage()?.getItem(singleKeyKey);
  let navigationGuard: ((leave: () => void) => void) | null = null;
  const leaveSettings = (change: () => void) => navigationGuard ? navigationGuard(change) : change();
  return createStore<UIState>((set, get) => ({
    ...CLOSED,
    activeView: "chat",
    settingsTab: "models",
    paletteOpen: false,
    setPaletteOpen: (open) => set({ paletteOpen: open }),
    settingsNavigationProtected: false,
    afterLeavingSettings: (change) => leaveSettings(change),
    setSettingsNavigationGuard: (guard) => { navigationGuard = guard; set({ settingsNavigationProtected: guard !== null }); },
    theme: isThemePreference(stored) ? stored : "dark",
    setTheme: (theme) => {
      env?.storage()?.setItem(themeKey, theme);
      set({ theme });
    },
    singleKeyShortcuts: storedSingleKey !== "off",
    setSingleKeyShortcuts: (on) => {
      env?.storage()?.setItem(singleKeyKey, on ? "on" : "off");
      set({ singleKeyShortcuts: on });
    },
    subagentStack: [],
    pushSubagentView: (spanId) =>
      set((s) => ({ subagentStack: [...s.subagentStack, spanId] })),
    popSubagentView: () => set((s) => ({ subagentStack: s.subagentStack.slice(0, -1) })),
    setActiveView: (view) => leaveSettings(() => set({ ...CLOSED, activeView: view })),
    openPanel: (panel) => {
      const flag = PANEL_FLAG[panel];
      const change = () => set((s) => ({
        ...CLOSED,
        [flag]: true,
        activeView: PANEL_VIEWS[panel].includes(s.activeView) ? s.activeView : "chat",
      }));
      // Settings already open stays put without asking its leave guard:
      // nothing is being left.
      if (panel === "settings" && get().settingsPanelOpen) return;
      leaveSettings(change);
    },
    destinationPress: null,
    pressDestination: (destination, how) => {
      const s = get();
      if (isShown(s, destination)) {
        set({ destinationPress: { destination, n: (s.destinationPress?.n ?? 0) + 1, keyboard: how?.keyboard === true } });
        return;
      }
      if (destination === "chat" || destination === "activity") s.setActiveView(destination);
      else {
        s.openPanel(destination);
        if (get()[PANEL_FLAG[destination]]) set({ panelPress: { panel: destination, keyboard: how?.keyboard === true } });
      }
    },
    panelPress: null,
    sessionsPaneFocus: null,
    focusSessionsPane: () => {
      const s = get();
      const keyboard = s.panelPress?.panel === "sessions" && s.panelPress.keyboard;
      set({ sessionPanelOpen: false, panelPress: null, sessionsPaneFocus: { n: (s.sessionsPaneFocus?.n ?? 0) + 1, keyboard } });
    },
    takeSessionsPaneFocus: () => {
      const request = get().sessionsPaneFocus;
      if (request) set({ sessionsPaneFocus: null });
      return request;
    },
    toggleSessionPanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, sessionPanelOpen: !s.sessionPanelOpen }))),
    toggleSyncPanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, syncPanelOpen: !s.syncPanelOpen }))),
    toggleWhatsupPanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, whatsupPanelOpen: !s.whatsupPanelOpen }))),
    toggleSearchPanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, searchPanelOpen: !s.searchPanelOpen }))),
    toggleAddPanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, addPanelOpen: !s.addPanelOpen }))),
    toggleFilePanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, filePanelOpen: !s.filePanelOpen }))),
    toggleSettingsPanel: () =>
      leaveSettings(() => set((s) => ({ ...CLOSED, settingsPanelOpen: !s.settingsPanelOpen }))),
    closeAllPanels: () => leaveSettings(() => set({ ...CLOSED })),
    setSyncPanelOpen: (open) => set({ syncPanelOpen: open }),
    setWhatsupPanelOpen: (open) => set({ whatsupPanelOpen: open }),
    setSearchPanelOpen: (open) => set({ searchPanelOpen: open }),
    setAddPanelOpen: (open) => set({ addPanelOpen: open }),
    setSessionPanelOpen: (open) => set({ sessionPanelOpen: open }),
    setFilePanelOpen: (open) => set({ filePanelOpen: open }),
    setSettingsPanelOpen: (open) => open ? set({ settingsPanelOpen: true }) : leaveSettings(() => set({ settingsPanelOpen: false })),
    openSettings: (tab) =>
      leaveSettings(() => set({ ...CLOSED, settingsPanelOpen: true, settingsTab: tab })),
    setSettingsTab: (tab) => leaveSettings(() => set({ settingsTab: tab })),
  }));
}
