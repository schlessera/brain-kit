/**
 * The DOM half of D52 N3, shared by the destinations that answer a press of
 * themselves (`useDestinationPress`): reset, resolve, reveal. Every scroll
 * here is instant, in every motion mode, so reduced motion needs no case of
 * its own.
 */

/**
 * Every vertical scroll container in `root`, `root` included, back to its
 * top. A destination owns everything it draws, so a detail or reading pane
 * returns to the top of the item it shows; nothing is closed or replaced.
 * Horizontal positions are left alone: the reveal below brings the focus
 * target into view on that axis.
 */
export function scrollToStart(root: Element | null | undefined): void {
  if (!root) return;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.scrollTop > 0) el.scrollTo({ top: 0, behavior: "instant" });
  }
}

/** Whether `el` is laid out: in the document and not `display: none` itself or under it. */
function laidOut(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/**
 * Focuses the first candidate that is laid out and takes focus, then
 * reveals it with `nearest` inside its own scroll containers: a target
 * already at the start moves nothing, and one far down a list ends at the
 * bottom edge rather than out of view. Returns the element focused, or null
 * when none could be. `visible` asks for the focus ring even when the
 * browser's heuristic would not draw it: a modifier chord is not keyboard
 * input to it, but it is a keyboard press.
 */
export function focusFirst(candidates: ReadonlyArray<HTMLElement | null | undefined>, visible = false): HTMLElement | null {
  for (const el of candidates) {
    if (!el || !laidOut(el)) continue;
    // `focusVisible` only forces the ring on; left unset, the browser's own
    // heuristic decides, so a tap shows none and a plain key does.
    el.focus({ preventScroll: true, ...(visible ? { focusVisible: true } : {}) });
    if (document.activeElement !== el) continue;
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    return el;
  }
  return null;
}

/** The first control a waiting card offers: a button, a field, or a roving stop. */
export const FIRST_CONTROL = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]';
