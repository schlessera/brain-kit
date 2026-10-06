/// <reference types="@vitest/browser-playwright" />
/**
 * Hover text contrast of the real Button (#974), measured in Chromium with a
 * fine, a coarse and a mixed pointer (the three `rail-*` projects; the pointer
 * premise is asserted, never mocked).
 *
 * `button-hover.visual.tsx` proves hover paints the approved tokens. It cannot
 * tell whether those tokens are readable: paper's primary and affirm hovers
 * once painted canvas-coloured text on their lift fills (1.54:1 and 1.46:1)
 * and passed it. These tests read the computed colours a native pointer
 * leaves on a mounted control and hold them to WCAG's 4.5:1 for normal text.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Button } from "../../src/primitives/Button.js";
import { color } from "../../src/tokens.js";
import type { ButtonTone } from "../../src/types.js";
import { contrast, over, parse, type Rgb } from "../_contrast.js";
import "../../src/styles.css";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

const tones: ButtonTone[] = ["primary", "affirm", "ghost", "quiet", "danger", "suggest"];
/** The design's measured values (#974): on-fill text on each lift fill. */
const LIFT = { primary: "rgb(234, 179, 84)", affirm: "rgb(127, 208, 190)" } as const;
const ON_FILL = { light: "rgb(35, 31, 26)", dark: "rgb(12, 14, 18)" } as const;
const GROUNDS = { surface: color.surface, canvas: color.canvas } as const;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;

afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  await commands.buttonPointer("up");
  // Park the mouse on the host's padding, never over where the next test's
  // button appears. Hovering a point the mouse already rests on sends no
  // move, and after a native tap Chromium leaves that point unhovered.
  if (host) await userEvent.hover(host, { position: { x: 1, y: 1 } });
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});

function premise() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  return mode;
}

async function mount(theme: "light" | "dark", tone: ButtonTone, ground: keyof typeof GROUNDS) {
  document.documentElement.dataset.theme = theme;
  await page.viewport(360, 844);
  host = document.createElement("div");
  host.style.cssText = `padding:24px;width:320px;background:${GROUNDS[ground]}`;
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(Button, { label: "Approve this edit", size: "sm", tone, onClick: vi.fn() })));
  const button = host.firstElementChild as HTMLElement;
  expect(button.textContent).toBe("Approve this edit");
  expect(button.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(getComputedStyle(button).fontSize, "the 11.5px small size the issue measured").toBe("11.5px");
  return button;
}

/** The painted text and the opaque colour it sits on: a translucent hover over its ground. */
function measure(button: HTMLElement) {
  const css = getComputedStyle(button);
  const ground = parse(getComputedStyle(host!).backgroundColor);
  expect(ground.alpha, "the ground under the button is opaque").toBe(1);
  const background: Rgb = over(parse(css.backgroundColor), ground.rgb);
  const foreground = parse(css.color);
  expect(foreground.alpha, "button text is opaque").toBe(1);
  return { foreground: css.color, background: css.backgroundColor, ratio: contrast(foreground.rgb, background) };
}

for (const theme of ["light", "dark"] as const) {
  for (const tone of ["primary", "affirm"] as const) {
    const name = theme === "light" ? "paper hover foreground meets 4.5:1" : "dark hover foreground is unchanged and meets 4.5:1";
    test(`${name}: ${tone}`, async () => {
      premise();
      const button = await mount(theme, tone, "surface");
      const rest = measure(button);
      await userEvent.hover(button);
      expect(button.matches(":hover"), "native pointer is over the button").toBe(true);
      const hover = measure(button);
      expect(hover.background, "the lift fill is unchanged").toBe(LIFT[tone]);
      expect(hover.ratio, name).toBeGreaterThanOrEqual(4.5);
      expect(hover.foreground, "hover text is on-fill").toBe(ON_FILL[theme]);
      expect(hover.foreground, "hover keeps the rest ink").toBe(rest.foreground);
      await userEvent.unhover(button);
      expect(button.matches(":hover")).toBe(false);
      expect(measure(button), "leave restores the rest paint").toEqual(rest);
    });
  }

  test(`caller-owned colour and background win over the hover foreground: ${theme}`, async () => {
    premise();
    const button = await mount(theme, "primary", "surface");
    flushSync(() => root!.render(createElement(Button, { label: "Approve this edit", size: "sm", tone: "primary", onClick: vi.fn(), style: { color: color.inkDim, background: color.raised } })));
    const rest = measure(button);
    expect(rest.foreground, "caller colour differs from on-fill").not.toBe(ON_FILL[theme]);
    await userEvent.hover(button);
    expect(button.matches(":hover")).toBe(true);
    const hover = measure(button);
    expect(hover.foreground, "caller colour wins on hover").toBe(rest.foreground);
    expect(hover.background, "caller background wins on hover").toBe(rest.background);
  });

  for (const tone of tones) {
    for (const ground of ["surface", "canvas"] as const) {
      test(`hover text meets 4.5:1 for every tone: ${theme} ${tone} over ${ground}`, async () => {
        premise();
        const button = await mount(theme, tone, ground);
        await userEvent.hover(button);
        expect(button.matches(":hover")).toBe(true);
        expect(measure(button).ratio, `${theme} ${tone} hover text over ${ground}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
}

// A native touch tap activates the button without leaving Chromium's :hover
// behind, so a phone sees the rest paint after the tap. Hover paint under a
// coarse pointer comes from a mouse (the mixed scene and the hovers above).
// Last in the file: after a tap, Chromium can drop the next mouse hover.
for (const theme of ["light", "dark"] as const) {
  for (const tone of ["primary", "affirm"] as const) {
    test(`a native tap keeps readable rest paint: ${theme} ${tone}`, async () => {
      premise();
      const button = await mount(theme, tone, "surface");
      const rest = measure(button);
      const click = vi.fn();
      button.addEventListener("click", click);
      const box = button.getBoundingClientRect();
      await commands.rankTap({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      expect(click, "the tap reached the button").toHaveBeenCalledTimes(1);
      expect(button.matches(":hover"), "a tap leaves no hover").toBe(false);
      const tapped = measure(button);
      expect(tapped, "tapped paint is the rest paint").toEqual(rest);
      expect(tapped.ratio, `${theme} ${tone} text after a tap`).toBeGreaterThanOrEqual(4.5);
    });
  }
}
