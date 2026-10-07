import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Button, type ButtonProps } from "../../src/primitives/Button.js";
import { accent, color, token } from "../../src/tokens.js";
import type { ButtonTone } from "../../src/types.js";
import "../../src/styles.css";

const tones: ButtonTone[] = ["primary", "affirm", "ghost", "quiet", "danger", "suggest"];
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let previousTheme: string | undefined;
let previousViewport: { width: number; height: number } | undefined;

async function mount(theme: string, props: ButtonProps = {}) {
  previousTheme = document.documentElement.dataset.theme;
  previousViewport = { width: innerWidth, height: innerHeight };
  document.documentElement.dataset.theme = theme;
  await page.viewport(360, 844);
  host = document.createElement("div");
  host.style.cssText = "padding:24px;width:320px";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(Button, { label: "Sail for Ithaca", size: "sm", ...props })));
  const button = host.firstElementChild as HTMLElement;
  expect(button.textContent).toBe("Sail for Ithaca");
  expect(button.getBoundingClientRect().width).toBeGreaterThan(0);
  return button;
}

afterEach(async () => {
  await commands.buttonPointer("up");
  if (host) await userEvent.unhover(host);
  root?.unmount(); host?.remove(); root = undefined; host = undefined;
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
  if (previousViewport) await page.viewport(previousViewport.width, previousViewport.height);
  previousViewport = undefined;
});

function paint(element: HTMLElement) {
  const css = getComputedStyle(element);
  return { background: css.backgroundColor, border: css.borderTopColor, foreground: css.color };
}

/** Resolve the palette to check token wiring, not the palette's readability. */
function expectedPaint(tone: ButtonTone, hover: boolean) {
  const swatch = document.createElement("div");
  const rest = {
    primary: [accent.amber.fill, token("button-border-primary"), color.onFill],
    affirm: [accent.teal.fill, token("button-border-affirm"), color.onFill],
    ghost: ["transparent", color.edge, color.inkDim],
    quiet: ["transparent", color.edge, color.inkMute],
    danger: ["transparent", token("button-border-danger"), accent.red.ink],
    suggest: [token("button-tint-suggest"), token("button-border-suggest"), accent.amber.ink],
  }[tone];
  const values = hover ? ["bg", "border", "fg"].map(part => `var(--bk-button-hover-${part}-${tone})`) : rest;
  swatch.style.background = values[0]!;
  swatch.style.border = `1px solid ${values[1]}`;
  swatch.style.color = values[2]!;
  host!.append(swatch);
  try { return paint(swatch); } finally { swatch.remove(); }
}

for (const theme of ["dark", "light"]) {
  for (const tone of tones) {
    test(`shared Button native hover paint: ${theme} ${tone}`, async () => {
      const click = vi.fn();
      const button = await mount(theme, { tone, onClick: click });
      const rest = expectedPaint(tone, false), hover = expectedPaint(tone, true);
      // Some paper tints stay transparent; at least one paint channel must differ.
      expect(hover, "fixture has distinct rest and hover paint").not.toEqual(rest);
      expect(paint(button), "shared Button rest paint").toEqual(rest);
      await userEvent.hover(button);
      expect(button.matches(":hover")).toBe(true);
      expect(paint(button), "shared Button hover paint").toEqual(hover);
      await commands.buttonPointer("down");
      expect(button.matches(":active")).toBe(true);
      expect(getComputedStyle(button).transform).toBe("matrix(1, 0, 0, 1, 0, 1)");
      expect(getComputedStyle(button).filter).toBe("brightness(0.94)");
      expect(paint(button), "pressed keeps hover paint").toEqual(hover);
      await commands.buttonPointer("up");
      expect(click).toHaveBeenCalledTimes(1);
      await userEvent.unhover(button);
      expect(button.matches(":hover")).toBe(false);
      expect(paint(button), "shared Button leave paint").toEqual(rest);
      expect(getComputedStyle(button).transform).toBe("none");
      expect(getComputedStyle(button).filter).toBe("none");
    });

    for (const state of ["decorative", "disabled"] as const) {
      test(`shared Button inert paint: ${theme} ${tone} ${state}`, async () => {
        const click = vi.fn();
        const button = await mount(theme, { tone, onClick: state === "disabled" ? click : undefined, disabled: state === "disabled" });
        const rest = expectedPaint(tone, false);
        expect(paint(button)).toEqual(rest);
        // Disabled hit testing targets its host; hovering it still sends a real mouse.
        await userEvent.hover(state === "disabled" ? host! : button);
        expect(paint(button), "inert Button hover keeps rest paint").toEqual(rest);
        button.click();
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(click).not.toHaveBeenCalled();
        if (state === "disabled") {
          expect(button.getAttribute("aria-disabled")).toBe("true");
          expect(button.tabIndex).toBe(-1);
          expect(getComputedStyle(button).opacity).toBe("0.45");
          expect(getComputedStyle(button).pointerEvents).toBe("none");
        } else {
          expect(button.getAttribute("role")).toBeNull();
          expect(button.getAttribute("tabindex")).toBeNull();
          expect(button.className).toBe("");
        }
        expect(getComputedStyle(button).transform).toBe("none");
        await userEvent.unhover(host!);
        expect(paint(button), "inert Button leave keeps rest paint").toEqual(rest);
      });
    }
  }

  test(`shared Button keyboard focus and activation: ${theme}`, async () => {
    const click = vi.fn();
    const button = await mount(theme, { onClick: click });
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(button).outlineWidth).toBe("2px");
    expect(getComputedStyle(button).outlineOffset).toBe("2px");
    await userEvent.keyboard("{Enter} ");
    expect(click).toHaveBeenCalledTimes(2);
  });

  test(`shared Button aria-disabled explanation remains tappable: ${theme}`, async () => {
    const click = vi.fn();
    const button = await mount(theme, { onClick: click, ariaDisabled: true });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.tabIndex).toBe(0);
    await userEvent.hover(button);
    expect(paint(button)).toEqual(expectedPaint("primary", true));
    // Playwright's locator click refuses aria-disabled before sending input.
    // This API deliberately keeps its explanatory action tappable: send the
    // native mouse at the position already established by hover instead.
    await commands.buttonPointer("down");
    await commands.buttonPointer("up");
    expect(click).toHaveBeenCalledTimes(1);
  });

  for (const property of ["background", "border", "color", "border-free"] as const) {
    test(`shared Button caller-owned style wins: ${theme} ${property}`, async () => {
      const style = property === "background" ? { background: color.canvas } : property === "border" ? { border: `3px dashed ${color.ink}` } : property === "color" ? { color: color.ink } : { border: "none", padding: "6px 12px", width: "auto", flex: "1 1 0" };
      const button = await mount(theme, { tone: "affirm", onClick: vi.fn(), style });
      const rest = paint(button), hover = expectedPaint("affirm", true);
      await userEvent.hover(button);
      const painted = paint(button);
      if (property === "background") { expect(painted.background).toBe(rest.background); expect(painted.foreground).toBe(hover.foreground); }
      else if (property === "color") { expect(painted.foreground).toBe(rest.foreground); expect(painted.background).toBe(hover.background); }
      else if (property === "border") { expect(painted.border).toBe(rest.border); expect(getComputedStyle(button).borderTopStyle).toBe("dashed"); expect(getComputedStyle(button).borderTopWidth).toBe("3px"); }
      else { expect(getComputedStyle(button).borderTopWidth).toBe("0px"); expect(getComputedStyle(button).padding).toBe("6px 12px"); expect(button.style.width).toBe("auto"); }
      await userEvent.unhover(button);
      expect(paint(button)).toEqual(rest);
    });
  }

  for (const width of [320, 960]) {
    test(`shared Button palette review: ${theme} ${width}`, async () => {
      await mount(theme);
      await page.viewport(width, 900);
      host!.style.cssText = `padding:24px;width:${width}px;background:${color.canvas};display:grid;gap:12px`;
      host!.dataset.buttonGallery = "";
      flushSync(() => root!.render(createElement("div", { style: { display: "grid", gap: 12 } }, tones.map(tone => createElement(Button, { key: tone, tone, label: `Sail for Ithaca · ${tone}`, onClick: vi.fn(), block: false })))));
      expect(host!.querySelectorAll('[role="button"]')).toHaveLength(6);
      await commands.buttonCapture(`${theme}-${width}`);
    });
  }
}
