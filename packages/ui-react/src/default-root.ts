import { defaultToolRendererRegistry, defaultAsrClientRegistry } from "@schlessera/brain-ui-sdk/client";
import { uiConfig, registerDevHandle } from "./config.js";
import { api } from "./lib/api-client.js";
import { createRoot } from "./root.js";

/** The single application root used by existing shells without a provider. */
export const defaultRoot = createRoot({ storagePrefix: "", api }, uiConfig, defaultToolRendererRegistry, defaultAsrClientRegistry);

registerDevHandle(() => {
  if (typeof window === "undefined") return;
  Object.assign(window, {
    __chatStore: defaultRoot.stores.chat,
    __graphStore: defaultRoot.stores.graph,
    __activityStore: defaultRoot.stores.activity,
  });
});
