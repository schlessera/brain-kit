/// <reference types="@vitest/browser-playwright" />
/**
 * The markup editor in a real browser (#3983): pointer and touch drawing,
 * source-coordinate stability across zoom and pan, notes, dismissal, the
 * exported PNG's pixels and dimensions, and the exact byte boundary.
 */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import { MarkupCanvas } from "../../src/images/MarkupCanvas.js";
import { MarkupEditor, type MarkupEditorProps } from "../../src/images/MarkupEditor.js";
import { MARKUP_COLORS, exportMarkupPng, type Mark, type MarkupExport, type MarkupTool } from "../../src/images/markup.js";
import { imageHeader } from "../../../common/src/image-header.js";
import "../../src/styles.css";

/** A 600 × 800 portrait stand-in for the raft photo: opaque everywhere. */
const SOURCE = { width: 600, height: 800 };
const SRC = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#2f6f8f"/><rect x="150" y="500" width="300" height="80" fill="#9b7448"/></svg>',
);

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const viewport = { width: innerWidth, height: innerHeight };
afterEach(async () => {
  if (root) flushSync(() => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  await commands.dictationMotion("no-preference");
  await page.viewport(viewport.width, viewport.height);
});

async function mount(node: React.ReactNode, width = 1280, height = 800) {
  await page.viewport(width, height);
  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
}

const stage = () => document.querySelector<HTMLElement>(".bk-markup-stage")!;
const view = () => document.querySelector<HTMLElement>("[data-bk-markup-view]")!;
async function ready() {
  await expect.poll(() => view() && getComputedStyle(view()).visibility, { message: "source decoded and fitted" }).toBe("visible");
}

/** The screen point of an image point, read from the rendered view. */
function screen(x: number, y: number) {
  const rect = view().getBoundingClientRect();
  return { x: rect.left + (x / SOURCE.width) * rect.width, y: rect.top + (y / SOURCE.height) * rect.height };
}

function fire(type: string, at: { x: number; y: number }, o: { id?: number; kind?: string; shift?: boolean } = {}) {
  stage().dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: at.x, clientY: at.y, pointerId: o.id ?? 1, pointerType: o.kind ?? "mouse",
    isPrimary: (o.id ?? 1) === 1, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, shiftKey: o.shift,
  }));
}
function drag(points: { x: number; y: number }[], o: { id?: number; kind?: string; shift?: boolean } = {}) {
  fire("pointerdown", points[0], o);
  for (const p of points.slice(1)) fire("pointermove", p, o);
  fire("pointerup", points[points.length - 1], o);
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function canvasScene(tool: MarkupTool, onCommit: (m: Mark) => void, marks: Mark[] = []) {
  return (
    <div style={{ width: 800, height: 700 }}>
      <MarkupCanvas src={SRC} size={SOURCE} marks={marks} tool={tool} color="red" width="medium" onCommit={onCommit} onNoteRequest={() => {}} />
    </div>
  );
}

async function decode(layer: MarkupExport) {
  const bitmap = await createImageBitmap(layer.png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, at: (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data] };
}

test("mouse drags commit pen, arrow and ellipse marks in source coordinates", async () => {
  // Mutation: drop the `/ scale` in toImage; the arrow's image coordinates are off.
  const commits: Mark[] = [];
  const onCommit = (m: Mark) => commits.push(m);
  await mount(canvasScene("arrow", onCommit));
  await ready();
  drag([screen(100, 100), screen(300, 200), screen(500, 400)]);
  expect(commits).toHaveLength(1);
  const arrow = commits[0] as Extract<Mark, { kind: "arrow" }>;
  expect(arrow.kind).toBe("arrow");
  expect(arrow.from.x).toBeCloseTo(100, 0);
  expect(arrow.from.y).toBeCloseTo(100, 0);
  expect(arrow.to.x).toBeCloseTo(500, 0);
  expect(arrow.to.y).toBeCloseTo(400, 0);

  flushSync(() => root!.render(canvasScene("ellipse", onCommit)));
  drag([screen(400, 100), screen(300, 300)], { shift: true });
  const ellipse = commits[1] as Extract<Mark, { kind: "ellipse" }>;
  expect(ellipse.kind).toBe("ellipse");
  expect(ellipse.w, "Shift constrains to a circle").toBeCloseTo(ellipse.h, 5);

  flushSync(() => root!.render(canvasScene("pen", onCommit)));
  drag([screen(50, 600), screen(80, 620), screen(120, 610), screen(160, 650)]);
  const pen = commits[2] as Extract<Mark, { kind: "pen" }>;
  expect(pen.kind).toBe("pen");
  expect(pen.points.length).toBeGreaterThanOrEqual(4);
  expect(pen.points.at(-1)!.x).toBeCloseTo(160, 0);
});

test("the release point completes a mark; a cancel or a start off the image draws nothing", async () => {
  // Mutation: drop the release-point extension; the arrow with no move is discarded.
  const commits: Mark[] = [];
  await commands.dictationMotion("reduce");
  await mount(canvasScene("arrow", m => commits.push(m)));
  await ready();
  fire("pointerdown", screen(100, 100));
  fire("pointerup", screen(400, 300));
  expect(commits).toHaveLength(1);
  const arrow = commits[0] as Extract<Mark, { kind: "arrow" }>;
  expect(arrow.to.x).toBeCloseTo(400, 0);
  expect(arrow.to.y).toBeCloseTo(300, 0);
  // A cancelled gesture commits nothing.
  fire("pointerdown", screen(100, 100));
  fire("pointermove", screen(300, 300));
  fire("pointercancel", screen(300, 300));
  expect(commits).toHaveLength(1);
  // The fitted image leaves a margin: a mark cannot start there, and a drag
  // that leaves the image stops at its edge.
  const rect = view().getBoundingClientRect();
  expect(rect.left, "the stage has a side margin").toBeGreaterThan(20);
  drag([{ x: rect.left - 10, y: rect.top + 50 }, screen(300, 300)]);
  expect(commits, "no mark starts in the margin").toHaveLength(1);
  drag([screen(300, 300), { x: rect.left - 50, y: rect.top + 10 }]);
  const edge = commits[1] as Extract<Mark, { kind: "arrow" }>;
  expect(edge.to.x, "kept on the image").toBe(0);
});

test("a mark keeps its source coordinates through zoom, pan and Fit", async () => {
  // Mutation: store screen coordinates on commit; the zoomed arrow's coordinates differ.
  const commits: Mark[] = [];
  // No easing: the screen positions below are read from the settled view.
  await commands.dictationMotion("reduce");
  await mount(canvasScene("arrow", m => commits.push(m)));
  await ready();
  const fitScale = view().getBoundingClientRect().width / SOURCE.width;
  drag([screen(200, 300), screen(400, 500)]);
  stage().focus();
  await userEvent.keyboard("+");
  await userEvent.keyboard("+");
  await expect.poll(() => Number(stage().dataset.zoom)).toBeGreaterThan(2);
  const left = view().getBoundingClientRect().left;
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => view().getBoundingClientRect().left, { message: "arrow key pans" }).toBeLessThan(left);
  expect(view().getBoundingClientRect().width / SOURCE.width).toBeGreaterThan(fitScale * 2);
  // Drawn again over the same source points at 2.25×, panned: the same image coordinates.
  drag([screen(200, 300), screen(400, 500)]);
  const [first, second] = commits as Extract<Mark, { kind: "arrow" }>[];
  for (const key of ["from", "to"] as const) {
    expect(second[key].x).toBeCloseTo(first[key].x, 0);
    expect(second[key].y).toBeCloseTo(first[key].y, 0);
  }
  await userEvent.keyboard("0");
  await expect.poll(() => stage().dataset.zoom).toBe("1.00");
  await expect.poll(() => view().getBoundingClientRect().width / SOURCE.width).toBeCloseTo(fitScale, 3);
});

test("a second touch within 120 ms discards the half-started stroke and pinches instead", async () => {
  // Mutation: commit regardless of the 120 ms window; the quick pinch leaves a stroke.
  const commits: Mark[] = [];
  await commands.dictationMotion("reduce");
  await mount(canvasScene("pen", m => commits.push(m)), 390, 800);
  await ready();
  const a = screen(250, 400);
  const b = screen(350, 400);
  fire("pointerdown", a, { id: 1, kind: "touch" });
  fire("pointermove", { x: a.x - 2, y: a.y }, { id: 1, kind: "touch" });
  fire("pointerdown", b, { id: 2, kind: "touch" });
  // Spread the fingers apart: zoom in.
  fire("pointermove", { x: a.x - 60, y: a.y }, { id: 1, kind: "touch" });
  fire("pointermove", { x: b.x + 60, y: b.y }, { id: 2, kind: "touch" });
  // A move is a continuous event: React renders it on its own schedule.
  await expect.poll(() => Number(stage().dataset.zoom), { message: "pinch zoomed" }).toBeGreaterThan(1.5);
  fire("pointerup", { x: a.x - 60, y: a.y }, { id: 1, kind: "touch" });
  // The remaining finger does not start drawing.
  fire("pointermove", { x: b.x + 90, y: b.y + 40 }, { id: 2, kind: "touch" });
  fire("pointerup", { x: b.x + 90, y: b.y + 40 }, { id: 2, kind: "touch" });
  expect(commits, "no stroke from a pinch").toHaveLength(0);

  // A second touch after the window keeps the stroke drawn so far, then pans.
  fire("pointerdown", a, { id: 3, kind: "touch" });
  fire("pointermove", { x: a.x + 30, y: a.y + 30 }, { id: 3, kind: "touch" });
  await wait(180);
  fire("pointerdown", b, { id: 4, kind: "touch" });
  fire("pointerup", b, { id: 4, kind: "touch" });
  fire("pointerup", { x: a.x + 30, y: a.y + 30 }, { id: 3, kind: "touch" });
  expect(commits.map(m => m.kind)).toEqual(["pen"]);
});

test("Pan moves the view with one finger and draws nothing", async () => {
  const commits: Mark[] = [];
  await commands.dictationMotion("reduce");
  await mount(canvasScene("hand", m => commits.push(m)));
  await ready();
  stage().focus();
  await userEvent.keyboard("++");
  await expect.poll(() => Number(stage().dataset.zoom)).toBeGreaterThan(2);
  const before = view().getBoundingClientRect().left;
  fire("pointerdown", { x: 400, y: 300 }, { kind: "touch" });
  fire("pointermove", { x: 300, y: 300 }, { kind: "touch" });
  await expect.poll(() => view().getBoundingClientRect().left, { message: "one finger pans" }).toBeCloseTo(before - 100, 0);
  fire("pointerup", { x: 300, y: 300 }, { kind: "touch" });
  expect(commits).toHaveLength(0);
});

function Editor(p: Partial<MarkupEditorProps>) {
  return <MarkupEditor open src={SRC} imagePath="photos/raft-at-ithaca.jpg" size={SOURCE} onSubmit={() => {}} onDismiss={() => {}} {...p} />;
}
const summary = () => stage().getAttribute("aria-label");

test("notes are placed, edited, deleted and never close the editor on Escape", async () => {
  // Mutation: let Escape propagate from the note field; the editor dismisses.
  const onDismiss = vi.fn();
  await mount(<Editor initialTool="text" onDismiss={onDismiss} />);
  await ready();
  const at = screen(100, 200);
  drag([at]);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "the field opens focused" }).toBe("Note text");
  await userEvent.keyboard("{Escape}");
  expect(onDismiss, "Escape closes the note, not the editor").not.toHaveBeenCalled();
  expect(document.querySelector('input[aria-label="Note text"]')).toBeNull();

  drag([at]);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Note text");
  await userEvent.keyboard("move the raft here{Enter}");
  await expect.poll(summary).toBe("1 mark: 1 note");
  expect(document.querySelector<HTMLElement>('[data-mark="text"]')!.textContent).toBe("move the raft here");

  // A tap on the placed note reopens it with its text, Place and Delete.
  const placed = document.querySelector<SVGTextElement>('[data-mark="text"]')!.getBoundingClientRect();
  drag([{ x: placed.left + placed.width / 2, y: placed.top + placed.height / 2 }]);
  await expect.poll(() => document.querySelector<HTMLInputElement>('input[aria-label="Note text"]')?.value).toBe("move the raft here");
  // An edit replaces the text in place.
  await userEvent.keyboard("{Control>}a{/Control}lash the logs{Enter}");
  await expect.poll(() => document.querySelector<HTMLElement>('[data-mark="text"]')?.textContent).toBe("lash the logs");
  await expect.poll(summary).toBe("1 mark: 1 note");
  drag([{ x: placed.left + placed.width / 2, y: placed.top + placed.height / 2 }]);
  await expect.poll(() => document.querySelector<HTMLInputElement>('input[aria-label="Note text"]')?.value).toBe("lash the logs");
  await userEvent.click(document.querySelector<HTMLElement>('[data-bk-markup-note-field] [data-bk-button]:last-of-type')!);
  await expect.poll(summary).toBe("No marks yet");
  // The 80-character limit holds.
  drag([at]);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Note text");
  await userEvent.keyboard("x".repeat(95));
  expect((document.activeElement as HTMLInputElement).value).toHaveLength(80);
});

test("empty submit is refused; dismissal with marks asks first and a decline exports nothing", async () => {
  // Mutation: dismiss immediately with marks; the alertdialog assertion fails.
  const onDismiss = vi.fn();
  const onSubmit = vi.fn();
  const exportLayer = vi.fn(exportMarkupPng);
  await mount(<Editor onDismiss={onDismiss} onSubmit={onSubmit} exportLayer={exportLayer} />);
  await ready();
  expect(document.activeElement, "the editor opens on the drawing stage").toBe(stage());
  const send = [...document.querySelectorAll<HTMLElement>("[data-bk-button]")].find(b => b.textContent === "Send markup")!;
  expect(send.getAttribute("aria-disabled")).toBe("true");
  drag([screen(100, 100), screen(200, 200)]);
  await expect.poll(summary).toBe("1 mark: 1 stroke");
  expect(send.getAttribute("aria-disabled")).toBeNull();
  await userEvent.click(document.querySelector<HTMLElement>("[data-bk-editor-close]")!);
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeTruthy();
  const ask = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(document.getElementById(ask.getAttribute("aria-labelledby")!)?.textContent).toBe("Discard 1 mark?");
  expect(document.activeElement?.textContent, "the safe choice holds the opening focus").toBe("Keep drawing");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(onDismiss).not.toHaveBeenCalled();
  await userEvent.click(document.querySelector<HTMLElement>("[data-bk-editor-close]")!);
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeTruthy();
  const discard = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [data-bk-button]')].find(b => b.textContent === "Discard")!;
  await userEvent.click(discard);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(exportLayer).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("Escape on an editor with no marks dismisses it at once", async () => {
  const onDismiss = vi.fn();
  await mount(<Editor onDismiss={onDismiss} />);
  await ready();
  stage().focus();
  await userEvent.keyboard("{Escape}");
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test("the export is the marks alone on transparency at the source's displayed size", async () => {
  // Mutation: drawImage the source into the export; the background pixel is opaque.
  const marks: Mark[] = [
    { id: "a", kind: "arrow", color: "red", width: "thick", from: { x: 100, y: 100 }, to: { x: 500, y: 100 } },
    { id: "e", kind: "ellipse", color: "cyan", width: "thick", x: 200, y: 300, w: 200, h: 200 },
    { id: "p", kind: "pen", color: "yellow", width: "thick", points: [{ x: 100, y: 700 }, { x: 500, y: 700 }] },
    { id: "t", kind: "text", color: "red", at: { x: 60, y: 760 }, text: "move the raft here" },
  ];
  const layer = await exportMarkupPng(marks, SOURCE);
  expect([layer.width, layer.height]).toEqual([600, 800]);
  expect(layer.bytes).toBe(layer.png.size);
  expect(layer.counts).toEqual({ pen: 1, arrow: 1, ellipse: 1, text: 1 });
  expect(layer.notes).toEqual(["move the raft here"]);
  const png = await decode(layer);
  expect([png.width, png.height]).toEqual([600, 800]);
  expect(png.at(300, 450)[3], "no source pixels inside the ellipse").toBe(0);
  expect(png.at(580, 400)[3], "transparent background").toBe(0);
  const hex = (name: keyof typeof MARKUP_COLORS) => {
    const v = MARKUP_COLORS[name].hex;
    return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
  };
  expect(png.at(300, 100).slice(0, 3), "the arrow's centre is red").toEqual(hex("red"));
  expect(png.at(300, 700).slice(0, 3), "the stroke is yellow").toEqual(hex("yellow"));
  expect(png.at(200, 400).slice(0, 3), "the ellipse's edge is cyan").toEqual(hex("cyan"));
  // The halo sits just outside the stroke: dark and opaque-ish.
  const halo = png.at(300, 100 - Math.ceil(0.014 * 600 / 2) - 1);
  expect(halo[3]).toBeGreaterThan(100);
  expect(Math.max(...halo.slice(0, 3))).toBeLessThan(80);
  // The note is drawn on the shared baseline: its ink sits around the anchor
  // line, not a note-height above or below it.
  const px = 0.035 * 600;
  const inkRows = (y0: number, y1: number) => {
    let n = 0;
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = 60; x < 260; x += 2) if (png.at(x, y)[3] > 0) n++;
    return n;
  };
  expect(inkRows(760 - px * 0.5, 760 + px * 0.5), "note ink around its anchor").toBeGreaterThan(40);
  expect(inkRows(760 - px * 1.6, 760 - px * 0.9), "nothing a line above").toBe(0);
  // Swapped (EXIF) dimensions are honoured as supplied.
  const landscape = await decode(await exportMarkupPng(marks.slice(0, 1), { width: 800, height: 600 }));
  expect([landscape.width, landscape.height]).toEqual([800, 600]);
});

test("a drawing discarded while it encodes is never sent", async () => {
  // Mutation: drop the session check after the export; the discarded layer is sent.
  const marks: Mark[] = [{ id: "a", kind: "arrow", color: "red", width: "medium", from: { x: 100, y: 100 }, to: { x: 400, y: 300 } }];
  let release: (layer: MarkupExport) => void = () => {};
  const exportLayer = vi.fn(() => new Promise<MarkupExport>(resolve => { release = resolve; }));
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  await mount(<Editor initialMarks={marks} exportLayer={exportLayer} onSubmit={onSubmit} onDismiss={onDismiss} />);
  await ready();
  await userEvent.click([...document.querySelectorAll<HTMLElement>("[data-bk-button]")].find(b => b.textContent === "Send markup")!);
  expect(exportLayer).toHaveBeenCalledTimes(1);
  await userEvent.click(document.querySelector<HTMLElement>("[data-bk-editor-close]")!);
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeTruthy();
  await userEvent.click([...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [data-bk-button]')].find(b => b.textContent === "Discard")!);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  release(await exportMarkupPng(marks, SOURCE));
  await wait(50);
  expect(onSubmit).not.toHaveBeenCalled();
});

test("Clear asks at three marks, and Keep drawing keeps an open note's edit", async () => {
  // Mutation: close the note before the Clear confirmation; the edit is lost.
  const marks: Mark[] = [
    { id: "a", kind: "arrow", color: "red", width: "medium", from: { x: 100, y: 100 }, to: { x: 400, y: 300 } },
    { id: "b", kind: "arrow", color: "red", width: "medium", from: { x: 100, y: 400 }, to: { x: 400, y: 500 } },
    { id: "n", kind: "text", color: "red", at: { x: 100, y: 650 }, text: "sail" },
  ];
  await mount(<Editor initialMarks={marks} initialTool="text" />);
  await ready();
  const placed = document.querySelector<SVGTextElement>('[data-mark="text"]')!.getBoundingClientRect();
  drag([{ x: placed.left + placed.width / 2, y: placed.top + placed.height / 2 }]);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Note text");
  await userEvent.keyboard(" red");
  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Clear marks"]')!);
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeTruthy();
  await userEvent.click([...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [data-bk-button]')].find(b => b.textContent === "Keep drawing")!);
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Note text"]')?.value).toBe("sail red");
  expect(summary()).toBe("3 marks: 2 arrows, 1 note");
});

test("the byte cap is exact: at the cap it is sent, one byte under it the editor stays open", async () => {
  // Mutation: compare with >= in submit; the at-cap submission is refused.
  const marks: Mark[] = [{ id: "a", kind: "arrow", color: "red", width: "medium", from: { x: 100, y: 100 }, to: { x: 400, y: 300 } }];
  const exact = (await exportMarkupPng(marks, SOURCE)).bytes;
  const sendIn = async (maxBytes: number) => {
    const onSubmit = vi.fn();
    await mount(<Editor initialMarks={marks} maxBytes={maxBytes} onSubmit={onSubmit} />);
    await ready();
    const send = [...document.querySelectorAll<HTMLElement>("[data-bk-button]")].find(b => b.textContent === "Send markup")!;
    await userEvent.click(send);
    await expect.poll(() => onSubmit.mock.calls.length > 0 || Boolean(document.querySelector("[data-bk-editor-error]"))).toBe(true);
    const error = document.querySelector("[data-bk-editor-error]")?.textContent ?? null;
    flushSync(() => root!.unmount());
    root = undefined;
    host?.remove();
    return { onSubmit, error };
  };
  const at = await sendIn(exact);
  expect(at.error).toBeNull();
  expect(at.onSubmit).toHaveBeenCalledTimes(1);
  expect(at.onSubmit.mock.calls[0][0].bytes).toBe(exact);
  const over = await sendIn(exact - 1);
  expect(over.onSubmit).not.toHaveBeenCalled();
  expect(over.error).toMatch(/^This markup is .+; the limit is .+\. Remove some freehand marks\.$/);
});

test("controls zoom with easing, and reduced motion removes it", async () => {
  await mount(canvasScene("pen", () => {}));
  await ready();
  stage().focus();
  await userEvent.keyboard("+");
  expect(view().hasAttribute("data-ease")).toBe(true);
  expect(getComputedStyle(view()).transitionDuration).toBe("0.16s");
  await commands.dictationMotion("reduce");
  expect(getComputedStyle(view()).transitionDuration).toBe("0s");
});

test("undo and redo by keyboard, and tool shortcuts", async () => {
  await mount(<Editor />);
  await ready();
  drag([screen(100, 100), screen(200, 200)]);
  await expect.poll(summary).toBe("1 mark: 1 stroke");
  stage().focus();
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(summary).toBe("No marks yet");
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect.poll(summary).toBe("1 mark: 1 stroke");
  await userEvent.keyboard("a");
  expect(document.querySelector('[aria-label="Arrow"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(stage().dataset.tool).toBe("arrow");
});

test("an EXIF orientation 6 photo is drawn upright and exported at the size the server reads (#3975)", async () => {
  // A real JPEG, stored landscape 320 × 240, with an EXIF orientation 6 segment
  // spliced in after SOI: displayed portrait, 240 × 320.
  const canvas = new OffscreenCanvas(320, 240);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2f6f8f"; ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = "#9b7448"; ctx.fillRect(0, 0, 80, 240);
  const stored = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const jpeg = new Uint8Array([...stored.subarray(0, 2), ...app1, ...stored.subarray(2)]);
  // The server's reader, the one `markupProblem` uses, says portrait.
  const header = imageHeader(jpeg)!;
  expect([header.width, header.height]).toEqual([240, 320]);
  const src = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
  try {
    // And so does the browser that draws it.
    const img = new Image(); img.src = src; await img.decode();
    expect([img.naturalWidth, img.naturalHeight], "the browser honours the orientation").toEqual([240, 320]);
    const onSubmit = vi.fn();
    await mount(<MarkupEditor open src={src} imagePath="photos/raft-portrait.jpg" size={{ width: 240, height: 320 }} onSubmit={onSubmit} onDismiss={() => {}} />, 390, 844);
    await ready();
    const rect = view().getBoundingClientRect();
    expect(rect.height / rect.width, "the stage shows the photo upright").toBeCloseTo(320 / 240, 1);
    const at = (x: number, y: number) => ({ x: rect.left + (x / 240) * rect.width, y: rect.top + (y / 320) * rect.height });
    drag([at(40, 40), at(200, 280)]);
    await expect.poll(summary).toBe("1 mark: 1 stroke");
    const send = [...document.querySelectorAll<HTMLElement>("[data-bk-button]")].find(b => b.textContent === "Send markup")!;
    await userEvent.click(send);
    await expect.poll(() => onSubmit.mock.calls.length).toBe(1);
    const layer = onSubmit.mock.calls[0][0] as MarkupExport;
    expect([layer.width, layer.height]).toEqual([240, 320]);
    const bytes = new Uint8Array(await layer.png.arrayBuffer());
    const written = imageHeader(bytes)!;
    expect([written.format, written.width, written.height, written.alpha]).toEqual(["png", 240, 320, true]);
    const png = await decode(layer);
    expect(png.at(10, 300)[3], "transparent away from the stroke, never the photo").toBe(0);
  } finally { URL.revokeObjectURL(src); }
});
