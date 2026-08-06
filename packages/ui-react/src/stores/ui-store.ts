import { create } from "zustand";

/** Which tab the settings panel opens on. */
export type SettingsTab = "models" | "security";

interface UIState {
  sessionPanelOpen: boolean;
  syncPanelOpen: boolean;
  whatsupPanelOpen: boolean;
  filePanelOpen: boolean;
  settingsPanelOpen: boolean;
  settingsTab: SettingsTab;
  toggleSessionPanel: () => void;
  toggleSyncPanel: () => void;
  toggleWhatsupPanel: () => void;
  toggleFilePanel: () => void;
  toggleSettingsPanel: () => void;
  closeAllPanels: () => void;
  setSyncPanelOpen: (open: boolean) => void;
  setWhatsupPanelOpen: (open: boolean) => void;
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
  filePanelOpen: false,
  settingsPanelOpen: false,
};

export const useUIStore = create<UIState>((set) => ({
  ...CLOSED,
  settingsTab: "models",
  toggleSessionPanel: () =>
    set((s) => ({ ...CLOSED, sessionPanelOpen: !s.sessionPanelOpen })),
  toggleSyncPanel: () =>
    set((s) => ({ ...CLOSED, syncPanelOpen: !s.syncPanelOpen })),
  toggleWhatsupPanel: () =>
    set((s) => ({ ...CLOSED, whatsupPanelOpen: !s.whatsupPanelOpen })),
  toggleFilePanel: () =>
    set((s) => ({ ...CLOSED, filePanelOpen: !s.filePanelOpen })),
  toggleSettingsPanel: () =>
    set((s) => ({ ...CLOSED, settingsPanelOpen: !s.settingsPanelOpen })),
  closeAllPanels: () => set({ ...CLOSED }),
  setSyncPanelOpen: (open) => set({ syncPanelOpen: open }),
  setWhatsupPanelOpen: (open) => set({ whatsupPanelOpen: open }),
  setSessionPanelOpen: (open) => set({ sessionPanelOpen: open }),
  setFilePanelOpen: (open) => set({ filePanelOpen: open }),
  setSettingsPanelOpen: (open) => set({ settingsPanelOpen: open }),
  openSettings: (tab) =>
    set({ ...CLOSED, settingsPanelOpen: true, settingsTab: tab }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
}));
