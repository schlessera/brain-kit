/**
 * The markup model, receipt rows and toolbar semantics (#3983). Pointer,
 * touch and PNG export run in a real browser: `tests/visual/markup-editor.visual.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkupFallback, MarkupResultCard, MARKUP_NOT_RENDERED, markupReceiptRows } from "../src/images/MarkupResultCard.js";
import { MarkupToolbar, MARKUP_EMPTY_HINT } from "../src/images/MarkupToolbar.js";
import {
  MARKUP_COLORS,
  MARKUP_MAX_BYTES,
  countMarks,
  describeCounts,
  ellipseFrom,
  markupBytesLabel,
  markupNotes,
  markupSummary,
  noteAt,
  notePx,
  overCapMessage,
  strokePx,
  type Mark,
} from "../src/images/markup.js";

/** The raft in Ithaca harbour, 3024 × 4032 after EXIF orientation 6. */
const RAFT = { width: 3024, height: 4032 };

const marks: Mark[] = [
  { id: "a1", kind: "arrow", color: "red", width: "medium", from: { x: 100, y: 100 }, to: { x: 900, y: 400 } },
  { id: "a2", kind: "arrow", color: "yellow", width: "thin", from: { x: 200, y: 900 }, to: { x: 300, y: 1200 } },
  { id: "e1", kind: "ellipse", color: "cyan", width: "thick", x: 1200, y: 1200, w: 400, h: 300 },
  { id: "n1", kind: "text", color: "red", at: { x: 1500, y: 2000 }, text: "move the raft here" },
];

describe("markup model", () => {
  test("widths and note size are fractions of the short edge", () => {
    expect(strokePx("thin", RAFT)).toBeCloseTo(12.096, 6);
    expect(strokePx("medium", RAFT)).toBeCloseTo(24.192, 6);
    expect(strokePx("thick", RAFT)).toBeCloseTo(42.336, 6);
    expect(notePx(RAFT)).toBeCloseTo(105.84, 6);
    // Same fraction on the swapped orientation: the short edge, not the width.
    expect(strokePx("medium", { width: 4032, height: 3024 })).toBeCloseTo(24.192, 6);
  });

  test("small images keep the proportional widths, with no pixel floor", () => {
    const small = { width: 100, height: 120 };
    expect(strokePx("thin", small)).toBeCloseTo(0.4, 9);
    expect(strokePx("medium", small)).toBeCloseTo(0.8, 9);
    expect(notePx(small)).toBeCloseTo(3.5, 9);
  });

  test("the fixed palette is red, yellow and cyan, red first", () => {
    expect(Object.entries(MARKUP_COLORS).map(([k, v]) => [k, v.hex])).toEqual([
      ["red", "#FF3B30"],
      ["yellow", "#FFD60A"],
      ["cyan", "#32D2F5"],
    ]);
  });

  test("counts, notes and the accessible summary follow the marks", () => {
    expect(countMarks(marks)).toEqual({ pen: 0, arrow: 2, ellipse: 1, text: 1 });
    expect(markupNotes(marks)).toEqual(["move the raft here"]);
    expect(describeCounts(countMarks(marks))).toBe("2 arrows · 1 ellipse · 1 note");
    expect(markupSummary(marks)).toBe("4 marks: 2 arrows, 1 ellipse, 1 note");
    expect(markupSummary([])).toBe("No marks yet");
    const pen: Mark = { id: "p", kind: "pen", color: "red", width: "medium", points: [{ x: 1, y: 1 }] };
    expect(markupSummary([pen])).toBe("1 mark: 1 stroke");
  });

  test("an ellipse drag normalises its box, and Shift makes a circle", () => {
    expect(ellipseFrom({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(ellipseFrom({ x: 0, y: 0 }, { x: 30, y: -10 }, true)).toEqual({ x: 0, y: -30, w: 30, h: 30 });
  });

  test("a tap on a placed note finds it; a tap beside it does not", () => {
    const measure = (text: string) => text.length * 50;
    expect(noteAt(marks, { x: 1600, y: 2000 }, RAFT, measure)?.id).toBe("n1");
    expect(noteAt(marks, { x: 1500 + 18 * 50 + 200, y: 2000 }, RAFT, measure)).toBeNull();
    expect(noteAt(marks, { x: 1600, y: 2300 }, RAFT, measure)).toBeNull();
  });

  test("the cap is the CLI's 50 MiB, stated in the editor's own units", () => {
    expect(MARKUP_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(markupBytesLabel(MARKUP_MAX_BYTES)).toBe("50 MB");
    expect(markupBytesLabel(212 * 1024)).toBe("212 KB");
    expect(overCapMessage(MARKUP_MAX_BYTES + 5 * 1024 * 1024)).toBe(
      "This markup is 55 MB; the limit is 50 MB. Remove some freehand marks.",
    );
  });
});

describe("markup receipt", () => {
  const payload = {
    imagePath: "photos/raft-at-ithaca.jpg",
    markupPath: ".brain/scratch/markup/raft-at-ithaca.3f9a1c2e.markup.png",
    width: 3024,
    height: 4032,
    bytes: 212 * 1024,
    marks: { pen: 0, arrow: 2, ellipse: 1, text: 1 },
    notes: ["move the raft here"],
    matchesSource: true,
  };

  test("rows state marks, notes, size, source and layer", () => {
    expect(markupReceiptRows(payload).map(r => [r.k, r.v])).toEqual([
      ["marks", "2 arrows · 1 ellipse · 1 note"],
      ["notes", "“move the raft here”"],
      ["size", "3024 × 4032 px · matches source"],
      ["source", "photos/raft-at-ithaca.jpg"],
      ["layer", ".brain/scratch/markup/raft-at-ithaca.3f9a1c2e.markup.png · 212 KB"],
    ]);
  });

  test("more than three notes quotes three and counts the rest; no notes drops the row", () => {
    const notes = ["sail", "mast", "oars", "rope", "the bow"];
    const rows = markupReceiptRows({ ...payload, notes, marks: { ...payload.marks, text: 5 } });
    expect(rows.find(r => r.k === "notes")?.v).toBe("“sail” · “mast” · “oars” · +2 more");
    expect(markupReceiptRows({ ...payload, notes: [] }).some(r => r.k === "notes")).toBe(false);
    // Unverified size claims no match.
    expect(markupReceiptRows({ ...payload, matchesSource: undefined }).find(r => r.k === "size")?.v).toBe("3024 × 4032 px");
  });

  test("without a layer URL the thumb says the markup is not rendered", () => {
    const html = renderToStaticMarkup(<MarkupResultCard {...payload} />);
    expect(html).toContain(MARKUP_NOT_RENDERED);
    // A drawing receipt, not a grant: none of Receipt's grant header or scope line.
    expect(html).not.toMatch(/Capability you|not a standing grant/);
    expect(html).not.toContain("data-markup-overlay");
    const withSrc = renderToStaticMarkup(<MarkupResultCard {...payload} markupSrc="/layer.png" />);
    expect(withSrc).toContain("data-markup-overlay");
    // Until the browser reports the load, the overlay is hidden, not passed off as drawn.
    expect(withSrc).not.toContain("data-markup-shown");
    expect(withSrc).not.toContain(MARKUP_NOT_RENDERED);
  });

  test("a refusal is stated from the result's own words", () => {
    const html = renderToStaticMarkup(
      <MarkupFallback imagePath="photos/raft-at-ithaca.jpg" reason=" The user closed the markup editor " />,
    );
    expect(html).toContain("no markup drawn on photos/raft-at-ithaca.jpg · The user closed the markup editor");
  });
});

describe("markup toolbar", () => {
  const noop = () => {};
  const props = {
    tool: "pen" as const, onTool: noop, color: "red" as const, onColor: noop, width: "medium" as const, onWidth: noop,
    canUndo: false, canRedo: false, canClear: false, onUndo: noop, onRedo: noop, onClear: noop, canSubmit: false, onSubmit: noop,
  };

  for (const layout of ["compact", "wide"] as const) {
    test(`${layout}: five named tool toggles, named swatches and widths, no rectangle or picker`, () => {
      const html = renderToStaticMarkup(<MarkupToolbar {...props} layout={layout} />);
      const pressed = [...html.matchAll(/aria-pressed="(true|false)" aria-label="([^"]+)"/g)].map(m => [m[2], m[1]]);
      expect(pressed).toEqual([["Pen", "true"], ["Arrow", "false"], ["Ellipse", "false"], ["Text note", "false"], ["Pan", "false"]]);
      expect(html).toContain('role="radiogroup" aria-label="Mark colour"');
      expect(html).toContain('role="radiogroup" aria-label="Stroke width"');
      const radios = [...html.matchAll(/role="radio" aria-checked="(true|false)" aria-label="([^"]+)"/g)].map(m => [m[2], m[1]]);
      expect(radios).toEqual([
        ["Red", "true"], ["Yellow", "false"], ["Cyan", "false"],
        ["Thin", "false"], ["Medium", "true"], ["Thick", "false"],
      ]);
      expect(html).not.toMatch(/rectangle|type="color"/i);
      for (const name of ["Undo", "Redo", "Clear marks"]) expect(html).toContain(`aria-label="${name}"`);
    });
  }

  test("Send markup needs a committed mark, and says so", () => {
    const empty = renderToStaticMarkup(<MarkupToolbar {...props} layout="compact" />);
    expect(empty).toContain(MARKUP_EMPTY_HINT);
    const send = (html: string) => /<div data-bk-button=""[^>]*>(?:(?!<\/div>).)*Send markup/s.exec(html)?.[0] ?? "";
    expect(send(empty)).toMatch(/aria-disabled="true" aria-describedby="[^"]+"/);
    const ready = renderToStaticMarkup(<MarkupToolbar {...props} layout="compact" canSubmit />);
    expect(ready).not.toContain(MARKUP_EMPTY_HINT);
    expect(send(ready)).toContain("Send markup");
    expect(send(ready)).not.toContain("aria-disabled");
  });
});
