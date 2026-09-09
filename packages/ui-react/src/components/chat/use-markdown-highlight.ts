import { useEffect, useSyncExternalStore } from "react";
import type { Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Plugin lists, hoisted out of render.
 *
 * react-markdown builds a fresh unified processor on every render and reruns
 * the whole parse — there is no internal memoization to lean on. Fresh array
 * literals in the JSX made that unavoidable; module constants let the memo
 * below actually hold.
 */
export const REMARK_PLUGINS = [remarkGfm];
const NO_REHYPE_PLUGINS: NonNullable<MarkdownOptions["rehypePlugins"]> = [];

/**
 * Syntax highlighting arrives after first paint.
 *
 * rehype-highlight pulls in highlight.js, 166 KB of the entry bundle — more
 * than every markdown parser here put together — and nothing on the first paint
 * needs it. It is fetched once, on the first mount of a highlighting renderer;
 * until it lands, code blocks render as plain text and then gain their colours.
 * In practice it is loaded long before the first assistant message arrives.
 *
 * The module-level cache means the fetch happens once per page, not once per
 * message, and useSyncExternalStore is what lets every mounted renderer pick up
 * the plugin the moment it does.
 */
let highlightPlugins: NonNullable<MarkdownOptions["rehypePlugins"]> | null = null;
let highlightRequested = false;
const highlightListeners = new Set<() => void>();

function subscribeHighlight(onChange: () => void): () => void {
  highlightListeners.add(onChange);
  return () => {
    highlightListeners.delete(onChange);
  };
}

function readHighlightPlugins(): NonNullable<MarkdownOptions["rehypePlugins"]> {
  return highlightPlugins ?? NO_REHYPE_PLUGINS;
}

export function useRehypePlugins(enabled: boolean) {
  const plugins = useSyncExternalStore(
    subscribeHighlight,
    readHighlightPlugins,
    readHighlightPlugins
  );
  useEffect(() => {
    if (!enabled || highlightRequested) return;
    highlightRequested = true;
    import("rehype-highlight")
      .then((mod) => {
        highlightPlugins = [mod.default];
        for (const listener of highlightListeners) listener();
      })
      .catch(() => {
        // Soft-fail: code blocks stay readable, just uncoloured.
      });
  }, [enabled]);
  return enabled ? plugins : NO_REHYPE_PLUGINS;
}
