import { useEffect, useId, useRef, type ReactNode } from "react";
import { BottomSheet } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { registerUpdateHold } from "../../lib/update-holds.js";

/** Native modal owns inertness, focus containment and restoration. */
export function LocalWorkDialog({ title, onCancel, children, focusAction = false }: { title: string; onCancel: () => void; children: ReactNode; focusAction?: boolean }) {
  const root = useBrainUiRoot();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const release = registerUpdateHold(root, { busy: () => true, subscribe: () => () => {} });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation();
      cancel.current();
    };
    window.addEventListener("keydown", escape, true);
    el.showModal();
    (focusAction ? el.querySelector<HTMLElement>("[data-initial-focus] [role=button], [data-initial-focus] button") : el.querySelector<HTMLElement>("h2"))?.focus();
    return () => { window.removeEventListener("keydown", escape, true); el.close(); previous?.focus({ preventScroll: true }); release(); };
  }, [root, focusAction]);
  return <dialog ref={dialog} className="local-work-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onCancel(); }}>
    <BottomSheet>
      <h2 tabIndex={-1} id={titleId} className="mb-3 text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </BottomSheet>
  </dialog>;
}
