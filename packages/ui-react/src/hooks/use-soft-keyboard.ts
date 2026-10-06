import { useEffect, useState } from "react";

/**
 * Whether the composer is focused with a soft keyboard up, and how many lines
 * it is drawing: what the shared row above the composer reads (D52 §3).
 *
 * No platform API reports a soft keyboard everywhere, so "up" is the evidence
 * that is available: the composer holds focus, a coarse pointer exists, and
 * the visual viewport is at least {@link KEYBOARD_MIN_PX} shorter than the
 * layout viewport, which is what a keyboard does to it. A desktop with a
 * focused composer is never "up".
 *
 * The line count is the field's drawn height over its line height, so a
 * wrapped line counts as a line, as the R4 budget does.
 */
export interface SoftKeyboard {
  open: boolean;
  composerLines: number;
}

/** A visual viewport this much shorter than the layout one is a keyboard, not browser chrome. */
export const KEYBOARD_MIN_PX = 120;

const COMPOSER = "textarea[data-composer]";

/** How often a focused composer is re-read for changes no event reports. */
const POLL_MS = 250;

function read(): SoftKeyboard {
  const field = document.activeElement;
  if (!(field instanceof HTMLTextAreaElement) || !field.matches(COMPOSER)) return { open: false, composerLines: 1 };
  const style = getComputedStyle(field);
  const line = parseFloat(style.lineHeight) || 20;
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const composerLines = Math.max(1, Math.round((field.scrollHeight - padding) / line));
  const coarse = typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;
  const viewport = window.visualViewport;
  const open = coarse && viewport !== null && viewport !== undefined && window.innerHeight - viewport.height >= KEYBOARD_MIN_PX;
  return { open, composerLines };
}

export function useSoftKeyboard(): SoftKeyboard {
  const [state, setState] = useState<SoftKeyboard>({ open: false, composerLines: 1 });
  useEffect(() => {
    const update = () => {
      const next = read();
      setState((current) => (current.open === next.open && current.composerLines === next.composerLines ? current : next));
    };
    // Focus moves before the keyboard animates in, so the viewport's resize
    // is what settles it; input catches a composer growing past a line.
    // Focus events are read once the focus has actually moved.
    // While the composer holds focus, its value can also change with no
    // event at all: an accepted send clears it, a suggestion fills it. A
    // light poll catches those, only while it is focused.
    let poll: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    const later = () =>
      setTimeout(() => {
        if (disposed) return;
        update();
        const focused = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.matches(COMPOSER);
        if (focused && poll === undefined) poll = setInterval(update, POLL_MS);
        if (!focused && poll !== undefined) {
          clearInterval(poll);
          poll = undefined;
        }
      }, 0);
    const viewport = window.visualViewport;
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    document.addEventListener("input", update);
    viewport?.addEventListener("resize", update);
    later();
    return () => {
      disposed = true;
      if (poll !== undefined) clearInterval(poll);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      document.removeEventListener("input", update);
      viewport?.removeEventListener("resize", update);
    };
  }, []);
  return state;
}
