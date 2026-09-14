import { create } from "zustand";
import { api, type MintedAgent } from "../lib/api-client.js";

interface PrincipalState {
  mintPending: boolean;
  mintError: string | null;
  oneTimeCredential: MintedAgent | null;
  mintAgent: (label: string, ttlDays: number) => Promise<void>;
  acknowledgeAgentCredential: () => void;
}

/**
 * Mint state lives above Settings because the response contains an
 * unrecoverable, one-time value. Closing a panel or changing views must not
 * discard either the request in flight or the value it eventually returns.
 */
export const usePrincipalStore = create<PrincipalState>((set, get) => ({
  mintPending: false,
  mintError: null,
  oneTimeCredential: null,

  mintAgent: async (label, ttlDays) => {
    if (get().mintPending || get().oneTimeCredential) return;
    set({ mintPending: true, mintError: null });
    try {
      const oneTimeCredential = await api.principalMint(label, ttlDays);
      set({ mintPending: false, oneTimeCredential });
    } catch (error) {
      set({
        mintPending: false,
        mintError:
          error instanceof Error ? error.message : "Could not create agent access",
      });
    }
  },

  acknowledgeAgentCredential: () => set({ oneTimeCredential: null }),
}));
