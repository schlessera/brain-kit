/** @experimental Part of the content-renderer seam. */
export type ContentRendererTheme = "light" | "dark" | "print";
/** @experimental Part of the content-renderer seam. */
export interface StaticRenderer {
  languages: readonly string[];
  extensions: readonly string[];
  /** A caller without a browser must retain the source as code. */
  needsBrowser: boolean;
  toStatic(source: string, options: { theme: ContentRendererTheme; path?: string }): Promise<string>;
}
/** @experimental Part of the content-renderer seam. */
export interface StaticRendererPack { renderers: readonly StaticRenderer[] }
/** @experimental Part of the content-renderer seam. */
export interface StaticRendererRegistry {
  register(pack: StaticRendererPack): void;
  has(pack: StaticRendererPack): boolean;
  forLanguage(language: string): StaticRenderer | null;
  forExtension(extension: string): StaticRenderer | null;
  reset(): void;
}
/** @experimental Part of the content-renderer seam. Exact, case-sensitive claims; first wins. */
export function createStaticRendererRegistry(): StaticRendererRegistry {
  const packs = new Set<StaticRendererPack>();
  const languages = new Map<string, StaticRenderer>();
  const extensions = new Map<string, StaticRenderer>();
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
const defaultRegistry = createStaticRendererRegistry();
/** @experimental Register trusted bundled static entries; never content-selected imports. */
export function registerStaticRenderers(pack: StaticRendererPack): void { defaultRegistry.register(pack); }
/** @experimental Exact fence language or extension (including its leading dot). Languages win ambiguity. */
export function staticRendererFor(languageOrExtension: string): StaticRenderer | null {
  return defaultRegistry.forLanguage(languageOrExtension) ?? defaultRegistry.forExtension(languageOrExtension);
}
