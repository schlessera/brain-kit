import { useEffect, useId, useRef, type ReactNode } from "react";
import { Overlay } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { registerUpdateHold } from "../../lib/update-holds.js";

/** Overlay owns focus and dismissal; local work keeps its update hold. */
export function LocalWorkDialog({ title, onCancel, children, focusAction = false }: { title: string; onCancel: () => void; children: ReactNode; focusAction?: boolean }) {
  const root = useBrainUiRoot();
  const titleId = useId();
  const initialFocus = useRef<HTMLElement>(null);
  useEffect(() => registerUpdateHold(root, { busy: () => true, subscribe: () => () => {} }), [root]);
  return <Overlay open variant="dialog" size="lg" labelledBy={titleId} data-local-work-dialog=""
    closedBy="closerequest" initialFocus={initialFocus} onClose={onCancel}
    surfaceRef={surface => {
      initialFocus.current = surface?.querySelector<HTMLElement>(focusAction
        ? "[data-initial-focus] [role=button], [data-initial-focus] button" : "h2") ?? null;
    }}>
    <h2 tabIndex={-1} id={titleId} className="mb-3 text-lg font-semibold text-foreground">{title}</h2>
    {children}
  </Overlay>;
}
