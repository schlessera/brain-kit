import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./chat-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useChatStore = Object.assign(
  function useChatStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.chat.getState>) => T): T {
    return useRootStore("chat", selector);
  },
  defaultRoot.stores.chat,
);
