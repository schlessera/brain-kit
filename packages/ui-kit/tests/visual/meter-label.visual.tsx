/** Meter labels use their variant's real rendered width (#1130). */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles.css";
import { Meter, type MeterProps } from "../../src/primitives/Meter.js";
import type { Tone } from "../../src/types.js";

let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
let fonts: HTMLStyleElement;
let viewport: { width: number; height: number };
const tones: Tone[] = ["teal", "amber", "red", "gold", "purple", "blue", "neutral"];

beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(1440, 900);
  fonts = document.createElement("style");
  fonts.textContent = await commands.rankFooterFonts();
  document.head.append(fonts);
  await Promise.all([document.fonts.load('400 10px "JetBrains Mono"'), document.fonts.load('500 10px "JetBrains Mono"')]);
  await document.fonts.ready;
  expect(document.fonts.check('400 10px "JetBrains Mono"')).toBe(true);
  expect(document.fonts.check('500 10px "JetBrains Mono"')).toBe(true);
});

afterEach(() => {
  if (renderer) flushSync(() => renderer!.unmount());
  host?.remove();
  renderer = undefined;
  host = undefined;
});
afterAll(async () => {
  fonts?.remove();
  await page.viewport(viewport.width, viewport.height);
});

function mount(width: number, theme: string, props: MeterProps) {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  host.dataset.theme = theme;
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<Meter label="crew remaining" valueText="6 of 12" value={50} {...props} />));
  const meter = host.firstElementChild as HTMLElement;
  expect(meter.children).toHaveLength(3);
  const [label, track, value] = [...meter.children] as HTMLElement[];
  expect(label!.textContent).toBe(props.label ?? "crew remaining");
  expect(value!.textContent).toBe("6 of 12");
  return { label: label!, track: track!, value: value! };
}

for (const theme of ["dark", "light"]) for (const width of [320, 390, 720, 1280]) {
  for (const tone of tones) {
    test(`bar ${tone} ${theme} ${width}: label shares the track's leading edge and width`, () => {
      const { label, track, value } = mount(width, theme, { variant: "bar", tone, gradient: true });
      const l = label.getBoundingClientRect(), t = track.getBoundingClientRect(), v = value.getBoundingClientRect();
      expect(l.width, "stacked label uses the full track width").toBeCloseTo(t.width, 1);
      expect(l.left).toBeCloseTo(t.left, 1);
      expect(v.left).toBeCloseTo(t.left, 1);
      expect(getComputedStyle(label).textAlign).toBe("start");
      const text = document.createRange();
      text.selectNodeContents(label);
      expect(text.getClientRects()).toHaveLength(1);
      expect(t.top).toBeGreaterThanOrEqual(l.bottom);
      expect(v.top).toBeGreaterThanOrEqual(t.bottom);
      expect(track.firstElementChild!.getBoundingClientRect().width).toBeCloseTo(t.width / 2, 1);
    });
  }
  test(`row ${theme} ${width}: custom right-aligned gutter survives`, () => {
    const { label, track, value } = mount(width, theme, { variant: "row", labelWidth: 112 });
    const l = label.getBoundingClientRect(), t = track.getBoundingClientRect(), v = value.getBoundingClientRect();
    expect(l.width).toBe(112);
    expect(getComputedStyle(label).textAlign).toBe("right");
    expect(t.left).toBeGreaterThan(l.right);
    expect(v.left).toBeGreaterThan(t.right);
    expect(t.width).toBeGreaterThan(100);
  });
  test(`default bar ${theme} ${width}: a long label remains inside the track bounds`, () => {
    const { label, track } = mount(width, theme, { label: "Ithaca".repeat(50), labelWidth: 24 });
    const l = label.getBoundingClientRect(), t = track.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(label);
    const lines = [...text.getClientRects()];
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.left).toBeGreaterThanOrEqual(t.left - 1);
      expect(line.right).toBeLessThanOrEqual(t.right + 1);
    }
    expect(t.top).toBeGreaterThanOrEqual(l.bottom);
  });
}
