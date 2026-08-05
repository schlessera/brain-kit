import { create } from "zustand";

interface UIState {
  sessionPanelOpen: boolean;
  syncPanelOpen: boolean;
  whatsupPanelOpen: boolean;
  filePanelOpen: boolean;
  securityPanelOpen: boolean;
  toggleSessionPanel: () => void;
  toggleSyncPanel: () => void;
  toggleWhatsupPanel: () => void;
  toggleFilePanel: () => void;
  toggleSecurityPanel: () => void;
  closeAllPanels: () => void;
  setSyncPanelOpen: (open: boolean) => void;
  setWhatsupPanelOpen: (open: boolean) => void;
  setSessionPanelOpen: (open: boolean) => void;
  setFilePanelOpen: (open: boolean) => void;
  setSecurityPanelOpen: (open: boolean) => void;
}

const CLOSED = {
  sessionPanelOpen: false,
  syncPanelOpen: false,
  whatsupPanelOpen: false,
  filePanelOpen: false,
  securityPanelOpen: false,
};

export const useUIStore = create<UIState>((set) => ({
  ...CLOSED,
  toggleSessionPanel: () =>
    set((s) => ({ ...CLOSED, sessionPanelOpen: !s.sessionPanelOpen })),
  toggleSyncPanel: () =>
    set((s) => ({ ...CLOSED, syncPanelOpen: !s.syncPanelOpen })),
  toggleWhatsupPanel: () =>
    set((s) => ({ ...CLOSED, whatsupPanelOpen: !s.whatsupPanelOpen })),
  toggleFilePanel: () =>
    set((s) => ({ ...CLOSED, filePanelOpen: !s.filePanelOpen })),
  toggleSecurityPanel: () =>
    set((s) => ({ ...CLOSED, securityPanelOpen: !s.securityPanelOpen })),
  closeAllPanels: () => set({ ...CLOSED }),
  setSyncPanelOpen: (open) => set({ syncPanelOpen: open }),
  setWhatsupPanelOpen: (open) => set({ whatsupPanelOpen: open }),
  setSessionPanelOpen: (open) => set({ sessionPanelOpen: open }),
  setFilePanelOpen: (open) => set({ filePanelOpen: open }),
  setSecurityPanelOpen: (open) => set({ securityPanelOpen: open }),
}));
