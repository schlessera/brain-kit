import { createStore } from "zustand/vanilla";

/**
 * The pending mask request, if any.
 *
 * Deliberately a small standalone store rather than chat-buffer state: a mask
 * request is modal and at most one is open at a time, and nothing about it
 * needs to survive in a transcript — the answer travels back over the socket
 * and the resulting file is what persists.
 */
export interface MaskRequest {
  requestId: string;
  imagePath: string;
  instruction?: string;
  turnId?: string;
}

export interface MaskState {
  request: MaskRequest | null;
  open: (request: MaskRequest) => void;
  close: () => void;
}

export function createMaskStore() {
  return createStore<MaskState>((set) => ({
    request: null,
    open: (request) => set({ request }),
    close: () => set({ request: null }),
  }));
}
