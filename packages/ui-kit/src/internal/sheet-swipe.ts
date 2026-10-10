import { useLayoutEffect, useRef, type RefObject } from "react";
import { isTopmost } from "./overlay-stack.js";
import type { OverlayProps } from "../chrome/Overlay.js";

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [contenteditable], [tabindex]';
/** D54 header manipulation; the caller still owns open and close policy. */
export function useSheetSwipe(p: OverlayProps, surface: RefObject<HTMLDivElement | null>, id: symbol) {
  const latest = useRef(p);
  latest.current = p;
  const cancel = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!p.open || !surface.current) return;
    const here: HTMLDivElement = surface.current;
    const doc = here.ownerDocument;
    const win = doc.defaultView!;
    const scrim = here.parentElement!.querySelector<HTMLElement>(".bk-overlay-scrim")!;
    let drag: { pointer: number; x: number; y: number; started: boolean; eligible: boolean; height: number; dy: number; samples: { t: number; y: number }[] } | undefined;
    let frame = 0;
    let animations: Animation[] = [];
    const shape = () => latest.current.variant === "sheet" || (latest.current.variant === "dialog" && latest.current.placement !== "top" && win.innerWidth < 900);
    const top = () => isTopmost(doc, id) && !here.closest("[inert]");
    const eligible = () => (latest.current.closedBy ?? "any") === "any";
    const reduced = () => win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stopAnimations = () => { animations.forEach(a => a.cancel()); animations = []; };
    function reset() {
      const previous = drag;
      drag = undefined;
      win.cancelAnimationFrame(frame);
      const transform = here.style.transform;
      const opacity = scrim.style.opacity;
      here.style.removeProperty("transform");
      scrim.style.removeProperty("opacity");
      stopAnimations();
      if (previous?.started && !reduced() && transform) {
        animations = [here.animate([{ transform }, { transform: "translateY(0)" }], { duration: 200, easing: "ease-out" }),
          scrim.animate([{ opacity }, { opacity: 1 }], { duration: 200, easing: "ease-out" })];
      }
      if (previous && here.hasPointerCapture(previous.pointer)) here.releasePointerCapture(previous.pointer);
    }
    cancel.current = reset;
    function watch() {
      if (!drag) return;
      if (!top() || !shape() || (drag.eligible && !eligible()) || (drag.started && !here.hasPointerCapture(drag.pointer))) { reset(); return; }
      frame = win.requestAnimationFrame(watch);
    }
    function down(event: PointerEvent) {
      if (drag) { if (event.pointerId !== drag.pointer) reset(); return; }
      if (!here.contains(event.target as Node) || !shape() || !top() || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
      const target = event.target as Element;
      const rect = here.getBoundingClientRect();
      if (event.clientY < rect.top || event.clientY > rect.top + 56 || (target.closest(INTERACTIVE) && here.contains(target.closest(INTERACTIVE)))) return;
      event.preventDefault();
      stopAnimations();
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, started: false, eligible: eligible(), height: rect.height, dy: 0, samples: [{ t: event.timeStamp, y: event.clientY }] };
      frame = win.requestAnimationFrame(watch);
    }
    function move(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!top() || !shape() || (drag.eligible && !eligible())) { reset(); return; }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.started) {
        if (Math.abs(dx) >= 8 && Math.abs(dx) >= Math.abs(dy)) { reset(); return; }
        if (dy < 8 || dy <= Math.abs(dx)) return;
        drag.started = true;
        here.getAnimations().forEach(a => a.cancel());
        scrim.getAnimations().forEach(a => a.cancel());
        here.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      drag.dy = dy;
      drag.samples.push({ t: event.timeStamp, y: event.clientY });
      // Keep the sample preceding the 80ms boundary for interpolation.
      while (drag.samples.length > 2 && drag.samples[1]!.t < event.timeStamp - 80) drag.samples.shift();
      const offset = drag.eligible && dy >= 0 ? dy : Math.max(-12, Math.min(12, dy * .2));
      here.style.transform = `translateY(${offset}px)`;
      scrim.style.opacity = String(drag.eligible ? 1 - .6 * Math.max(0, Math.min(1, dy / drag.height)) : 1);
    }
    function up(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointer) return;
      const current = drag;
      const last = { t: event.timeStamp, y: event.clientY };
      const cutoff = last.t - 80;
      const samples = [...current.samples, last];
      while (samples.length > 2 && samples[1]!.t <= cutoff) samples.shift();
      const first = samples[0]!, next = samples[1]!;
      const start = Math.max(first.t, cutoff);
      const startY = first.t < cutoff && next.t > first.t ? first.y + (next.y - first.y) * (cutoff - first.t) / (next.t - first.t) : first.y;
      const velocity = last.t > start ? (last.y - startY) / (last.t - start) : 0;
      const commit = current.started && current.eligible && eligible() && top() && shape()
        && (current.dy >= Math.min(current.height * .25, 120) || (current.dy >= 24 && velocity >= .5));
      reset();
      if (commit) latest.current.onClose("swipe");
    }
    const interrupted = (event: PointerEvent) => {
      // Touch initially captures its hit target implicitly. Transferring that
      // capture to the surface emits a bubbling loss on the header strip.
      if (event.type === "lostpointercapture" && event.target !== here) return;
      if (drag?.pointer === event.pointerId) reset();
    };

    doc.addEventListener("pointerdown", down, true);
    here.addEventListener("pointermove", move);
    here.addEventListener("pointerup", up);
    here.addEventListener("pointercancel", interrupted);
    here.addEventListener("lostpointercapture", interrupted);
    return () => {
      reset(); stopAnimations(); cancel.current = () => {};

      doc.removeEventListener("pointerdown", down, true);
      here.removeEventListener("pointermove", move);
      here.removeEventListener("pointerup", up);
      here.removeEventListener("pointercancel", interrupted);
      here.removeEventListener("lostpointercapture", interrupted);
    };
  }, [p.open, surface, id]);
  useLayoutEffect(() => { if ((p.closedBy ?? "any") !== "any") cancel.current(); }, [p.closedBy]);
  return () => cancel.current();
}
