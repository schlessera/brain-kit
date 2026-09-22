import { useMediaQuery } from "./use-media-query.js";

/**
 * Whether any pointer is fine: the display heuristic chosen in #86 for
 * shortcut hints on touch devices. This does not detect a keyboard. A paired
 * mouse or trackpad updates the query live; a keyboard alone may not.
 * Only printed hints follow this signal. Bindings remain active either way.
 * Without matchMedia (SSR or a test DOM), preserve the existing hints.
 */
export function useFinePointer(): boolean {
  return useMediaQuery("(any-pointer: fine)", true);
}
