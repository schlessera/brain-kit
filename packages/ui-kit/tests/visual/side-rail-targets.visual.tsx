/// <reference types="@vitest/browser-playwright" />
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { SideRail, type RailItem } from "../../src/desktop/SideRail.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  root?.unmount(); host?.remove(); root = undefined; host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});

const labels = ["Chat", "Actions", "Files", "Graph", "Settings"];
function pointerScene() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  expect(matchMedia("(pointer: fine)").matches, "primary pointer premise").toBe(mode !== "coarse");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  return mode;
}
async function mount(width: number, height: number, expanded: boolean, theme: string, long = false) {
  await page.viewport(width, height);
  await commands.formViewport(width, height);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.style.cssText = `display:flex;width:${width}px;height:${height}px`;
  document.body.append(host);
  const callbacks = labels.map(() => vi.fn());
  const icons: RailItem["icon"][] = ["brain", "resolved", "files", "graph", "settings"];
  const items = labels.map((label, i): RailItem => ({
    icon: icons[i]!, label: long ? `${label} — OdysseusCrossingTheWineDarkSeaTowardIthaca` : label,
    shortcut: String(i + 1), badge: i === 1 ? "6" : undefined, onClick: callbacks[i],
  }));
  root = createRoot(host);
  flushSync(() => root!.render(createElement("div", { style: { display: "flex", width: "100%", height: "100%" } },
    createElement(SideRail, { items, active: 1, expanded }),
    createElement("main", { style: { flex: 1, minWidth: 0 } }, "Odysseus’s voyage"))));
  await document.fonts.ready;
  return { callbacks, tabs: [...host.querySelectorAll<HTMLElement>('[role="tab"]')] };
}
function geometry(tabs: HTMLElement[], expanded: boolean, coarse: boolean, short = false) {
  expect(tabs).toHaveLength(5);
  expect(host!.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  const rail = host!.firstElementChild!.firstElementChild!;
  expect(rail.getBoundingClientRect().width).toBe(expanded ? 208 : 60);
  const targets = tabs.map((tab) => tab.getBoundingClientRect());
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    // Dimension assertions come first: a 36px mutation must fail on height,
    // rather than an unrelated overflow or later interaction assertion.
    if (coarse) {
      expect(targets[i]!.height, `44px destination height: ${labels[i]}`).toBeGreaterThanOrEqual(44);
      expect(targets[i]!.width, `44px destination width: ${labels[i]}`).toBeGreaterThanOrEqual(44);
    } else if (!short) {
      expect(targets[i]!.height, "fine pointer density").toBe(36);
      expect(targets[i]!.width, "fine pointer width").toBe(expanded ? 183 : 43);
    }
    if (short) tab.scrollIntoView({ block: "nearest" });
    const r = tab.getBoundingClientRect();
    if (coarse) for (const x of [r.left + 0.5, r.right - 0.5]) for (const y of [r.top + 0.5, r.bottom - 0.5]) {
      expect(document.elementFromPoint(x, y)?.closest('[role="tab"]'), `destination corner hit: ${labels[i]} at ${x},${y}; row ${JSON.stringify(r.toJSON())}; list ${JSON.stringify(tab.parentElement!.getBoundingClientRect().toJSON())}`).toBe(tab);
    }
    if (expanded) expect(tab.scrollWidth, "label fits destination").toBeLessThanOrEqual(tab.clientWidth);
  }
  for (let i = 1; i < targets.length; i++) expect(targets[i]!.top - targets[i - 1]!.bottom, "neighbor separation").toBeGreaterThanOrEqual(3);
  expect(document.documentElement.scrollWidth, "document horizontal containment").toBeLessThanOrEqual(innerWidth);
  expect(document.documentElement.scrollHeight, "document vertical containment").toBeLessThanOrEqual(innerHeight);
}

for (const theme of ["dark", "light"]) for (const expanded of [false, true]) {
  for (const width of [320, 390, 480, 900, 1280, 1440]) {
    test(`rail destinations: ${theme}, ${width}, ${expanded ? "expanded" : "collapsed"}`, async () => {
      const mode = pointerScene();
      const { tabs } = await mount(width, 600, expanded, theme);
      geometry(tabs, expanded, mode !== "fine");
      if (width === 900 && mode === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/side-rail/${theme}-${expanded ? "expanded" : "collapsed"}.png` });
      // The fixture exposes a keyboard even in touch-only mode: geometry and
      // printed destination keys do not guess whether a hardware keyboard exists.
      if (expanded) for (let i = 0; i < tabs.length; i++) expect(tabs[i]!.textContent).toContain(String(i + 1));
      else for (let i = 0; i < tabs.length; i++) expect(tabs[i]!.getAttribute("aria-label")).toBe(labels[i]);
    });
  }
  test(`short rail and long labels: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { tabs } = await mount(390, 280, expanded, theme, true);
    geometry(tabs, expanded, mode !== "fine", true);
    if (mode === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/side-rail/short-${theme}-${expanded ? "expanded" : "collapsed"}.png` });
  });
  test(`rail manual activation: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { tabs, callbacks } = await mount(900, 600, expanded, theme);
    tabs[1]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tabs[2]);
    for (const callback of callbacks) expect(callback, "arrows never navigate").not.toHaveBeenCalled();
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[2]!.tabIndex).toBe(0);
    expect(host!.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(callbacks[2]).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(callbacks[2]).toHaveBeenCalledTimes(2);
    if (mode === "fine") await userEvent.click(tabs[3]!);
    else {
      const r = tabs[3]!.getBoundingClientRect();
      const point = { x: r.left + 0.5, y: r.bottom - 0.5 };
      await commands.rankTouch("touchStart", [point]);
      await commands.rankTouch("touchEnd", []);
    }
    await expect.poll(() => callbacks[3]!.mock.calls.length, { message: "pointer selects once" }).toBe(1);
    expect(callbacks[2]).toHaveBeenCalledTimes(2);
    await userEvent.tab();
    expect(host!.querySelector('[role="tablist"]')!.contains(document.activeElement)).toBe(false);
  });
  test(`short rail scrolling: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { tabs, callbacks } = await mount(900, 280, expanded, theme);
    const list = tabs[0]!.parentElement!;
    expect(list.scrollTop).toBe(0);
    if (mode !== "fine") {
      const r = list.getBoundingClientRect();
      const start = { x: r.left + r.width / 2, y: r.bottom - 8 };
      await commands.rankTouch("touchStart", [start]);
      for (let dy = 15; dy <= 90; dy += 15) await commands.rankTouch("touchMove", [{ x: start.x, y: start.y - dy }]);
      await commands.rankTouch("touchEnd", []);
      await expect.poll(() => list.scrollTop, { message: "native rail panning" }).toBeGreaterThan(0);
      for (const callback of callbacks) expect(callback, "panning never activates a destination").not.toHaveBeenCalled();
    }
    tabs[0]!.focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement, "End focuses the final destination").toBe(tabs[4]);
    expect(list.scrollTop, "roving focus scrolls the short rail").toBeGreaterThan(0);
    const r = tabs[4]!.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(bounds.top);
    expect(r.bottom).toBeLessThanOrEqual(bounds.bottom);
    for (const callback of callbacks) expect(callback, "End moves focus without navigation").not.toHaveBeenCalled();
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
  });
}
