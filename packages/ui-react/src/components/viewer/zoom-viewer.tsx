import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, Maximize2, X } from "lucide-react";

/**
 * Full-screen, pan-and-zoom view of one visual thing — a diagram, an image,
 * anything with a natural pixel size. Callers supply the content and any extra
 * toolbar actions; everything about the gesture surface lives here.
 *
 * Hand-rolled on pointer events rather than pulling a pan/zoom library: the
 * whole surface is two transforms and the repo has no other dependency of that
 * shape. Touch gestures work because the stage sets `touch-action: none` —
 * the browser hands us every pointer instead of scrolling the page, which is
 * also why no preventDefault is needed on the touch path. Wheel is the one
 * exception: React's onWheel is passive, so it is bound manually.
 */

const MIN_SCALE = 0.15;
const MAX_SCALE = 12;

interface Point {
  x: number;
  y: number;
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export interface ZoomViewerProps {
  children: React.ReactNode;
  onClose: () => void;
  /**
   * Extra toolbar nodes, placed left of the close button — typically a share
   * menu. Rendered inside the header, above the stage.
   */
  actions?: React.ReactNode;
  /**
   * Changes when the content's natural size may have changed (a streaming
   * diagram growing, an image finishing its decode). Re-fits, but only while
   * the user has not panned or zoomed — after that nothing moves behind them.
   */
  refitKey?: unknown;
  /**
   * Ceiling on the scale `fit()` may choose. Small diagrams may grow to fill
   * the stage (blowing one up 8x reads as broken, hence a cap), but a raster
   * image has real pixels: opening it above 100% only shows interpolation, so
   * image callers pass 1.
   */
  maxFitScale?: number;
  /** Aria label for the overlay. */
  label?: string;
}

export function ZoomViewer({
  children,
  onClose,
  actions,
  refitKey,
  maxFitScale = 2.5,
  label = "Zoomed view",
}: ZoomViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);

  // Live gesture state lives in refs: pointer maths must not wait for a render.
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number; center: Point } | null>(null);
  const panFrom = useRef<{ pointer: Point; offset: Point } | null>(null);
  const view = useRef({ scale: 1, offset: { x: 0, y: 0 } });
  /** The scale `fit()` last produced — the baseline double-click toggles against. */
  const fitScale = useRef(1);
  /** Set once the user pans/zooms; after that nothing may re-fit behind their back. */
  const touched = useRef(false);

  const apply = useCallback((next: { scale: number; offset: Point }) => {
    view.current = next;
    setScale(next.scale);
    setOffset(next.offset);
  }, []);

  /** Natural (untransformed) size of the content — offsetWidth ignores transforms. */
  const natural = useCallback((): { w: number; h: number } | null => {
    const el = contentRef.current;
    if (!el || !el.offsetWidth || !el.offsetHeight) return null;
    return { w: el.offsetWidth, h: el.offsetHeight };
  }, []);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const size = natural();
    if (!stage || !size) return;
    const pad = 32;
    const sx = (stage.clientWidth - pad * 2) / size.w;
    const sy = (stage.clientHeight - pad * 2) / size.h;
    const next = clampScale(Math.min(maxFitScale, Math.min(sx, sy)));
    fitScale.current = next;
    apply({
      scale: next,
      offset: {
        x: (stage.clientWidth - size.w * next) / 2,
        y: (stage.clientHeight - size.h * next) / 2,
      },
    });
  }, [apply, natural, maxFitScale]);

  useLayoutEffect(() => {
    // Re-runs when the content itself changes, which happens while a message is
    // still streaming — so a user who has already panned keeps their view.
    if (!touched.current) fit();
    setReady(true);
  }, [fit, refitKey]);

  /** Zoom about a stage-local anchor, so the point under the cursor/fingers stays put. */
  const zoomAt = useCallback(
    (factor: number, anchor: Point) => {
      // Any deliberate zoom counts as touching the view — including the
      // toolbar buttons and the wheel. Without this, content that is still
      // streaming would re-fit itself out from under the reader's zoom.
      touched.current = true;
      const { scale: prev, offset: prevOffset } = view.current;
      const next = clampScale(prev * factor);
      if (next === prev) return;
      const ratio = next / prev;
      apply({
        scale: next,
        offset: {
          x: anchor.x - (anchor.x - prevOffset.x) * ratio,
          y: anchor.y - (anchor.y - prevOffset.y) * ratio,
        },
      });
    },
    [apply]
  );

  const zoomCenter = useCallback(
    (factor: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      zoomAt(factor, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
    },
    [zoomAt]
  );

  const stagePoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  // Wheel must be bound manually: React's onWheel is passive, so it cannot
  // preventDefault, and the page behind would scroll (or the browser would
  // pinch-zoom the whole PWA on a ctrl+wheel trackpad gesture).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A trackpad pinch arrives as ctrlKey+wheel with small deltas; a mouse
      // wheel arrives as coarse notches. Both map to the same exponential.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(factor, stagePoint(e));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomCenter(1.25);
      else if (e.key === "-" || e.key === "_") zoomCenter(0.8);
      else if (e.key === "0") fit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, zoomCenter, fit]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Re-fit on rotation / resize only while the view is untouched, so a resize
  // never yanks content the user has deliberately panned into place.
  useEffect(() => {
    const onResize = () => {
      if (!touched.current) fit();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, stagePoint(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      panFrom.current = null;
    } else if (pointers.current.size === 1) {
      panFrom.current = { pointer: stagePoint(e), offset: view.current.offset };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = stagePoint(e);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinch.current.dist > 0) {
        touched.current = true;
        // Pan and zoom in one step: the midpoint drift moves the content, the
        // distance ratio scales it about that same midpoint.
        const drift = {
          x: center.x - pinch.current.center.x,
          y: center.y - pinch.current.center.y,
        };
        // Committed through apply(), not written straight to the ref: two
        // fingers moving in parallel (or a pinch already clamped at min/max)
        // produce no scale change, and zoomAt() returns early — the drift
        // would then be stranded in the ref and nothing would pan.
        apply({
          scale: view.current.scale,
          offset: {
            x: view.current.offset.x + drift.x,
            y: view.current.offset.y + drift.y,
          },
        });
        zoomAt(dist / pinch.current.dist, center);
      }
      pinch.current = { dist, center };
      return;
    }

    if (panFrom.current) {
      touched.current = true;
      apply({
        scale: view.current.scale,
        offset: {
          x: panFrom.current.offset.x + (p.x - panFrom.current.pointer.x),
          y: panFrom.current.offset.y + (p.y - panFrom.current.pointer.y),
        },
      });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size >= 2) {
      // Still pinching, but with a DIFFERENT pair (a stray third touch got
      // lifted). Rebase the baseline, or the next move would compare the new
      // pair's spread against the old pair's and jump.
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }
    pinch.current = null;
    if (pointers.current.size === 1) {
      // Lifting one finger of a pinch must not teleport the content: re-anchor
      // the pan to whichever pointer is still down.
      const [remaining] = [...pointers.current.values()];
      panFrom.current = { pointer: remaining, offset: view.current.offset };
    } else if (pointers.current.size === 0) {
      panFrom.current = null;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    touched.current = true;
    // Compared against the FIT scale, not against 1: content that fits at 125%
    // would otherwise read as "already zoomed" and double-click would re-fit it
    // to exactly where it already was.
    if (view.current.scale > fitScale.current * 1.05) fit();
    else zoomAt(2, stagePoint(e));
  };

  const btn =
    "flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground";

  // Portalled to <body>: message bubbles animate through framer-motion, and a
  // transformed ancestor becomes the containing block for `fixed`, which would
  // pin this overlay to the bubble instead of the viewport.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
    >
      <div
        className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2"
        style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
      >
        <span className="px-1 font-[family-name:var(--font-mono)] text-xs tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <div className="flex items-center gap-1">
          <button type="button" title="Zoom out" onClick={() => zoomCenter(0.8)} className={btn}>
            <Minus className="h-4 w-4" />
          </button>
          <button type="button" title="Zoom in" onClick={() => zoomCenter(1.25)} className={btn}>
            <Plus className="h-4 w-4" />
          </button>
          <button type="button" title="Fit to screen" onClick={fit} className={btn}>
            <Maximize2 className="h-4 w-4" />
          </button>
          {actions}
          <button type="button" title="Close" onClick={onClose} className={btn}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing [&_img]:max-w-none [&_svg]:max-w-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onDoubleClick}
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            visibility: ready ? "visible" : "hidden",
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
