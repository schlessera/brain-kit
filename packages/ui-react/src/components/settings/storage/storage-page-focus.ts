import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Paging replaces its own buttons: Next is gone on the last page, First on
 * the first. Once the requested page is shown, focus that left with a
 * removed button lands on the pager's surviving button, never on the
 * document body (#4549: focus is kept during actions).
 */
export function usePageFocus(loading: boolean, page: unknown) {
  const pager = useRef<HTMLDivElement>(null),
    paging = useRef(false);
  useEffect(() => {
    if (!paging.current || loading) return;
    paging.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    pager.current?.querySelector<HTMLElement>('[role="button"]:not([aria-disabled="true"])')?.focus();
  }, [loading, page]);
  return {
    pager,
    /** Call from a pager button's click, before the page changes. */
    paging: () => {
      paging.current = true;
    },
  };
}

/**
 * A control that leaves its slot while focused (#4549: focus is kept during
 * actions). Each slot inside the returned ref is marked `data-focus-slot`;
 * when the focused control is removed and focus has fallen to the body, the
 * first control left in its slot takes focus. The listeners follow the
 * element, which may mount after the hook does (a slot shown only with a
 * selection).
 */
export function useSlotFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null),
    last = useRef<{ control: Element; slot: Element } | null>(null),
    [element, setElement] = useState<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current !== element) setElement(ref.current);
  });
  useEffect(() => {
    if (!element) return;
    const enter = (event: FocusEvent) => {
      const control = event.target as Element;
      const slot = control.closest("[data-focus-slot]");
      last.current = slot && element.contains(slot) ? { control, slot } : null;
    };
    const leave = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && element.contains(next)) return;
      const control = event.target as Element;
      // Focus moved on by itself: nothing to keep. Chrome fires focusout
      // while removing a focused control, still connected, so a focusout to
      // nowhere is judged once the removal has finished.
      if (next) last.current = null;
      else queueMicrotask(() => {
        if (control.isConnected && last.current?.control === control) last.current = null;
      });
    };
    element.addEventListener("focusin", enter);
    element.addEventListener("focusout", leave);
    return () => {
      element.removeEventListener("focusin", enter);
      element.removeEventListener("focusout", leave);
    };
  }, [element]);
  useLayoutEffect(() => {
    const was = last.current;
    if (!was || was.control.isConnected) return;
    last.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (was.slot.isConnected) was.slot.querySelector<HTMLElement>('[role="button"],button')?.focus();
  });
  return ref;
}
