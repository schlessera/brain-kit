import { useMediaQuery } from "./use-media-query.js";

/**
 * Whether ANY pointer on the device is fine — a mouse, a trackpad, a stylus.
 * The layout splits on width, and a tablet in landscape is wide enough for
 * the desktop's shape while having no keyboard; this is the signal that says
 * whether a printed key (`⌘1`, the `a` / `d` caps, "↵ to open") can be
 * pressed at all. `any-pointer` rather than `pointer`, so a touch device with
 * a mouse or keyboard paired reads fine and the caps come back the moment it
 * is — live, through the list's change event, no reload. Only the PRINT
 * follows this; every binding stays registered either way (D36: a shortcut is
 * printed where it applies, and it does not apply where nothing can fire it).
 *
 * Fails open: with no `matchMedia` — the server, the test DOM — a keyboard is
 * assumed, so the keys render as they always have.
 */
export function useFinePointer(): boolean {
  return useMediaQuery("(any-pointer: fine)", true);
}
