import { defaultContentRendererRegistry, type ContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { mermaidContentPack } from "./mermaid.js";

/** Registry-owned identity deduplication keeps resets and repeated roots safe. */
export function registerBuiltinContentRenderers(registry: ContentRendererRegistry = defaultContentRendererRegistry): void {
  registry.register(mermaidContentPack);
}
