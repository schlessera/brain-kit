/// <reference types="@vitest/browser-playwright" />
import { createElement, createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Button } from "../../src/primitives/Button.js";
import { IconButton } from "../../src/primitives/IconButton.js";
import { TextButton } from "../../src/primitives/TextButton.js";
import { CONTROL_RING, ring } from "../../stories/_stage.js";
import "../../src/styles.css";
import { remainingButtonCases } from "../../../ui-react/tests/browser/remaining-buttons.cases.js";
import { settingsButtonCases } from "../../../ui-react/tests/browser/settings-buttons.cases.js";
import { OWNED, edgeOwners } from "../../../ui-react/tests/browser/hit-reach.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const beforeTheme = document.documentElement.dataset.theme;
afterEach(async () => {
  await commands.buttonPointer("up");
  if (host) await userEvent.hover(host, { position: { x: 1, y: 1 } });
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  host = undefined;
  root = undefined;
  if (beforeTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = beforeTheme;
});

function premise() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "native coarse pointer premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "native fine pointer premise").toBe(mode !== "coarse");
  return mode;
}

// Exercise the actual Settings and Share consumers under each native pointer.
settingsButtonCases(premise);
remainingButtonCases(premise);

async function mount(kind: "icon" | "text", theme: "dark" | "light", props: Record<string, unknown> = {}) {
  premise();
  await page.viewport(320, 400);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.style.cssText = "padding:40px;background:var(--bk-color-surface);font:500 12.5px/20px var(--bk-font-body);color:var(--bk-color-ink)";
  document.body.append(host);
  root = createRoot(host);
  const onClick = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  flushSync(() => root!.render(kind === "icon"
    ? createElement(IconButton, { name: "Open manifest", icon: "more", onClick, ref, ...props })
    : createElement(TextButton, { label: "Open manifest", onClick, ref, ...props })));
  const button = host.querySelector("button")!;
  expect(button, "native button mounted").not.toBeNull();
  return { button, onClick, ref };
}

/** `Button reach` (#3252): two stacked Buttons, `gap` apart, in a 320px stage. */
async function mountReach(size: "sm" | "md", gap: number, reach = true) {
  premise();
  await page.viewport(320, 400);
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;align-items:flex-start;gap:${gap}px;padding:40px;background:var(--bk-color-surface)`;
  document.body.append(host);
  root = createRoot(host);
  const onClick = [vi.fn(), vi.fn()];
  flushSync(() => root!.render([0, 1].map(i => createElement(Button, { key: i, size, block: false, reach, tone: "ghost", label: i ? "Lower the sail" : "Hoist the sail", onClick: onClick[i] }))));
  const buttons = [...host.querySelectorAll<HTMLElement>('[role="button"]')];
  expect(buttons, "two reaching Buttons mounted").toHaveLength(2);
  return { buttons, onClick };
}

// Paint heights from Button's own padding, line height and 1px border.
const PAINT = { sm: 28.375, md: 35.625 } as const;
// The least whole-pixel gap at which neither Button's reach covers the other's
// target edge: twice the reach, 15.6px for sm and 8.4px for md, rounded up.
const LEAST_GAP = { sm: 16, md: 9 } as const;

for (const size of ["sm", "md"] as const) {
  test(`Button ${size} reach keeps its paint and reaches 44px under a coarse pointer`, async () => {
    const { buttons } = await mountReach(size, LEAST_GAP[size]);
    const coarse = premise() !== "fine";
    for (const button of buttons) {
      expect(button.getBoundingClientRect().height, "paint keeps its design height").toBeCloseTo(PAINT[size], 2);
      expect(button.classList.contains("bk-hit"), "reach rides the shared utility").toBe(true);
      // Just inside each edge of a 44px target, and of the paint for a fine pointer.
      expect(edgeOwners(button, coarse ? 44 : 0), "every target edge belongs to its own Button").toEqual(OWNED);
    }
    // The reach stops at 44px: 1px past it belongs to neither Button.
    const box = buttons[0]!.getBoundingClientRect();
    const past = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 - (coarse ? 23 : box.height / 2 + 1));
    expect(buttons.filter(button => button.contains(past)).map(button => button.textContent), "nothing past the target").toEqual([]);
  });
  // A mouse click, not a tap: Chromium's touch adjustment snaps a tap near a
  // control onto it, so a tap passes with no reach at all. The mixed lane has
  // reach (any-pointer: coarse) and a mouse, so it proves the reach clicks.
  if (inject("railPointer") !== "coarse") test(`Button ${size} reach activates from its extended edge`, async () => {
    const { buttons, onClick } = await mountReach(size, LEAST_GAP[size]);
    const coarse = premise() !== "fine";
    const box = buttons[1]!.getBoundingClientRect();
    await commands.overlayMouse({ x: box.left + box.width / 2, y: box.top + box.height / 2 + (coarse ? 21 : box.height / 2 - 1) });
    expect(onClick[1], "the lower Button takes its own edge").toHaveBeenCalledTimes(1);
    expect(onClick[0]).not.toHaveBeenCalled();
  });
  test(`Button ${size} reach below the least gap steals a neighbour's edge (the probe has teeth)`, async () => {
    const { buttons } = await mountReach(size, LEAST_GAP[size] - 2);
    const owners = edgeOwners(buttons[0]!, premise() !== "fine" ? 44 : 0);
    if (premise() === "fine") expect(owners, "no reach, so no theft").toEqual(OWNED);
    else expect(owners.bottom, "the later Button's reach covers the earlier one's bottom edge").toBe('button "Lower the sail"');
  });
}
test("Button without reach or without a handler grows no target", async () => {
  const { buttons } = await mountReach("sm", 16, false);
  for (const button of buttons) expect(button.classList.contains("bk-hit")).toBe(false);
  flushSync(() => root!.render(createElement(Button, { size: "sm", block: false, reach: true, label: "Decorative" })));
  expect(host!.querySelector(".bk-hit"), "no handler, no invisible target").toBeNull();
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme} icon sm pointer box`, async () => {
    const { button } = await mount("icon", theme, { size: "sm" });
    const target = premise() === "fine" ? 28 : 44;
    expect(button.getBoundingClientRect().width, "small icon box width").toBe(target);
    expect(button.getBoundingClientRect().height, "small icon box height").toBe(target);
  });
  for (const kind of ["icon", "text"] as const) {
    test(`${theme} ${kind} focus ring`, async () => {
      const { button } = await mount(kind, theme);
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      expect(ring(button), "native control focus ring").toEqual(CONTROL_RING);
      expect(getComputedStyle(button).outlineColor).toBe(getComputedStyle(host!).color);
    });
    if (inject("railPointer") !== "coarse") test(`${theme} ${kind} native pressed state`, async () => {
      const { button } = await mount(kind, theme);
      await userEvent.hover(button);
      await commands.buttonPointer("down");
      expect(button.matches(":active"), "native press premise").toBe(true);
      expect(getComputedStyle(button).transform, "pressed translation").toBe("matrix(1, 0, 0, 1, 0, 1)");
      if (kind === "icon") expect(getComputedStyle(button).filter, "pressed icon brightness").toBe("brightness(0.94)");
    });
    test(`${theme} ${kind} disabled does not click`, async () => {
      const { button, onClick } = await mount(kind, theme, { disabled: true });
      if (premise() === "coarse") {
        const box = button.getBoundingClientRect();
        await commands.rankTap({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      } else {
        await userEvent.hover(button);
        await commands.buttonPointer("down");
        await commands.buttonPointer("up");
      }
      expect(onClick, "disabled native pointer is inert").not.toHaveBeenCalled();
      button.click();
      expect(onClick, "disabled native click is inert").not.toHaveBeenCalled();
      // Native keyboard activation also bypasses a disabled button.
      button.focus();
      await userEvent.keyboard("{Enter} ");
      expect(onClick).not.toHaveBeenCalled();
      expect(button.disabled).toBe(true);
      expect(getComputedStyle(button).opacity).toBe("0.45");
    });
    test(`${theme} ${kind} expanded ARIA`, async () => {
      const { button } = await mount(kind, theme, { expanded: true, haspopup: "menu", controls: "manifest-menu" });
      expect(button.getAttribute("aria-expanded"), "expanded disclosure state").toBe("true");
      expect(button.getAttribute("aria-haspopup")).toBe("menu");
      expect(button.getAttribute("aria-controls")).toBe("manifest-menu");
    });
    test(`${theme} ${kind} data hooks and ref`, async () => {
      const { button, ref, onClick } = await mount(kind, theme, { "data-manifest": "raft", "data-empty": "" });
      expect(button.dataset.manifest, "data hook reaches native button").toBe("raft");
      expect(button.dataset.empty).toBe("");
      expect(ref.current, "forwardRef reaches native button").toBe(button);
      expect(button.type).toBe("button");
      await userEvent.tab();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(onClick, "native Enter and Space activate").toHaveBeenCalledTimes(2);
      expect(onClick.mock.calls[0]![0].type).toBe("click");
    });
  }
  test(`${theme} icon expanded stays lit`, async () => {
    const { button } = await mount("icon", theme, { expanded: true });
    const reference = document.createElement("span");
    reference.style.cssText = "color:var(--bk-color-ink);background:var(--bk-color-raised)";
    host!.append(reference);
    expect(getComputedStyle(button).backgroundColor, "expanded trigger raised ground").toBe(getComputedStyle(reference).backgroundColor);
    expect(getComputedStyle(button).color, "expanded trigger ink").toBe(getComputedStyle(reference).color);
  });
  for (const tone of ["link", "meta", "inherit"] as const) {
    test(`${theme} text inline ${tone} target reaches 44px`, async () => {
      const { button, onClick } = await mount("text", theme, { inline: true, tone });
      // Inherit must keep its font while still reaching 44px in a short sentence line.
      if (tone === "inherit") host!.style.lineHeight = "16px";
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      // Check actual hit testing beyond the paint, not just a pseudo-element's CSS.
      for (const y of [box.top - 11.5, box.bottom + 11.5]) {
        expect(document.elementFromPoint(x, y), "inline vertical reach hits the button").toBe(button);
      }
      expect(box.height + 24, "inline target height").toBeGreaterThanOrEqual(44);
      await userEvent.click(button, { position: { x: box.width / 2, y: -11.5 } });
      expect(onClick, "inline reach activates the action").toHaveBeenCalledTimes(1);
    });
  }
}
