import type { ComponentType } from "react";
import type { ContentRendererTheme, StaticRenderer } from "../render.js";

/** @experimental Part of the content-renderer seam. */
export interface ContentRendererProps {
  source: string;
  path?: string;
  mode: "chat" | "file" | "share";
  theme: ContentRendererTheme;
}
/** @experimental Extension seam; trusted, build-time-bundled content rendering. */
export interface ContentRenderer extends StaticRenderer {
  Component: ComponentType<ContentRendererProps>;
}
/** @experimental Part of the content-renderer seam. */
export interface ContentRendererPack { renderers: readonly ContentRenderer[] }
/** @experimental Part of the content-renderer seam. */
export interface ContentRendererRegistry {
  register(pack: ContentRendererPack): void;
  has(pack: ContentRendererPack): boolean;
  forLanguage(language: string): ContentRenderer | null;
  forExtension(extension: string): ContentRenderer | null;
  reset(): void;
}
/** @experimental Isolated registry; exact claims, first registration wins, pack identity dedupes. */
export function createContentRendererRegistry(): ContentRendererRegistry {
  const packs = new Set<ContentRendererPack>();
  const languages = new Map<string, ContentRenderer>();
  const extensions = new Map<string, ContentRenderer>();
  return {
    register(pack) {
      if (packs.has(pack)) return;
      packs.add(pack);
      for (const renderer of pack.renderers) {
        for (const language of renderer.languages) if (!languages.has(language)) languages.set(language, renderer);
        for (const extension of renderer.extensions) if (!extensions.has(extension)) extensions.set(extension, renderer);
      }
    },
    has: (pack) => packs.has(pack),
    forLanguage: (language) => languages.get(language) ?? null,
    forExtension: (extension) => extensions.get(extension) ?? null,
    reset() { packs.clear(); languages.clear(); extensions.clear(); },
  };
}
/** @experimental The build's default registry. */
export const defaultContentRendererRegistry: ContentRendererRegistry = createContentRendererRegistry();
/** @experimental Registers client entries only; the static build registers its own entries independently. */
export function registerContentRenderers(pack: ContentRendererPack): void { defaultContentRendererRegistry.register(pack); }
