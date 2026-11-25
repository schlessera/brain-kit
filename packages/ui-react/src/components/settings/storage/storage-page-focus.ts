import { useEffect, useRef } from "react";

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
