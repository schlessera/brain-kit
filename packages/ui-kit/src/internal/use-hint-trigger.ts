import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

/**
 * The hover-hint trigger: a control that shows a tooltip after 300 ms of hover
 * or on focus, hides it 150 ms after both leave, and opens a details dialog on
 * click. After the details close under a resting pointer, hover rearms only
 * once the pointer leaves, so the tooltip does not reappear at once.
 *
 * A trigger that has no tooltip (a reveal stop) uses only `trigger`,
 * `openDetails`, `closeDetails` and `skipFocus`, and spreads none of the
 * pointer or focus handlers.
 */
export function useHintTrigger<T extends HTMLElement = HTMLButtonElement>() {
  const trigger = useRef<T>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressed = useRef(false);
  const skipFocus = useRef(false);
  const hovered = useRef(false);
  const rearm = useRef(false);

  const clear = () => { clearTimeout(pending.current); };
  const hide = () => { clear(); setShown(false); };
  const enter = () => { clear(); suppressed.current = false; pending.current = setTimeout(() => { if (!suppressed.current && !open) setShown(true); }, 300); };
  const leave = () => { clear(); pending.current = setTimeout(() => { if (!hovered.current && trigger.current?.ownerDocument.activeElement !== trigger.current) setShown(false); }, 150); };
  useEffect(() => () => clearTimeout(pending.current), []);

  useLayoutEffect(() => {
    if (!shown) return;
    const node = trigger.current;
    if (!node) return;
    const doc = node.ownerDocument;
    const win = doc.defaultView!;
    const place = () => {
      const box = node.getBoundingClientRect();
      const hint = tooltip.current!.getBoundingClientRect();
      const left = Math.max(16, Math.min(box.left, win.innerWidth - hint.width - 16));
      const above = box.top - hint.height - 8;
      const top = Math.max(8, Math.min(above >= 8 ? above : box.bottom + 8, win.innerHeight - hint.height - 8));
      setPosition({ left, top });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      suppressed.current = true; clearTimeout(pending.current); setShown(false);
      event.preventDefault(); event.stopPropagation();
    };
    place();
    win.addEventListener("resize", place);
    doc.addEventListener("scroll", place, true);
    doc.addEventListener("keydown", escape, true);
    return () => { win.removeEventListener("resize", place); doc.removeEventListener("scroll", place, true); doc.removeEventListener("keydown", escape, true); };
  }, [shown]);

  return {
    trigger, tooltip, shown, setShown, open, setOpen, position, skipFocus,
    /** Spread on the trigger; a component that also reacts to focus calls `onFocus` itself. */
    triggerProps: {
      onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== "touch") { hovered.current = true; if (!rearm.current) enter(); } },
      onPointerLeave: () => { hovered.current = false; rearm.current = false; leave(); },
      onFocus: () => { if (skipFocus.current) { skipFocus.current = false; return; } enter(); },
      onBlur: leave,
    },
    /** Spread on the tooltip, so moving onto it keeps it shown. */
    tooltipProps: {
      onPointerEnter: () => { hovered.current = true; clear(); },
      onPointerLeave: () => { hovered.current = false; leave(); },
    },
    openDetails: () => { hide(); suppressed.current = true; setOpen(true); },
    closeDetails: () => { suppressed.current = true; skipFocus.current = true; rearm.current = true; setOpen(false); },
  };
}
