/// <reference types="@vitest/browser-playwright" />
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { SideRail, type RailAct, type RailItem } from "../../src/desktop/SideRail.js";

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
interface Extras { acts: RailAct[]; onOpenPalette: () => void }
async function mount(width: number, height: number, expanded: boolean, theme: string, long = false, extras?: Extras) {
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
    createElement(SideRail, { items, active: 1, expanded, ...extras }),
    createElement("main", { style: { flex: 1, minWidth: 0 } }, "Odysseus’s voyage"))));
  await document.fonts.ready;
  return { callbacks, tabs: [...host.querySelectorAll<HTMLElement>('[role="tab"]')] };
}
function geometry(tabs: HTMLElement[], expanded: boolean, coarse: boolean, short = false) {
  expect(tabs).toHaveLength(5);
  expect(tabs.filter((tab) => tab.tabIndex === 0), "one destination stop").toHaveLength(1);
  // The acts toolbar, when drawn, adds exactly one roving stop of its own.
  expect(host!.querySelectorAll('[tabindex="0"]')).toHaveLength(host!.querySelector('[role="toolbar"]') ? 2 : 1);
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

/** The scrollport's last item stays whole at the end of the scroll and one
 * pixel short of it. Chromium can draw a programmatic scroll that follows a
 * touch pan a pixel short for a frame: End after a short pan read 98 between
 * two frames at 99, and the last destination's bottom then measured 196
 * against the list's 195.5 (#999). That frame is timing-dependent, so the
 * guard sets the same offset directly. */
function expectWholeAtEnd(item: HTMLElement, scroller: HTMLElement, what: string) {
  const max = scroller.scrollHeight - scroller.clientHeight;
  expect(max, `${what}: the scrollport overflows`).toBeGreaterThan(1);
  for (const offset of [max, max - 1]) {
    scroller.scrollTop = offset;
    expect(scroller.scrollTop, `${what}: scrolled to ${offset}`).toBe(offset);
    const r = item.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    expect(r.bottom, `${what} whole at scrollTop ${offset} of ${max}`).toBeLessThanOrEqual(bounds.bottom);
  }
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
    // The scrollport is the rail's middle, which holds the tablist (and acts).
    const list = tabs[0]!.closest<HTMLElement>(".bk-side-rail-middle")!;
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
    expectWholeAtEnd(tabs[4]!, list, "final destination");
    for (const callback of callbacks) expect(callback, "End moves focus without navigation").not.toHaveBeenCalled();
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
  });
}

/* ── Acts and All commands (D52 §1, #944) ─────────────────────────────────── */

async function mountActs(width: number, height: number, expanded: boolean, theme: string, why?: string, long = false) {
  const actCallbacks = [vi.fn(), vi.fn(), vi.fn()];
  const palette = vi.fn();
  const tail = long ? " — OdysseusCrossingTheWineDarkSeaTowardIthaca" : "";
  const acts: RailAct[] = [
    { icon: "search", label: `Search${tail}`, name: "Search the brain", onClick: actCallbacks[0] },
    { icon: "add", label: `Add a note${tail}`, onClick: actCallbacks[1] },
    { icon: "digest", label: `Daily briefing${tail}`, cost: "spends", why, onClick: actCallbacks[2] },
  ];
  const mounted = await mount(width, height, expanded, theme, long, { acts, onOpenPalette: palette });
  const toolbar = host!.querySelector<HTMLElement>('[role="toolbar"]')!;
  expect(toolbar, "acts toolbar").not.toBeNull();
  expect(toolbar.getAttribute("aria-label")).toBe("Acts");
  expect(toolbar.getAttribute("aria-orientation")).toBe("vertical");
  const actButtons = [...toolbar.querySelectorAll<HTMLElement>("button")];
  const all = host!.querySelector<HTMLElement>('button[aria-keyshortcuts="Meta+K"]')!;
  expect(all, "All commands button").not.toBeNull();
  return { ...mounted, actCallbacks, palette, toolbar, actButtons, all };
}

/** A real mouse press, or a real touch at the target's inset corner. The mouse
 * goes through hover plus a raw down/up, because Playwright's `click` refuses
 * an `aria-disabled` target, and a forced click would prove nothing. */
async function press(el: HTMLElement, mode: string) {
  if (mode === "fine") {
    await userEvent.hover(el);
    await commands.buttonPointer("down");
    await commands.buttonPointer("up");
    return;
  }
  const r = el.getBoundingClientRect();
  await commands.rankTouch("touchStart", [{ x: r.left + 0.5, y: r.bottom - 0.5 }]);
  await commands.rankTouch("touchEnd", []);
}

/** `aria-label`, else the text outside `aria-hidden` — enough of the name
 * computation for these buttons, whose ⌘K cap is hidden from the name. */
function nameOf(el: HTMLElement): string {
  const label = el.getAttribute("aria-label");
  if (label !== null) return label;
  const copy = el.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent ?? "";
}

function actTargets(els: HTMLElement[], names: string[], expanded: boolean, coarse: boolean) {
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    const r = el.getBoundingClientRect();
    // Dimensions first, so a density mutation fails here and not on a hit test.
    if (coarse) {
      expect(r.height, `44px act height: ${names[i]}`).toBeGreaterThanOrEqual(44);
      expect(r.width, `44px act width: ${names[i]}`).toBeGreaterThanOrEqual(44);
      for (const x of [r.left + 0.5, r.right - 0.5]) for (const y of [r.top + 0.5, r.bottom - 0.5]) {
        expect(document.elementFromPoint(x, y)?.closest("button"), `act corner hit: ${names[i]} at ${x},${y}`).toBe(el);
      }
    } else {
      expect(r.height, `fine pointer act density: ${names[i]}`).toBe(36);
      expect(r.width, "fine pointer act width").toBe(expanded ? 183 : 43);
    }
    expect(nameOf(el), `act name: ${names[i]}`).toBe(names[i]);
    if (expanded) expect(el.scrollWidth, "label fits act").toBeLessThanOrEqual(el.clientWidth);
  }
}

const EXPANDED_NAMES = ["Search the brain", "Add a note", "Daily briefing, spends", "All commands"];
const COLLAPSED_NAMES = ["Search the brain", "Add a note", "All commands"];

for (const theme of ["dark", "light"]) for (const expanded of [false, true]) {
  const names = expanded ? EXPANDED_NAMES : COLLAPSED_NAMES;
  for (const width of [320, 390, 480, 900, 1280, 1440]) {
    test(`rail acts: ${theme}, ${width}, ${expanded ? "expanded" : "collapsed"}`, async () => {
      const mode = pointerScene();
      const { tabs, actButtons, all } = await mountActs(width, 600, expanded, theme);
      // The destinations are untouched by the acts beneath them.
      geometry(tabs, expanded, mode !== "fine");
      // Collapsed draws only the effect-free acts: the briefing's `spends`
      // cannot be printed in a 44px column (V6).
      expect(actButtons.map((b) => b.getAttribute("aria-label"))).toEqual(names.slice(0, -1));
      actTargets([...actButtons, all], names, expanded, mode !== "fine");
      if (expanded) expect(actButtons[2]!.textContent, "spends printed at rest").toContain("spends");
      else expect(host!.textContent).not.toContain("spends");
      expect(all.textContent, "⌘K printed on every pointer").toContain("⌘K");
      // The sibling pane takes the remainder; neither claims the row.
      const main = host!.querySelector("main")!;
      expect(Math.round(main.getBoundingClientRect().width), "sibling pane width").toBe(width - (expanded ? 208 : 60));
      if (width === 900 && mode === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/side-rail/acts-${theme}-${expanded ? "expanded" : "collapsed"}.png` });
    });
  }

  test(`rail acts, 360px tall: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { actButtons, all, palette, actCallbacks } = await mountActs(900, 360, expanded, theme);
    const rail = host!.querySelector<HTMLElement>(".bk-side-rail")!;
    const middle = rail.querySelector<HTMLElement>(".bk-side-rail-middle")!;
    expect(middle.scrollHeight, "the middle overflows at 360").toBeGreaterThan(middle.clientHeight);
    expect(middle.scrollTop).toBe(0);
    // Pinned: the wordmark and All commands sit in the rail, not the scrollport.
    expect(middle.contains(all)).toBe(false);
    const mark = rail.firstElementChild!.getBoundingClientRect();
    expect(mark.top, "wordmark visible").toBeGreaterThanOrEqual(0);
    const a = all.getBoundingClientRect();
    expect(a.bottom, "All commands inside the viewport").toBeLessThanOrEqual(innerHeight);
    expect(document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)?.closest("button")).toBe(all);
    expect(document.documentElement.scrollHeight, "document vertical containment").toBeLessThanOrEqual(innerHeight);

    actButtons[0]!.focus();
    await userEvent.keyboard("{End}");
    const last = actButtons[actButtons.length - 1]!;
    expect(document.activeElement).toBe(last);
    const r = last.getBoundingClientRect();
    const bounds = middle.getBoundingClientRect();
    expect(r.top, "End scrolls the last act into the middle").toBeGreaterThanOrEqual(bounds.top);
    expect(r.bottom).toBeLessThanOrEqual(bounds.bottom);
    expect(middle.scrollTop).toBeGreaterThan(0);
    expectWholeAtEnd(last, middle, "last act");
    for (const callback of actCallbacks) expect(callback).not.toHaveBeenCalled();

    await press(all, mode);
    await expect.poll(() => palette.mock.calls.length, { message: "All commands opens once" }).toBe(1);
  });

  test(`rail acts keyboard and pointer: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { tabs, callbacks, actButtons, actCallbacks, all, palette } = await mountActs(900, 600, expanded, theme);
    (document.activeElement as HTMLElement | null)?.blur();
    // Three stops: the destinations, the acts, All commands. Then out.
    await userEvent.tab();
    expect(document.activeElement).toBe(tabs[1]);
    await userEvent.tab();
    expect(document.activeElement).toBe(actButtons[0]);
    await userEvent.tab();
    expect(document.activeElement).toBe(all);
    await userEvent.tab();
    expect(host!.querySelector(".bk-side-rail")!.contains(document.activeElement)).toBe(false);

    // Roving isolation: the arrows wrap inside the toolbar and never reach a tab.
    actButtons[0]!.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement, "ArrowUp wraps inside the toolbar").toBe(actButtons[actButtons.length - 1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement, "ArrowDown wraps inside the toolbar").toBe(actButtons[0]);
    tabs[4]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement, "the tablist wraps inside itself").toBe(tabs[0]);
    actButtons[0]!.focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(actButtons[actButtons.length - 1]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(actButtons[0]);
    for (const callback of [...callbacks, ...actCallbacks]) expect(callback, "arrows never invoke").not.toHaveBeenCalled();
    expect(host!.querySelectorAll('[tabindex="0"]')).toHaveLength(2);

    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(actCallbacks[1], "Enter invokes once").toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(actCallbacks[1], "space invokes once").toHaveBeenCalledTimes(2);
    await press(actButtons[0]!, mode);
    await expect.poll(() => actCallbacks[0]!.mock.calls.length, { message: "pointer invokes once" }).toBe(1);
    all.focus();
    await userEvent.keyboard("{Enter}");
    expect(palette).toHaveBeenCalledTimes(1);
    for (const callback of callbacks) expect(callback, "acts never navigate").not.toHaveBeenCalled();
    expect(tabs[1]!.getAttribute("aria-selected"), "an act never moves the amber destination").toBe("true");
  });

  test(`rail acts disabled: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { actButtons, actCallbacks } = await mountActs(900, 600, expanded, theme, "needs the host");
    if (!expanded) {
      // A reason cannot be printed beside an icon, so the act is not drawn.
      expect(actButtons).toHaveLength(2);
      expect(host!.textContent).not.toContain("needs the host");
      return;
    }
    const briefing = actButtons[2]!;
    expect(briefing.getAttribute("aria-disabled")).toBe("true");
    expect(briefing.getAttribute("aria-label")).toBe("Daily briefing, spends, unavailable: needs the host");
    expect(briefing.textContent, "effect stays at rest").toContain("spends");
    expect(briefing.textContent, "reason printed at rest").toContain("needs the host");
    const r = briefing.getBoundingClientRect();
    if (mode !== "fine") expect(r.height).toBeGreaterThanOrEqual(44);
    actButtons[0]!.focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement, "a disabled act is still a stop").toBe(briefing);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await press(briefing, mode);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(actCallbacks[2], "a disabled act never invokes").not.toHaveBeenCalled();
    if (mode === "mixed") await page.screenshot({ element: host!, path: `../../.vitest-attachments/side-rail/acts-offline-${theme}.png` });
  });

  test(`All commands as the only control, 280px tall: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    await page.viewport(900, 280);
    await commands.formViewport(900, 280);
    document.documentElement.dataset.theme = theme;
    host = document.createElement("div");
    host.style.cssText = "display:flex;width:900px;height:280px;overflow:hidden";
    document.body.append(host);
    const palette = vi.fn();
    // A picture of the destinations and acts (no handlers) above a real button.
    const acts: RailAct[] = [{ icon: "search", label: "Search" }, { icon: "add", label: "Add a note" }];
    root = createRoot(host);
    flushSync(() => root!.render(createElement(SideRail, { active: 1, expanded, acts, onOpenPalette: palette })));
    await document.fonts.ready;
    const all = host.querySelector<HTMLElement>('button[aria-keyshortcuts="Meta+K"]')!;
    const a = all.getBoundingClientRect();
    expect(a.bottom, "the only control stays inside the rail").toBeLessThanOrEqual(280);
    expect(document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)?.closest("button")).toBe(all);
    await press(all, mode);
    await expect.poll(() => palette.mock.calls.length, { message: "All commands opens once" }).toBe(1);
  });

  test(`rail acts long labels: ${theme}, ${expanded ? "expanded" : "collapsed"}`, async () => {
    const mode = pointerScene();
    const { actButtons, all } = await mountActs(390, 600, expanded, theme, "a turn is running", true);
    for (const el of [...actButtons, all]) {
      const r = el.getBoundingClientRect();
      expect(r.right, "act inside the rail").toBeLessThanOrEqual(expanded ? 208 : 60);
      if (mode !== "fine") expect(r.height).toBeGreaterThanOrEqual(44);
      if (expanded) expect(el.scrollWidth, "long label wraps").toBeLessThanOrEqual(el.clientWidth);
    }
    expect(document.documentElement.scrollWidth, "document horizontal containment").toBeLessThanOrEqual(innerWidth);
  });
}
