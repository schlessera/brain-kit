import { useMediaQuery } from "./use-media-query.js";

/**
 * Whether any pointer is fine: the display heuristic chosen in #86 for
 * shortcut hints on touch devices. This does not detect a keyboard. A paired
 * mouse or trackpad updates the query live; a keyboard alone does not, so a
 * tablet with a keyboard but no trackpad prints no hints — ruled acceptable,
 * with the platform fact behind it (no media query reports a keyboard), in
 * the D36 addendum of docs/decisions/design-kit.md.
 * Only printed hints follow this signal. Bindings remain active either way.
 * Without matchMedia (SSR or a test DOM), preserve the existing hints.
 */
export function useFinePointer(): boolean {
  return useMediaQuery("(any-pointer: fine)", true);
}
