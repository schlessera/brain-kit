/**
 * The markup stage (#3983): the source image with the marks drawn over it,
 * and the gestures that draw, pan and zoom.
 *
 * Controlled for marks: `marks` arrive as a prop and a finished mark leaves
 * through `onCommit`. The view (zoom and pan) is the canvas's own state,
 * because no caller needs it and every pointer move changes it.
 *
 * | | Touch | Pointer |
 * |---|---|---|
 * | Draw | one finger, drawing tool active | primary button |
 * | Pan | two fingers, or one with Pan | Space + drag, or Pan |
 * | Zoom | pinch | Ctrl/⌘ + wheel or trackpad pinch; `+` / `−` |
 * | Fit | Fit button | `0` |
 *
 * A second touch within 120 ms of the first discards the half-started stroke
 * and becomes pan/zoom; a later second touch keeps the stroke drawn so far
 * and then pans. Marks are stored in image coordinates, so Fit and 1×–8× zoom
 * never move them.
 *
 * The marks are drawn as SVG in the image's own coordinate space, with the
 * same widths, halo and note face the PNG export rasterises.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { IconButton } from "../primitives/IconButton.js";
import { color, font } from "../tokens.js";
import {
  MARKUP_COLORS,
  MARKUP_HALO,
  MARKUP_MAX_ZOOM,
  MARKUP_NOTE_FAMILY,
  MARKUP_NOTE_WEIGHT,
  MARKUP_SECOND_TOUCH_MS,
  arrowHead,
  ellipseFrom,
  haloPx,
  markupSummary,
  noteAt,
  noteBaseline,
  notePx,
  strokePx,
  type Mark,
  type MarkupColor,
  type MarkupPoint,
  type MarkupSize,
  type MarkupTool,
  type MarkupWidth,
  type TextMark,
} from "./markup.js";

export interface MarkupView {
  /** 1 is Fit; at most 8. */
  zoom: number;
  /** The image point at the stage's centre. Omitted: the image's centre. */
  center?: MarkupPoint;
}

export interface MarkupCanvasProps {
  /** The source image URL. The canvas never draws it into the export. */
  src: string;
  /** The source's displayed size (after EXIF orientation). Omitted: the decoded image's. */
  size?: MarkupSize;
  marks: readonly Mark[];
  tool: MarkupTool;
  color: MarkupColor;
  width: MarkupWidth;
  /** A finished pen, arrow or ellipse mark. */
  onCommit: (mark: Mark) => void;
  /**
   * The Text tool was used on the image: `note` is the placed note under the
   * tap, if any, so the caller can open it for editing.
   */
  onNoteRequest: (at: MarkupPoint, note: TextMark | null) => void;
  /** The open note field, positioned at its anchor; the anchor's note is hidden while it is open. */
  noteField?: { at: MarkupPoint; editing?: string; node: ReactNode };
  /** The decoded image's own size, once known. */
  onLoad?: (natural: MarkupSize) => void;
  onError?: () => void;
  /** Keys the canvas does not use itself (tool shortcuts, undo). */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The opening view, for stories and restored sessions. */
  initialView?: MarkupView;
  /** Measures a note's text; the default uses a canvas with the note face. */
  measureText?: (text: string, font: string) => number;
  /** A new id for a committed mark. */
  newId?: () => string;
  /** Receives the focusable stage, e.g. for an overlay's initial focus. */
  focusTarget?: { current: HTMLElement | null };
  style?: CSSProperties;
}

interface ViewState {
  zoom: number;
  /** Translation of the image's top-left corner from the stage's, in CSS px. */
  tx: number;
  ty: number;
}

type Draft = Exclude<Mark, TextMark>;

type Gesture =
  | { kind: "none" }
  | { kind: "draw"; pointer: number; started: number; origin: MarkupPoint }
  | { kind: "pan"; pointer: number; client: MarkupPoint; view: ViewState }
  | { kind: "pinch"; ids: [number, number]; distance: number; mid: MarkupPoint; view: ViewState }
  | { kind: "note"; pointer: number; client: MarkupPoint }
  /** Fingers left over from a pinch: nothing happens until they lift. */
  | { kind: "rest" };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const distance = (a: MarkupPoint, b: MarkupPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: MarkupPoint, b: MarkupPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Arrows and ellipses shorter than this, in screen px, are a slip rather than a mark. */
const MIN_SHAPE_PX = 4;
const WIDE_STAGE = 600;

let measureCanvas: HTMLCanvasElement | null = null;
function canvasMeasure(text: string, font: string): number {
  if (typeof document === "undefined") return text.length * 0.6 * parseFloat(font.split(" ")[1] ?? "16");
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * 0.6 * parseFloat(font.split(" ")[1] ?? "16");
  ctx.font = font;
  return ctx.measureText(text).width;
}

let sequence = 0;
const defaultId = () => `mark-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

function MarkShape({ mark, size }: { mark: Mark; size: MarkupSize }) {
  const halo = haloPx(size);
  const hex = MARKUP_COLORS[mark.color].hex;
  if (mark.kind === "text") {
    const px = notePx(size);
    return (
      <text
        x={mark.at.x}
        y={mark.at.y + noteBaseline(size)}
        fontFamily={MARKUP_NOTE_FAMILY}
        fontWeight={MARKUP_NOTE_WEIGHT}
        fontSize={px}
        fill={hex}
        stroke={MARKUP_HALO}
        strokeWidth={halo * 2 + px * 0.06}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ whiteSpace: "pre" }}
        data-mark={mark.kind}
      >
        {mark.text}
      </text>
    );
  }
  const stroke = strokePx(mark.width, size);
  let d: string;
  if (mark.kind === "pen") {
    d = mark.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
    if (mark.points.length === 1) d += ` L${mark.points[0].x + 0.01} ${mark.points[0].y}`;
  } else if (mark.kind === "arrow") {
    const [left, right] = arrowHead(mark, stroke);
    d = `M${mark.from.x} ${mark.from.y} L${mark.to.x} ${mark.to.y} M${left.x} ${left.y} L${mark.to.x} ${mark.to.y} L${right.x} ${right.y}`;
  } else {
    const rx = Math.max(mark.w / 2, 0.5);
    const ry = Math.max(mark.h / 2, 0.5);
    const cx = mark.x + mark.w / 2;
    const cy = mark.y + mark.h / 2;
    d = `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  }
  return (
    <g data-mark={mark.kind} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={MARKUP_HALO} strokeWidth={stroke + halo * 2} />
      <path d={d} stroke={hex} strokeWidth={stroke} />
    </g>
  );
}

export function MarkupCanvas(p: MarkupCanvasProps) {
  const stage = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [natural, setNatural] = useState<MarkupSize | null>(null);
  const size = p.size ?? natural;
  const [stageSize, setStageSize] = useState<MarkupSize>({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState | null>(null);
  const [ease, setEase] = useState(false);
  const [draft, setDraftState] = useState<Draft | null>(null);
  // The draft is read when a gesture ends; a ref keeps that read free of
  // state-updater side effects, which StrictMode would run twice.
  const draftRef = useRef<Draft | null>(null);
  const setDraft = (next: Draft | null) => { draftRef.current = next; setDraftState(next); };
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const gesture = useRef<Gesture>({ kind: "none" });
  const latest = useRef(p);
  latest.current = p;
  const measure = p.measureText ?? canvasMeasure;
  const newId = p.newId ?? defaultId;

  // The scale that fits the whole image in the stage: zoom 1.
  const fit = size && stageSize.width > 0 && stageSize.height > 0
    ? Math.min(stageSize.width / size.width, stageSize.height / size.height)
    : 0;

  /** Keep the image on screen: centred when smaller than the stage, edge-bound when larger. */
  const bound = useCallback((next: ViewState): ViewState => {
    if (!size || fit === 0) return next;
    const zoom = clamp(next.zoom, 1, MARKUP_MAX_ZOOM);
    const scale = fit * zoom;
    const w = size.width * scale;
    const h = size.height * scale;
    const tx = w <= stageSize.width ? (stageSize.width - w) / 2 : clamp(next.tx, stageSize.width - w, 0);
    const ty = h <= stageSize.height ? (stageSize.height - h) / 2 : clamp(next.ty, stageSize.height - h, 0);
    return { zoom, tx, ty };
  }, [fit, size, stageSize.width, stageSize.height]);

  const centred = useCallback((zoom: number, center?: MarkupPoint): ViewState => {
    if (!size) return { zoom, tx: 0, ty: 0 };
    const c = center ?? { x: size.width / 2, y: size.height / 2 };
    const scale = fit * zoom;
    return bound({ zoom, tx: stageSize.width / 2 - c.x * scale, ty: stageSize.height / 2 - c.y * scale });
  }, [bound, fit, size, stageSize.width, stageSize.height]);

  useLayoutEffect(() => {
    const here = stage.current;
    if (!here) return;
    const read = () => setStageSize({ width: here.clientWidth, height: here.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(here);
    return () => observer.disconnect();
  }, []);

  // The first measurable layout opens at the initial view; later resizes keep the zoom.
  useLayoutEffect(() => {
    if (fit === 0) return;
    setView(current => current ? bound(current) : centred(p.initialView?.zoom ?? 1, p.initialView?.center));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, bound]);

  const v = view ?? { zoom: 1, tx: 0, ty: 0 };
  const scale = fit * v.zoom;

  const toImage = useCallback((clientX: number, clientY: number): MarkupPoint => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - v.tx) / scale, y: (clientY - rect.top - v.ty) / scale };
  }, [scale, v.tx, v.ty]);

  const zoomAbout = useCallback((zoom: number, screen: MarkupPoint, animate = false) => {
    setEase(animate);
    setView(current => {
      const from = current ?? { zoom: 1, tx: 0, ty: 0 };
      const next = clamp(zoom, 1, MARKUP_MAX_ZOOM);
      const oldScale = fit * from.zoom;
      const newScale = fit * next;
      const ix = (screen.x - from.tx) / oldScale;
      const iy = (screen.y - from.ty) / oldScale;
      return bound({ zoom: next, tx: screen.x - ix * newScale, ty: screen.y - iy * newScale });
    });
  }, [bound, fit]);

  const stageCentre = () => ({ x: stageSize.width / 2, y: stageSize.height / 2 });
  const zoomStep = (factor: number) => zoomAbout(v.zoom * factor, stageCentre(), true);
  const fitView = () => { setEase(true); setView(centred(1)); };

  // Ctrl/⌘ + wheel (and a trackpad pinch, which arrives as one) zooms; a plain
  // wheel pans a zoomed image. Non-passive so the page itself does not scroll.
  useEffect(() => {
    const here = stage.current;
    if (!here) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = here.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        setView(current => {
          const from = current ?? { zoom: 1, tx: 0, ty: 0 };
          const next = clamp(from.zoom * Math.exp(-event.deltaY * 0.01), 1, MARKUP_MAX_ZOOM);
          const sx = event.clientX - rect.left;
          const sy = event.clientY - rect.top;
          const ix = (sx - from.tx) / (fit * from.zoom);
          const iy = (sy - from.ty) / (fit * from.zoom);
          return bound({ zoom: next, tx: sx - ix * fit * next, ty: sy - iy * fit * next });
        });
      } else {
        setView(current => current ? bound({ ...current, tx: current.tx - event.deltaX, ty: current.ty - event.deltaY }) : current);
      }
      setEase(false);
    };
    here.addEventListener("wheel", wheel, { passive: false });
    return () => here.removeEventListener("wheel", wheel);
  }, [bound, fit]);

  const draftFrom = (point: MarkupPoint): Draft | null => {
    const { tool, color: c, width: w } = latest.current;
    const id = newId();
    if (tool === "pen") return { id, kind: "pen", color: c, width: w, points: [point] };
    if (tool === "arrow") return { id, kind: "arrow", color: c, width: w, from: point, to: point };
    if (tool === "ellipse") return { id, kind: "ellipse", color: c, width: w, x: point.x, y: point.y, w: 0, h: 0 };
    return null;
  };

  const extend = (mark: Draft, origin: MarkupPoint, point: MarkupPoint, shift: boolean): Draft => {
    if (mark.kind === "pen") {
      const last = mark.points[mark.points.length - 1];
      // Under half a screen pixel apart adds nothing but bytes.
      if (distance(last, point) * scale < 0.5) return mark;
      return { ...mark, points: [...mark.points, point] };
    }
    if (mark.kind === "arrow") return { ...mark, to: point };
    return { ...mark, ...ellipseFrom(origin, point, shift) };
  };

  /** Extend the draft to a client point, kept on the image. */
  const extendTo = (clientX: number, clientY: number, shift: boolean) => {
    const g = gesture.current;
    const current = draftRef.current;
    if (g.kind !== "draw" || !current || !size) return;
    const raw = toImage(clientX, clientY);
    const point = { x: clamp(raw.x, 0, size.width), y: clamp(raw.y, 0, size.height) };
    setDraft(extend(current, g.origin, point, shift));
  };

  const finish = (commit: boolean) => {
    const g = gesture.current;
    if (g.kind !== "draw") return;
    const current = draftRef.current;
    setDraft(null);
    if (!commit || !current) return;
    const big = current.kind === "pen"
      || (current.kind === "arrow" && distance(current.from, current.to) * scale >= MIN_SHAPE_PX)
      || (current.kind === "ellipse" && Math.max(current.w, current.h) * scale >= MIN_SHAPE_PX);
    if (big) latest.current.onCommit(current);
  };

  const startPinch = () => {
    const [[a, pa], [b, pb]] = [...pointers.current.entries()];
    gesture.current = { kind: "pinch", ids: [a, b], distance: Math.max(distance(pa, pb), 1), mid: midpoint(pa, pb), view: v };
    setPanning(true);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!size || fit === 0) return;
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    stage.current?.focus({ preventScroll: true });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer has no capture */ }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      if (g.kind === "draw") {
        // Within 120 ms the first finger was the start of a pinch, not a stroke.
        finish(event.timeStamp - g.started >= MARKUP_SECOND_TOUCH_MS);
      }
      startPinch();
      return;
    }
    if (pointers.current.size > 2 || g.kind !== "none") return;
    const client = { x: event.clientX, y: event.clientY };
    if (latest.current.tool === "hand" || spaceHeld || event.button === 1) {
      gesture.current = { kind: "pan", pointer: event.pointerId, client, view: v };
      setPanning(true);
      return;
    }
    const point = toImage(event.clientX, event.clientY);
    // Marks start on the image: the margin around a fitted image is not part
    // of the layer, and a mark there would vanish from the export.
    if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) {
      pointers.current.delete(event.pointerId);
      return;
    }
    if (latest.current.tool === "text") {
      gesture.current = { kind: "note", pointer: event.pointerId, client };
      return;
    }
    const mark = draftFrom(point);
    if (!mark) return;
    gesture.current = { kind: "draw", pointer: event.pointerId, started: event.timeStamp, origin: point };
    setDraft(mark);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    const g = gesture.current;
    if (g.kind === "draw" && g.pointer === event.pointerId) {
      extendTo(event.clientX, event.clientY, event.shiftKey);
    } else if (g.kind === "pan" && g.pointer === event.pointerId) {
      setEase(false);
      setView(bound({ ...g.view, tx: g.view.tx + event.clientX - g.client.x, ty: g.view.ty + event.clientY - g.client.y }));
    } else if (g.kind === "pinch") {
      const a = pointers.current.get(g.ids[0]);
      const b = pointers.current.get(g.ids[1]);
      if (!a || !b) return;
      const rect = stage.current!.getBoundingClientRect();
      const zoom = clamp(g.view.zoom * (distance(a, b) / g.distance), 1, MARKUP_MAX_ZOOM);
      const startScale = fit * g.view.zoom;
      // The image point under the starting midpoint stays under the moving one.
      const ix = (g.mid.x - rect.left - g.view.tx) / startScale;
      const iy = (g.mid.y - rect.top - g.view.ty) / startScale;
      const mid = midpoint(a, b);
      setEase(false);
      setView(bound({ zoom, tx: mid.x - rect.left - ix * fit * zoom, ty: mid.y - rect.top - iy * fit * zoom }));
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const g = gesture.current;
    if (g.kind === "draw" && g.pointer === event.pointerId) {
      // The release point is part of the mark, even with no move before it.
      if (!cancelled) extendTo(event.clientX, event.clientY, event.shiftKey);
      finish(!cancelled);
      gesture.current = { kind: "none" };
    } else if (g.kind === "pan" && g.pointer === event.pointerId) {
      gesture.current = { kind: "none" };
      setPanning(false);
    } else if (g.kind === "note" && g.pointer === event.pointerId) {
      gesture.current = { kind: "none" };
      const moved = distance(g.client, { x: event.clientX, y: event.clientY });
      if (!cancelled && moved < 10) requestNote(toImage(event.clientX, event.clientY));
    } else if (g.kind === "pinch") {
      gesture.current = pointers.current.size === 0 ? { kind: "none" } : { kind: "rest" };
      if (pointers.current.size === 0) setPanning(false);
    } else if (g.kind === "rest" && pointers.current.size === 0) {
      gesture.current = { kind: "none" };
      setPanning(false);
    }
  };

  const requestNote = (at: MarkupPoint) => {
    if (!size) return;
    const hit = noteAt(latest.current.marks, at, size, measure);
    latest.current.onNoteRequest(hit ? hit.at : at, hit);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== stage.current) return;
    const panBy = (dx: number, dy: number) => {
      event.preventDefault();
      setEase(true);
      setView(current => current ? bound({ ...current, tx: current.tx + dx, ty: current.ty + dy }) : current);
    };
    if (event.key === " ") { event.preventDefault(); setSpaceHeld(true); return; }
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomStep(1.5); return; }
    if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomStep(1 / 1.5); return; }
    if (event.key === "0" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); fitView(); return; }
    const step = Math.max(40, Math.min(stageSize.width, stageSize.height) * 0.1);
    if (event.key === "ArrowLeft") return panBy(step, 0);
    if (event.key === "ArrowRight") return panBy(-step, 0);
    if (event.key === "ArrowUp") return panBy(0, step);
    if (event.key === "ArrowDown") return panBy(0, -step);
    if (event.key === "Enter" && latest.current.tool === "text" && size) {
      event.preventDefault();
      requestNote({
        x: clamp((stageSize.width / 2 - v.tx) / scale, 0, size.width),
        y: clamp((stageSize.height / 2 - v.ty) / scale, 0, size.height),
      });
      return;
    }
    p.onKeyDown?.(event);
  };

  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") setSpaceHeld(false);
  };

  const summary = markupSummary(p.marks);
  const wide = stageSize.width >= WIDE_STAGE;
  const hidden = p.noteField?.editing;
  const visibleMarks = useMemo(() => p.marks.filter(m => m.id !== hidden), [p.marks, hidden]);

  const cursor = panning ? "grabbing" : p.tool === "hand" || spaceHeld ? "grab" : p.tool === "text" ? "text" : "crosshair";

  // The note field sits under its anchor, kept inside the stage.
  let fieldStyle: CSSProperties | undefined;
  if (p.noteField && size) {
    const fieldWidth = Math.min(340, Math.max(stageSize.width - 24, 0));
    const sx = p.noteField.at.x * scale + v.tx;
    const sy = p.noteField.at.y * scale + v.ty;
    fieldStyle = {
      position: "absolute",
      left: clamp(sx, 12, Math.max(12, stageSize.width - fieldWidth - 12)),
      top: clamp(sy + notePx(size) * scale * 0.7 + 6, 12, Math.max(12, stageSize.height - 64)),
      width: fieldWidth,
      zIndex: 2,
    };
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", ...p.style }} data-bk-markup-canvas="">
      <div
        ref={el => {
          stage.current = el;
          if (p.focusTarget) p.focusTarget.current = el;
        }}
        role="img"
        aria-label={summary}
        aria-describedby={helpId}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={e => onPointerEnd(e, false)}
        onPointerCancel={e => onPointerEnd(e, true)}
        onLostPointerCapture={e => onPointerEnd(e, true)}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => setSpaceHeld(false)}
        className="bk-markup-stage"
        style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none", cursor, outlineOffset: -2 }}
        data-zoom={v.zoom.toFixed(2)}
        data-tool={p.tool}
      >
        <div
          className="bk-markup-view"
          data-ease={ease ? "" : undefined}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: size?.width ?? 0,
            height: size?.height ?? 0,
            transformOrigin: "0 0",
            transform: `translate(${v.tx}px, ${v.ty}px) scale(${scale || 0.0001})`,
            visibility: size && fit ? "visible" : "hidden",
          }}
          data-bk-markup-view=""
        >
          <img
            src={p.src}
            alt=""
            draggable={false}
            onLoad={e => {
              const img = e.currentTarget;
              const measured = { width: img.naturalWidth, height: img.naturalHeight };
              setNatural(measured);
              p.onLoad?.(measured);
            }}
            onError={() => p.onError?.()}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", userSelect: "none", pointerEvents: "none" }}
          />
          {size ? (
            <svg
              viewBox={`0 0 ${size.width} ${size.height}`}
              width="100%"
              height="100%"
              style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
              aria-hidden="true"
              data-bk-markup-marks=""
            >
              {visibleMarks.map(mark => <MarkShape key={mark.id} mark={mark} size={size} />)}
              {draft ? <MarkShape mark={draft} size={size} /> : null}
            </svg>
          ) : null}
        </div>
      </div>
      <div id={helpId} hidden>
        Draw with the pointer or one finger. Two fingers, Pan, or Space and drag move the image. Plus and minus zoom, 0
        fits, arrow keys pan. With Text note, Enter places a note at the centre.
      </div>
      <div aria-live="polite" style={visuallyHidden}>{summary}</div>
      {p.noteField ? <div style={fieldStyle} data-bk-markup-note-slot="">{p.noteField.node}</div> : null}
      <div style={zoomBar} data-bk-markup-zoom="">
        {wide ? (
          <>
            <IconButton name="Zoom out" icon="zoom-out" tone="overlay" disabled={v.zoom <= 1} onClick={() => zoomStep(1 / 1.5)} />
            <span style={zoomReadout} aria-live="polite" data-bk-markup-zoom-readout="">{Math.round(v.zoom * 100)}%</span>
            <IconButton name="Zoom in" icon="zoom-in" tone="overlay" disabled={v.zoom >= MARKUP_MAX_ZOOM} onClick={() => zoomStep(1.5)} />
          </>
        ) : null}
        <IconButton name="Fit" icon="fit" tone="overlay" onClick={fitView} />
      </div>
    </div>
  );
}

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

const zoomBar: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 8,
  display: "flex",
  alignItems: "center",
  gap: 4,
  zIndex: 1,
};

const zoomReadout: CSSProperties = {
  minWidth: 44,
  textAlign: "center",
  font: `500 12px/1 ${font.mono}`,
  color: color.ink,
};
