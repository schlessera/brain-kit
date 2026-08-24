import { create } from "zustand";

/** Which tab the settings panel opens on. */
export type SettingsTab = "models" | "security";

/** Full-screen surface currently shown inside the AppShell. */
export type ActiveView = "chat" | "graph" | "activity";

interface UIState {
  activeView: ActiveView;
  /**
   * Drill-in stack of open subagent views (Agent tool-call span ids). A
   * nested subagent pushes; back pops. Kept here rather than component state
   * so the Activity surface and the chat timeline share one drill-in.
   */
  subagentStack: string[];
  pushSubagentView: (spanId: string) => void;
  popSubagentView: () => void;
  closeSubagentViews: () => void;
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

export const useUIStore = create<UIState>((set) => ({
  ...CLOSED,
  activeView: "chat",
  settingsTab: "models",
  subagentStack: [],
  pushSubagentView: (spanId) =>
    set((s) => ({ subagentStack: [...s.subagentStack, spanId] })),
  popSubagentView: () => set((s) => ({ subagentStack: s.subagentStack.slice(0, -1) })),
  closeSubagentViews: () => set({ subagentStack: [] }),
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
