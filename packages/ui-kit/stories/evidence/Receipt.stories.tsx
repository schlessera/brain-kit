import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { quarantine } from "../../fixtures/actions.js";
import { fetchReceipt, forecastDiff } from "../../fixtures/runs.js";
import { Receipt } from "../../src/evidence/Receipt.js";
import type { Tone } from "../../src/types.js";
import { overflowing, stage, wide } from "../_stage.js";

const TONES: Tone[] = ["amber", "teal", "red", "purple", "gold", "blue", "neutral"];

const meta = preview.meta({
  title: "Evidence/Receipt",
  component: Receipt,
  decorators: [stage],
  args: {
    title: "Capability you'd grant",
    titleIcon: "capability",
    titleTone: "amber",
    rows: fetchReceipt.rows,
    footnote: fetchReceipt.footnote,
    footIcon: "scope",
    footTone: "teal",
    keyWidth: 56,
  },
  argTypes: {
    titleTone: { control: "select", options: TONES },
    footTone: { control: "select", options: TONES },
    keyWidth: { control: { type: "number", min: 40, max: 90, step: 1 } },
    titleIcon: { control: "text" },
    footIcon: { control: "text" },
  },
});

/**
 * The footnote is the load-bearing line: it is where the SCOPE of the grant is
 * stated, and the design's rule is that a capability without a stated scope is
 * a standing grant however it was labelled.
 */
export const Default = meta.story({});

/** The actual no-props path, rather than the story's inherited fixture rows. */
export const NoProps = meta.story({
  render: () => <Receipt />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("voyage/aeaea-landing.md")).toBeInTheDocument();
    await expect(canvas.getByText("Edit")).toBeInTheDocument();
  },
});

export const NoPropsWide = NoProps.extend({ parameters: wide });

/** A diff belongs inside the receipt when the fact being attested IS the
 * change: the reader should not have to hold two cards in their head. */
export const WithDiff = Default.extend({ args: { diff: forecastDiff } });

/** The hash mismatch, which is what `quarantined` escalates on. `neutral` here
 * is dim ink rather than the muted accent — Receipt's tone table is its own,
 * because an unremarkable value is still a value to read. */
export const HashMismatch = Default.extend({
  args: {
    title: "What changed",
    titleIcon: "quarantined",
    titleTone: "red",
    rows: quarantine.rows,
    diff: quarantine.diff,
    footnote: quarantine.escalation,
    footIcon: "policy",
    footTone: "red",
    keyWidth: 68,
  },
});

/** Where the material came in from, which is a different question from what it
 * says — the design keeps provenance on its own card for that reason. */
export const Provenance = Default.extend({
  args: {
    title: "Provenance",
    titleIcon: "trust",
    titleTone: "purple",
    rows: quarantine.provenance,
    footnote: "relayed material is never trusted on arrival",
    footIcon: "scope",
    footTone: "purple",
  },
});

/** No title, no footnote: the bare key/value block, for a receipt embedded in
 * a card that has already said what it is. */
export const RowsOnly = Default.extend({ args: { title: "", footnote: "" } });

export const Wide = Default.extend({ parameters: wide });

/**
 * A receipt in a 320px transcript, with the key column the stats answer uses
 * (#174). It needs no new prop: rows hold one figure each, so every value fits
 * beside its key, and the one value that cannot — an unbroken sha256 — keeps
 * the ruled `break-all` and runs over three lines complete, inside its column
 * (`docs/decisions/design-feedback.md`, "where truncation is allowed").
 */
const sha256 = "9f2c4e7a1b0d3c85e6f4a2917b3d0c5e8a1f4b7c2d9e0a3f6b8c1d4e7a0b3c6f";
const narrowRows = [
  { k: "file", v: "voyage/aeaea-landing.md" },
  { k: "sha256", v: sha256 },
  { k: "indexed", v: "22 Sep 2026 · 14:02" },
  { k: "links", v: "612" },
  { k: "broken", v: "23 · 3.8%", tone: "red" as const },
];

export const NarrowHash = meta.story({
  args: {
    title: "Provenance",
    titleIcon: "trust",
    titleTone: "purple",
    rows: narrowRows,
    footnote: "",
    keyWidth: 78,
  },
  // The box a block gets in the chat on a 320px phone: 320 - 2 x 16 of the
  // message list's padding (`tests/visual/receipt-value-budget.visual.tsx`).
  parameters: { stageWidth: 288 },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(sha256.length).toBe(64);

    const card = canvasElement.firstElementChild!.firstElementChild as HTMLElement;
    await expect(card.getBoundingClientRect().width).toBe(288);
    await expect(overflowing(card)).toEqual([]);

    for (const { k, v } of narrowRows) {
      const key = canvas.getByText(k);
      const value = canvas.getByText(v, { exact: false });
      await expect(value.textContent).toContain(v);
      await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth + 1);
      // Side by side: a value never runs under its key.
      await expect(value.getBoundingClientRect().left).toBeGreaterThanOrEqual(key.getBoundingClientRect().right);
      const lineHeight = parseFloat(getComputedStyle(value).lineHeight);
      const lines = Math.round(value.getBoundingClientRect().height / lineHeight);
      // Only the hash wraps; a one-figure row fits on one line.
      if (v === sha256) await expect(lines).toBeGreaterThanOrEqual(2);
      else await expect(lines).toBe(1);
    }

    const doc = document.documentElement;
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  },
});

/**
 * Keys wider than the column (#88). "capability", "signature" and "arguments"
 * are ordinary receipt keys and all exceed the default 56px. The column is
 * sized once, to the widest key, so every value starts at the same x and a
 * key's glyphs never reach the gutter. The key is drawn whole: a receipt row
 * IS the record, so it is never cut (`docs/decisions/design-feedback.md`,
 * "where truncation is allowed").
 */
const longKeyRows = [
  { k: "tool", v: "fetch" },
  { k: "capability", v: "network.read" },
  { k: "signature", v: "ed25519:7b3d0c5e8a1f", tone: "teal" as const },
  { k: "arguments", v: "url, headers" },
  { k: "scope", v: "this run only" },
  { k: "sha256", v: sha256, tone: "red" as const },
];

/** Each key's text ends at least the 10px gutter before its value's text
 * begins, and every value starts at the same x. Measured on the glyphs, not
 * the boxes: the defect was glyphs overflowing a correctly placed box. */
async function expectKeysClear(canvasElement: HTMLElement) {
  const values = [...canvasElement.querySelectorAll<HTMLElement>("[data-tone]")];
  await expect(values.length).toBeGreaterThan(0);
  const edge = (cell: Element, side: "left" | "right") => {
    const range = document.createRange();
    range.selectNodeContents([...cell.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!);
    const rects = [...range.getClientRects()];
    return side === "left" ? Math.min(...rects.map((r) => r.left)) : Math.max(...rects.map((r) => r.right));
  };
  for (const value of values) {
    const key = value.previousElementSibling!;
    await expect(edge(value, "left") - edge(key, "right")).toBeGreaterThanOrEqual(9.5);
    await expect(key.scrollWidth).toBeLessThanOrEqual(key.clientWidth);
  }
  const lefts = new Set(values.map((v) => Math.round(v.getBoundingClientRect().left)));
  await expect(lefts.size).toBe(1);
}

export const LongKeys = meta.story({
  args: { title: "Capability you'd grant", rows: longKeyRows, keyWidth: 56 },
  play: async ({ canvasElement }) => {
    await expectKeysClear(canvasElement);
    const card = canvasElement.firstElementChild!.firstElementChild as HTMLElement;
    await expect(overflowing(card)).toEqual([]);
  },
});

/** The same rows at the narrowest documented column. */
export const LongKeysNarrowColumn = LongKeys.extend({ args: { keyWidth: 40 } });

/** At a 320px phone: the key column costs the value column its extra width,
 * and a long hash still wraps inside its own column. */
export const LongKeysPhone = LongKeys.extend({
  parameters: { stageWidth: 288 },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const card = canvasElement.firstElementChild!.firstElementChild as HTMLElement;
    await expect(card.getBoundingClientRect().width).toBe(288);
    await expectKeysClear(canvasElement);
    await expect(sha256.length).toBe(64);
    const hash = canvas.getByText(sha256, { exact: false });
    await expect(hash.scrollWidth).toBeLessThanOrEqual(hash.clientWidth + 1);
    await expect(hash.getBoundingClientRect().height).toBeGreaterThan(parseFloat(getComputedStyle(hash).lineHeight));
    const doc = document.documentElement;
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  },
});

/** A key longer than the 90px cap wraps inside the column, whole, and only
 * its own row grows. */
export const KeyPastTheCap = meta.story({
  args: {
    title: "Certificate",
    titleIcon: "trust",
    titleTone: "purple",
    rows: [
      { k: "issuer", v: "Ithaca Harbour CA" },
      { k: "subject_alt_names", v: "aeaea.example, ithaca.example" },
      { k: "expires", v: "22 Sep 2027" },
    ],
    footnote: "",
    keyWidth: 90,
  },
  play: async ({ canvas, canvasElement }) => {
    await expectKeysClear(canvasElement);
    const key = canvas.getByText("subject_alt_names");
    await expect(key.getBoundingClientRect().width).toBeLessThanOrEqual(90);
    const range = document.createRange();
    range.selectNodeContents(key.firstChild!);
    const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    await expect(lines).toBe(2);
    await expect(range.toString()).toBe("subject_alt_names");
  },
});
