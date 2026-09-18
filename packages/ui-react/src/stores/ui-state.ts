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

/** Which tab the settings panel opens on. */
export type SettingsTab = "models" | "skills" | "security" | "devices";

/** Full-screen surface currently shown inside the AppShell. */
export type ActiveView = "chat" | "graph" | "activity";

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
  /** Switch the full-screen view; closes any open panel so the new view starts clean. */
  setActiveView: (view: ActiveView) => void;
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

export function createUIStore(env?: Pick<StoreEnvironment, "storage" | "storageKey">) {
  const themeKey = env?.storageKey(THEME_KEY) ?? THEME_KEY;
  const stored = env?.storage()?.getItem(themeKey);
  const singleKeyKey = env?.storageKey(SINGLE_KEY_KEY) ?? SINGLE_KEY_KEY;
  const storedSingleKey = env?.storage()?.getItem(singleKeyKey);
  return createStore<UIState>((set) => ({
    ...CLOSED,
    activeView: "chat",
    settingsTab: "models",
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
    setActiveView: (view) => set({ ...CLOSED, activeView: view }),
    toggleSessionPanel: () =>
      set((s) => ({ ...CLOSED, sessionPanelOpen: !s.sessionPanelOpen })),
    toggleSyncPanel: () =>
      set((s) => ({ ...CLOSED, syncPanelOpen: !s.syncPanelOpen })),
    toggleWhatsupPanel: () =>
      set((s) => ({ ...CLOSED, whatsupPanelOpen: !s.whatsupPanelOpen })),
    toggleSearchPanel: () =>
      set((s) => ({ ...CLOSED, searchPanelOpen: !s.searchPanelOpen })),
    toggleAddPanel: () =>
      set((s) => ({ ...CLOSED, addPanelOpen: !s.addPanelOpen })),
    toggleFilePanel: () =>
      set((s) => ({ ...CLOSED, filePanelOpen: !s.filePanelOpen })),
    toggleSettingsPanel: () =>
      set((s) => ({ ...CLOSED, settingsPanelOpen: !s.settingsPanelOpen })),
    closeAllPanels: () => set({ ...CLOSED }),
    setSyncPanelOpen: (open) => set({ syncPanelOpen: open }),
    setWhatsupPanelOpen: (open) => set({ whatsupPanelOpen: open }),
    setSearchPanelOpen: (open) => set({ searchPanelOpen: open }),
    setAddPanelOpen: (open) => set({ addPanelOpen: open }),
    setSessionPanelOpen: (open) => set({ sessionPanelOpen: open }),
    setFilePanelOpen: (open) => set({ filePanelOpen: open }),
    setSettingsPanelOpen: (open) => set({ settingsPanelOpen: open }),
    openSettings: (tab) =>
      set({ ...CLOSED, settingsPanelOpen: true, settingsTab: tab }),
    setSettingsTab: (tab) => set({ settingsTab: tab }),
  }));
}
