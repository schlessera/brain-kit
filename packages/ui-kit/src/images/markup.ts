/**
 * The markup model: the marks an owner draws to say *what* should change in
 * an image (#3983, for the `request_image_markup` flow in #3975).
 *
 * A mask says where pixels may change; markup explains the change with
 * arrows, circles, freehand strokes and short notes. The layer is exported as
 * a transparent PNG at the source's displayed size and handed to
 * `brain image --markup`, which reads it beside the source. The source is
 * never flattened into the layer.
 *
 * Every mark is stored in IMAGE coordinates (source pixels after EXIF
 * orientation), so zooming and panning the editor never moves or loses one,
 * and the export is a straight rasterisation with no rescaling.
 *
 * Stroke widths and the note size are fractions of the image's SHORT edge, so
 * a mark looks the same drawn on a phone and exported at 4K.
 */

import { MARKUP_INK, font } from "../tokens.js";

export type MarkupTool = "pen" | "arrow" | "ellipse" | "text" | "hand";
export type MarkupColor = "red" | "yellow" | "cyan";
export type MarkupWidth = "thin" | "medium" | "thick";

export interface MarkupPoint {
  x: number;
  y: number;
}

interface MarkBase {
  /** Stable within one editor session; notes are edited by id. */
  id: string;
  color: MarkupColor;
}
export interface PenMark extends MarkBase {
  kind: "pen";
  width: MarkupWidth;
  points: MarkupPoint[];
}
export interface ArrowMark extends MarkBase {
  kind: "arrow";
  width: MarkupWidth;
  /** Tail, where the drag started. */
  from: MarkupPoint;
  /** Head. */
  to: MarkupPoint;
}
export interface EllipseMark extends MarkBase {
  kind: "ellipse";
  width: MarkupWidth;
  /** The bounding box, normalised so `w` and `h` are never negative. */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TextMark extends MarkBase {
  kind: "text";
  /** The note's left edge and vertical centre. */
  at: MarkupPoint;
  text: string;
}
export type Mark = PenMark | ArrowMark | EllipseMark | TextMark;

export interface MarkupSize {
  width: number;
  height: number;
}

/** Counts in the shape the tool result reports them (#3975). */
export interface MarkupCounts {
  pen: number;
  arrow: number;
  ellipse: number;
  text: number;
}

/**
 * The layer's byte cap: the CLI's `MARKUP_LIMITS.maxBytes`, 50 MiB, exactly
 * (maintainer ruling M2 on #3975). The editor measures the encoded PNG and
 * refuses above it; the server enforces it again.
 */
export const MARKUP_MAX_BYTES = 52_428_800;
/** One line, 80 characters at most. */
export const MARKUP_NOTE_MAX = 80;
/** Fit is 1×; the closest zoom is 8×. */
export const MARKUP_MAX_ZOOM = 8;
/** A second touch this soon after the first turns a half-started stroke into pan/zoom. */
export const MARKUP_SECOND_TOUCH_MS = 120;

export const MARKUP_COLORS: Record<MarkupColor, { hex: string; name: string }> = {
  red: { hex: MARKUP_INK.red, name: "Red" },
  yellow: { hex: MARKUP_INK.yellow, name: "Yellow" },
  cyan: { hex: MARKUP_INK.cyan, name: "Cyan" },
};
/** The dark halo every mark is drawn with, so it reads on light and dark photos. */
export const MARKUP_HALO = MARKUP_INK.halo;

export const MARKUP_WIDTHS: Record<MarkupWidth, { fraction: number; name: string }> = {
  thin: { fraction: 0.004, name: "Thin" },
  medium: { fraction: 0.008, name: "Medium" },
  thick: { fraction: 0.014, name: "Thick" },
};
/** Note text height as a fraction of the short edge. */
const MARKUP_NOTE_FRACTION = 0.035;
/** The kit's UI sans; the note face is loaded before rasterising. */
export const MARKUP_NOTE_FAMILY = font.body;
export const MARKUP_NOTE_WEIGHT = 600;

const shortEdge = (size: MarkupSize) => Math.max(0, Math.min(size.width, size.height));

/** A stroke width in image pixels. */
export function strokePx(width: MarkupWidth, size: MarkupSize): number {
  return MARKUP_WIDTHS[width].fraction * shortEdge(size);
}

/** The note font size in image pixels. */
export function notePx(size: MarkupSize): number {
  return MARKUP_NOTE_FRACTION * shortEdge(size);
}

/**
 * A note's baseline below its anchor. Both renderers draw on the alphabetic
 * baseline, which SVG and canvas agree on (their "middle" baselines differ),
 * offset so the anchor sits near the text's visual centre.
 */
export function noteBaseline(size: MarkupSize): number {
  return notePx(size) * 0.36;
}

/** The CSS font shorthand a note is drawn and measured with. */
function noteFont(size: MarkupSize): string {
  return `${MARKUP_NOTE_WEIGHT} ${notePx(size)}px ${MARKUP_NOTE_FAMILY}`;
}

/**
 * The halo's width in image pixels on each side of a stroke: about one screen
 * pixel at Fit on a phone, never less than one image pixel.
 */
export function haloPx(size: MarkupSize): number {
  return Math.max(1, shortEdge(size) / 400);
}

/** An arrow head's two barbs, sized from the stroke width. */
export function arrowHead(mark: Pick<ArrowMark, "from" | "to">, stroke: number): [MarkupPoint, MarkupPoint] {
  const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x);
  const length = Math.max(stroke * 4.5, 6);
  const spread = Math.PI / 7;
  return [
    { x: mark.to.x - length * Math.cos(angle - spread), y: mark.to.y - length * Math.sin(angle - spread) },
    { x: mark.to.x - length * Math.cos(angle + spread), y: mark.to.y - length * Math.sin(angle + spread) },
  ];
}

/** An ellipse from a drag, with Shift (desktop) constraining it to a circle. */
export function ellipseFrom(a: MarkupPoint, b: MarkupPoint, circle = false): Pick<EllipseMark, "x" | "y" | "w" | "h"> {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (circle) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

export function countMarks(marks: readonly Mark[]): MarkupCounts {
  const counts: MarkupCounts = { pen: 0, arrow: 0, ellipse: 0, text: 0 };
  for (const mark of marks) counts[mark.kind] += 1;
  return counts;
}

/** Note texts in placement order. */
export function markupNotes(marks: readonly Mark[]): string[] {
  return marks.filter((m): m is TextMark => m.kind === "text").map(m => m.text);
}

const NOUNS: Record<keyof MarkupCounts, [string, string]> = {
  arrow: ["arrow", "arrows"],
  ellipse: ["ellipse", "ellipses"],
  pen: ["stroke", "strokes"],
  text: ["note", "notes"],
};
const ORDER: (keyof MarkupCounts)[] = ["arrow", "ellipse", "pen", "text"];

/** "2 arrows · 1 ellipse · 1 note"; the empty layer reads "no marks". */
export function describeCounts(counts: MarkupCounts, separator: string = " · "): string {
  const parts = ORDER.filter(k => counts[k] > 0).map(k => `${counts[k]} ${NOUNS[k][counts[k] === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(separator) : "no marks";
}

function totalMarks(counts: MarkupCounts): number {
  return counts.pen + counts.arrow + counts.ellipse + counts.text;
}

/** The canvas's accessible summary: "4 marks: 2 arrows, 1 ellipse, 1 note". */
export function markupSummary(marks: readonly Mark[]): string {
  const counts = countMarks(marks);
  const total = totalMarks(counts);
  if (total === 0) return "No marks yet";
  return `${total} ${total === 1 ? "mark" : "marks"}: ${describeCounts(counts, ", ")}`;
}

/** Binary units, the same rule the mask receipt uses: 52,428,800 bytes is "50 MB". */
export function markupBytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The editor's refusal when an encoded layer is over the cap. */
export function overCapMessage(bytes: number, maxBytes: number = MARKUP_MAX_BYTES): string {
  return `This markup is ${markupBytesLabel(bytes)}; the limit is ${markupBytesLabel(maxBytes)}. Remove some freehand marks.`;
}

/** The text's drawn width, measured with the same font the export uses. */
type MeasureText = (text: string, font: string) => number;

/** A note's box in image coordinates, for tapping a placed note to edit it. */
function noteBox(mark: TextMark, size: MarkupSize, measure: MeasureText) {
  const px = notePx(size);
  const pad = px * 0.35;
  const width = measure(mark.text, noteFont(size));
  return { x: mark.at.x - pad, y: mark.at.y - px * 0.6 - pad, w: width + pad * 2, h: px * 1.2 + pad * 2 };
}

/** The topmost note under an image point. */
export function noteAt(marks: readonly Mark[], point: MarkupPoint, size: MarkupSize, measure: MeasureText): TextMark | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    if (mark.kind !== "text") continue;
    const box = noteBox(mark, size, measure);
    if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) return mark;
  }
  return null;
}

/** The 2D drawing surface the rasteriser needs; a real canvas context satisfies it. */
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function tracePath(ctx: Context2D, points: readonly MarkupPoint[]) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  // A tap is a dot, not a zero-length line that strokes to nothing.
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
}

function traceMark(ctx: Context2D, mark: Exclude<Mark, TextMark>, size: MarkupSize) {
  if (mark.kind === "pen") return tracePath(ctx, mark.points);
  if (mark.kind === "arrow") {
    const [left, right] = arrowHead(mark, strokePx(mark.width, size));
    ctx.beginPath();
    ctx.moveTo(mark.from.x, mark.from.y);
    ctx.lineTo(mark.to.x, mark.to.y);
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(mark.to.x, mark.to.y);
    ctx.lineTo(right.x, right.y);
    return;
  }
  ctx.beginPath();
  ctx.ellipse(mark.x + mark.w / 2, mark.y + mark.h / 2, Math.max(mark.w / 2, 0.5), Math.max(mark.h / 2, 0.5), 0, 0, Math.PI * 2);
}

/**
 * Draw marks onto a context whose coordinate space is image pixels. Each mark
 * is stroked twice: the dark halo underneath, then its colour.
 */
function rasterizeMarks(ctx: Context2D, marks: readonly Mark[], size: MarkupSize) {
  const halo = haloPx(size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const mark of marks) {
    const hex = MARKUP_COLORS[mark.color].hex;
    if (mark.kind === "text") {
      ctx.font = noteFont(size);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      const y = mark.at.y + noteBaseline(size);
      ctx.strokeStyle = MARKUP_HALO;
      ctx.lineWidth = halo * 2 + notePx(size) * 0.06;
      ctx.strokeText(mark.text, mark.at.x, y);
      ctx.fillStyle = hex;
      ctx.fillText(mark.text, mark.at.x, y);
      continue;
    }
    const stroke = strokePx(mark.width, size);
    traceMark(ctx, mark, size);
    ctx.strokeStyle = MARKUP_HALO;
    ctx.lineWidth = stroke + halo * 2;
    ctx.stroke();
    ctx.strokeStyle = hex;
    ctx.lineWidth = stroke;
    ctx.stroke();
  }
}

export interface MarkupExport {
  /** The encoded PNG. */
  png: Blob;
  /** Its exact length, the figure the cap is checked against. */
  bytes: number;
  width: number;
  height: number;
  counts: MarkupCounts;
  notes: string[];
}

/**
 * The fonts a note may use, loaded before rasterising. Returns once the face
 * is available or the document has no font loading (the canvas then draws
 * with whatever the family resolves to; byte-identical output across
 * unrelated browsers is not promised).
 */
async function loadNoteFont(doc: Document | undefined, size: MarkupSize, marks: readonly Mark[]) {
  const fonts = doc?.fonts;
  if (!fonts || !marks.some(m => m.kind === "text")) return;
  try {
    await fonts.load(noteFont(size), markupNotes(marks).join(" "));
  } catch {
    // A refused font load still lets the export proceed with the fallback face.
  }
}

/**
 * Rasterise marks onto transparency at exactly `size` and encode a PNG. The
 * source image is never drawn: the layer carries only the marks.
 */
export async function exportMarkupPng(
  marks: readonly Mark[],
  size: MarkupSize,
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
): Promise<MarkupExport> {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (!(width > 0 && height > 0)) throw new Error("The markup layer needs the source's size.");
  await loadNoteFont(doc, size, marks);
  let png: Blob;
  if (doc) {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not draw the markup.");
    rasterizeMarks(ctx, marks, size);
    png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("This browser could not encode the markup."))), "image/png"),
    );
  } else if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not draw the markup.");
    rasterizeMarks(ctx, marks, size);
    png = await canvas.convertToBlob({ type: "image/png" });
  } else {
    throw new Error("This environment cannot draw the markup.");
  }
  return { png, bytes: png.size, width, height, counts: countMarks(marks), notes: markupNotes(marks) };
}
