import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./voice-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useVoiceStore = Object.assign(
  function useVoiceStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.voice.getState>) => T): T {
    return useRootStore("voice", selector);
  },
  defaultRoot.stores.voice,
);
