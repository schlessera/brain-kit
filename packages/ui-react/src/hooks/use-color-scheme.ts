import { useEffect, useState } from "react";
import { useUIStore } from "../stores/ui-store.js";
import { useMediaQuery } from "./use-media-query.js";
import { documentColorScheme, type ColorScheme } from "../lib/light-dark.js";

/**
 * The scheme the page is drawing in — `light` or `dark` — for the parts of
 * the app that read a token as a value rather than referencing it (the graph
 * canvas, the diagram theme). Everything else lets `light-dark()` decide.
 *
 * Follows the store's preference and, under `system`, the OS: both are
 * subscribed, and the answer is re-read from the root's computed
 * `color-scheme` after `useApplyTheme` has written the attribute, so a host
 * that sets `data-theme` itself is honoured too. The initial value is read
 * synchronously, so the first paint after a stored preference is right.
 */
export function useColorScheme(): ColorScheme {
  const preference = useUIStore((s) => s.theme);
  const osDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [scheme, setScheme] = useState<ColorScheme>(() => expected(preference, osDark));
  useEffect(() => {
    // `useApplyTheme` writes `data-theme` in the app root's effect, which runs
    // after this one; the store says what it will write, and the document is
    // re-read on the next frame in case a host wrote something else.
    setScheme(expected(preference, osDark));
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(() => setScheme(documentColorScheme()));
    return () => cancelAnimationFrame(frame);
  }, [preference, osDark]);
  return scheme;
}

function expected(preference: "system" | "light" | "dark", osDark: boolean): ColorScheme {
  if (preference === "system") return osDark ? "dark" : "light";
  return preference;
}
