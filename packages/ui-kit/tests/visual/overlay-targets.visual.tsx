/// <reference types="@vitest/browser-playwright" />
import { createElement as h } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { DiscButton, DiscRow } from "../../src/chrome/DiscButton.js";
import { SuggestionChips, type SuggestionItem } from "../../src/conversation/SuggestionChips.js";

// D52 §7 in real Chromium under fine, coarse and mixed pointers (the rail
// projects, with reduced motion): the overlay discs and the welcome chips.
// Every case asserts its pointer premise first, then dimensions, then hits.

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  root?.unmount(); host?.remove(); root = undefined; host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});

function pointerScene() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  return mode;
}
const rect = (el: Element) => el.getBoundingClientRect();
const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function mount(width: number, height: number, theme: string, node: ReturnType<typeof h>) {
  await page.viewport(width, height);
  await commands.formViewport(width, height);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden`;
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
  await document.fonts.ready;
}

/** The message area: Odysseus's transcript, scrolled, with the overlay discs. */
function area(callbacks: { search: () => void; newChat: () => void; latest: () => void }, pair: boolean) {
  const lines = Array.from({ length: 40 }, (_, i) =>
    h("p", { key: i, style: { margin: "0 0 12px" } }, `Day ${i + 1} out of Troy: the crew rows past Ithaca's headland again, and Odysseus counts the oars.`));
  return h("div", { "data-area": "", style: { position: "absolute", inset: 0 } },
    h("div", { "data-scroller": "", tabIndex: 0, style: { height: "100%", overflowY: "auto", padding: "40px 16px 0", boxSizing: "border-box" } }, lines),
    h(DiscRow, { label: "Chat actions", style: { position: "absolute", top: 10, right: 16, zIndex: 1 } },
      pair ? h(DiscButton, { name: "Search the brain", icon: "search", tone: "mute", label: "Search", onClick: callbacks.search }) : null,
      h(DiscButton, { name: "New chat", icon: "compose", tone: "ink", label: "New chat", onClick: callbacks.newChat })),
    h(DiscButton, { name: "Scroll to latest", icon: "latest", anchor: "center", onClick: callbacks.latest,
      style: { position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", zIndex: 1 } }));
}

function discs() {
  return [...host!.querySelectorAll<HTMLButtonElement>("button.bk-disc")];
}
function assertDiscGeometry() {
  const buttons = discs();
  const bounds = rect(host!);
  for (const button of buttons) {
    const box = rect(button);
    const name = button.getAttribute("aria-label");
    // Dimensions first: a shrunken box must fail here, not on a later hit.
    expect(box.height, `44px target height: ${name}`).toBe(44);
    expect(box.width, `44px target width: ${name}`).toBeGreaterThanOrEqual(44);
    const paint = rect(button.firstElementChild!);
    expect(paint.height, `32px paint: ${name}`).toBe(32);
    expect(box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom, `inside the area: ${name}`).toBe(true);
    for (const x of [box.left + 1, box.right - 1]) for (const y of [box.top + 1, box.bottom - 1]) {
      expect(document.elementFromPoint(x, y)?.closest("button"), `corner hit: ${name} at ${x},${y}`).toBe(button);
    }
  }
  for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
    expect(intersects(rect(buttons[i]!), rect(buttons[j]!)), "no two disc boxes intersect").toBe(false);
  }
  expect(document.documentElement.scrollWidth, "document horizontal containment").toBeLessThanOrEqual(innerWidth);
}

/**
 * One real activation near an edge, not the centre: the reach is what is under
 * test. A disc's box is a rectangle, so it is tapped at a corner; a chip's
 * paint is its target and is pill-shaped, and Chromium hit-tests the rounded
 * shape, so a chip is tapped at the middle of its left edge.
 */
async function activate(button: HTMLElement, mode: string, edge: "corner" | "side" = "corner") {
  const r = rect(button);
  const point = edge === "corner" ? { x: r.left + 2, y: r.bottom - 2 } : { x: r.left + 4, y: r.top + r.height / 2 };
  if (mode === "fine") await commands.overlayMouse(point);
  else {
    await commands.rankTouch("touchStart", [point]);
    await commands.rankTouch("touchEnd", []);
  }
}

for (const theme of ["dark", "light"]) {
  for (const width of [320, 390, 480, 900, 1280, 1440]) {
    const pair = width < 480;
    test(`overlay discs: ${theme}, ${width}${pair ? ", Search + New chat" : ", New chat"}`, async () => {
      const mode = pointerScene();
      const callbacks = { search: vi.fn(), newChat: vi.fn(), latest: vi.fn() };
      await mount(width, 640, theme, area(callbacks, pair));
      host!.querySelector<HTMLElement>("[data-scroller]")!.scrollTop = 200;
      expect(discs()).toHaveLength(pair ? 3 : 2);
      assertDiscGeometry();
      for (const button of discs()) expect(button).toHaveAccessibleName(/^(Search the brain|New chat|Scroll to latest)$/);
      const newChat = host!.querySelector<HTMLElement>('[aria-label="New chat"]')!;
      await activate(newChat, mode);
      await expect.poll(() => callbacks.newChat.mock.calls.length, { message: "corner activates New chat once" }).toBe(1);
      expect(callbacks.search).not.toHaveBeenCalled();
      if (pair) {
        await activate(host!.querySelector<HTMLElement>('[aria-label="Search the brain"]')!, mode);
        await expect.poll(() => callbacks.search.mock.calls.length, { message: "corner activates Search once" }).toBe(1);
        expect(callbacks.newChat).toHaveBeenCalledTimes(1);
      }
      if (width === 320 && mode === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/overlay-discs/${theme}-320.png` });
    });
  }

  test(`overlay discs, keyboard expansion: ${theme}, 320`, async () => {
    pointerScene();
    const callbacks = { search: vi.fn(), newChat: vi.fn(), latest: vi.fn() };
    await mount(320, 640, theme, area(callbacks, true));
    const [search, newChat] = discs();
    const before = rect(newChat!);
    const label = newChat!.querySelector(".bk-disc-label")!;
    expect(rect(label).width, "the word is hidden at rest").toBe(0);
    search!.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement, "Search precedes New chat").toBe(newChat);
    // Reduced motion: the pill is open in the same frame, with no transition.
    expect(getComputedStyle(label).transitionDuration.split(",").every((d) => d.trim() === "0s"), "no transition under reduced motion").toBe(true);
    const after = rect(newChat!);
    expect(rect(label).width, "focus prints the word").toBeGreaterThan(30);
    expect(after.right, "the pill grows leftward").toBe(before.right);
    const paint = rect(newChat!.firstElementChild!);
    const word = rect(label);
    expect(word.left >= paint.left && word.right <= paint.right, "the word is inside the pill").toBe(true);
    expect(after.width - before.width, "the box grows by the word").toBeGreaterThanOrEqual(word.width);
    expect(intersects(rect(search!), after), "Search is pushed, never covered").toBe(false);
    const searchPaint = rect(search!.firstElementChild!);
    expect(document.elementFromPoint(searchPaint.left + searchPaint.width / 2, searchPaint.top + searchPaint.height / 2)?.closest("button"),
      "nothing paints over Search").toBe(search);
    expect(rect(search!).width).toBe(44);
    assertDiscGeometry();
    if (inject("railPointer") === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/overlay-discs/${theme}-320-expanded.png` });
    await userEvent.keyboard("{Enter}");
    expect(callbacks.newChat).toHaveBeenCalledTimes(1);
  });

  test(`overlay discs, short viewport: ${theme}, 320 × 140`, async () => {
    const mode = pointerScene();
    const callbacks = { search: vi.fn(), newChat: vi.fn(), latest: vi.fn() };
    // A soft keyboard leaves about 100px of message area: the top row and the
    // bottom disc must still not meet.
    await mount(320, 140, theme, area(callbacks, true));
    assertDiscGeometry();
    await activate(host!.querySelector<HTMLElement>('[aria-label="Scroll to latest"]')!, mode);
    await expect.poll(() => callbacks.latest.mock.calls.length).toBe(1);
  });
}

const chipItems = (onClick: () => void, also: () => void): SuggestionItem[] => [
  { label: "What's new?", icon: "digest", tone: "amber", cost: "spends", disabled: true, why: "needs the host", onClick },
  { label: "Search…", icon: "search", onClick: also },
  { label: "Add a note…", icon: "add", onClick: also },
];

for (const theme of ["dark", "light"]) for (const width of [320, 390, 900]) {
  test(`suggestion chips: ${theme}, ${width}`, async () => {
    const mode = pointerScene();
    const blocked = vi.fn();
    const enabled = vi.fn();
    await mount(width, 400, theme, h("div", { style: { padding: 16, maxWidth: 448 } },
      h(SuggestionChips, { label: "Start with", items: chipItems(blocked, enabled) })));
    const chips = [...host!.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      const r = rect(chip);
      if (mode === "fine") expect(r.height, "fine pointer keeps the compact chip").toBeLessThan(44);
      else expect(r.height, `44px coarse chip: ${chip.textContent}`).toBeGreaterThanOrEqual(44);
      for (const x of [r.left + 1, r.right - 1]) {
        expect(document.elementFromPoint(x, r.top + r.height / 2)?.closest('[role="button"]'), `chip hit: ${chip.textContent}`).toBe(chip);
      }
      expect(chip.scrollWidth, "nothing clipped").toBeLessThanOrEqual(chip.clientWidth);
    }
    for (let i = 1; i < chips.length; i++) expect(intersects(rect(chips[i - 1]!), rect(chips[i]!)), "chips never overlap").toBe(false);
    const [off, search] = chips;
    expect(off).toHaveAttribute("aria-disabled", "true");
    expect(off!.textContent).toContain("spends");
    expect(off!.textContent).toContain("needs the host");
    await activate(off!, mode, "side");
    off!.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await activate(search!, mode, "side");
    await expect.poll(() => enabled.mock.calls.length, { message: "the enabled neighbour still runs" }).toBe(1);
    expect(blocked, "a disabled chip rejects pointer and keyboard").not.toHaveBeenCalled();
    if (width === 320 && mode === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/overlay-discs/chips-${theme}-320.png` });
  });
}
