import { useEffect, useState } from "react";

/**
 * Whether a media query matches, kept current as the window changes. Reads
 * `fallback` where there is no `matchMedia` — the server, and the test DOM.
 * It defaults to `false`, so a component that branches on a width query
 * renders its mobile shape there; a capability query that must fail open
 * passes `true` (see `useFinePointer`).
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => read(query, fallback));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return;
    }
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

function read(query: string, fallback: boolean): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
    return window.matchMedia(query).matches;
  } catch {
    return fallback;
  }
}
