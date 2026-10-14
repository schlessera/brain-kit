/// <reference types="@vitest/browser-playwright" />
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Button } from "../../src/primitives/Button.js";
import { SuggestionChips } from "../../src/conversation/SuggestionChips.js";
import { CommandPalette } from "../../src/desktop/CommandPalette.js";
import { FilterRow } from "../../src/rows/FilterRow.js";
import { Surface } from "../../src/primitives/Surface.js";
import { ListRow } from "../../src/rows/ListRow.js";
import { Composer } from "../../src/chrome/Composer.js";
import { CommandPalette as SlashPalette } from "../../../ui-react/src/components/chat/command-palette.js";
import { pixels, cornerInk } from "./focus-pixels.js";
import { AskOtherField } from "../../src/internal/AskOtherField.js";
import { ModelPicker } from "../../src/chrome/ModelPicker.js";
import { ToolPermissionsList } from "../../../ui-react/src/components/settings/tool-permissions-list.js";
import { Rows, ToggleRow } from "../../../ui-react/src/components/graph/graph-form.js";
import "../../src/styles.css";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let consumer: HTMLStyleElement | undefined;
let iframeViewport: { width: number; height: number } | undefined;
let outerViewport: { width: number; height: number } | undefined;
const originalTheme = document.documentElement.dataset.theme;
afterEach(async () => {
  if (root) flushSync(() => root!.unmount());
  host?.remove(); consumer?.remove();
  root = undefined; host = undefined; consumer = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
  if (iframeViewport) await page.viewport(iframeViewport.width, iframeViewport.height);
  if (outerViewport) await commands.formViewport(outerViewport.width - 100, outerViewport.height - 120);
  iframeViewport = undefined; outerViewport = undefined;
});

for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) {
  test(`continuous focused corners and contained control rings: ${theme} ${width}`, async () => {
    iframeViewport = { width: innerWidth, height: innerHeight };
    outerViewport = await commands.formViewport(width, 1600); await page.viewport(width, 1600);
    document.documentElement.dataset.theme = theme;
    consumer = document.createElement("style"); consumer.textContent = await commands.formConsumerStyles() + "\n[data-focus-menu] > [data-command-palette], [data-focus-picker] > div { position:relative !important; bottom:auto !important; margin:0; }"; document.head.append(consumer);
    host = document.createElement("div"); host.dataset.focusInventory = "";
    host.style.cssText = "padding:8px;box-sizing:border-box;width:100%;background:var(--bk-color-canvas)"; document.body.append(host);
    const click = vi.fn(); root = createRoot(host);
    flushSync(() => root!.render(<div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, maxWidth: 560 }}>
      <CommandPalette query="" onQueryChange={() => {}} onSelect={() => {}} maxHeight={110}
        groups={[{ label: "Run", items: Array.from({ length: 8 }, (_, i) => ({ label: `Inspect crew ${i + 1}`, icon: "file" as const, onClick: click })) }]} />
      <FilterRow items={[{ label: "All", onClick: click }, { label: "Ready", onClick: click }]} />
      <Surface radius={12} onClick={click}>Inspect the voyage</Surface>
      <div data-focus-menu="" style={{ position: "relative", height: 420 }}><SlashPalette filter="" onSelect={click} /></div>
      <div data-focus-rows="" className="bk-focus-clip" style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--bk-color-edge)" }}>
        <ListRow title="First note" onClick={click} /><ListRow title="Last note" onClick={click} last />
      </div>
      <Composer value="" onChange={() => {}} onSend={click} />
      <AskOtherField value="" onChange={() => {}} />
      <ToolPermissionsList tools={["Inspect fleet", "Inspect route"]} busy={null} error={null} onRevoke={click} />
      <Rows><ToggleRow checked={true} label="Show links" onChange={click} /><ToggleRow checked={false} label="Show islands" onChange={click} last /></Rows>
      <div data-focus-picker="" style={{ position: "relative" }}><ModelPicker models={[]} selectedModelId={null} modelLocked
        lockedAction={{ label: "Continue on another backend", onSelect: click }} onModel={click} onEffort={click} onDismiss={click} /></div>
    </div>));
    await document.fonts.ready;
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const before = input.parentElement!.getBoundingClientRect();
    await userEvent.click(input);
    expect(input.matches(":focus-visible"), "native text input focus-visible premise").toBe(true);
    const png = await pixels(await commands.focusCapture('[aria-label="Command palette"]', `${theme}-${width}-query`));
    expect(png.width, "capture preserves CSS pixel scale").toBe(Math.ceil(host.querySelector<HTMLElement>('[aria-label="Command palette"]')!.getBoundingClientRect().width));
    expect.soft(cornerInk(png, theme), "QUERY_TOP_LEFT_CONTINUOUS_INK").toBeGreaterThan(3);
    expect.soft(cornerInk(png, theme, true), "QUERY_TOP_RIGHT_CONTINUOUS_INK").toBeGreaterThan(3);
    expect(input.parentElement!.getBoundingClientRect().height, "focus does not shift layout").toBe(before.height);
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    await userEvent.tab(); expect(document.activeElement).toBe(options[0]);
    await commands.focusCapture('[aria-label="Command palette"]', `${theme}-${width}-first-option`);
    await userEvent.keyboard("{End}"); expect(document.activeElement).toBe(options.at(-1));
    expect(host.querySelector('[role="listbox"]')!.scrollTop, "last row is revealed by keyboard").toBeGreaterThan(0);
    await commands.focusCapture('[aria-label="Command palette"]', `${theme}-${width}-last-option`);
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]; tabs[0].focus();
    expect(tabs[0].matches(":focus-visible"), "keyboard filter focus premise").toBe(true);
    const filter = await pixels(await commands.focusCapture('[role="tablist"]', `${theme}-${width}-filter-first`));
    // Midpoint of the pill's top edge: the original +2 ring is entirely outside
    // this unpadded strip and vanishes. Inspect three rows for subpixel placement.
    const mid = Math.floor(tabs[0].getBoundingClientRect().width / 2);
    const edgeInk = Array.from({ length: 3 }, (_, y) => {
      const i = (y * filter.width + mid) * 4;
      const light = (filter.data[i] + filter.data[i + 1] + filter.data[i + 2]) / 3;
      return theme === "dark" ? light > 160 : light < 60;
    }).filter(Boolean).length;
    expect.soft(edgeInk, "FILTER_TOP_EDGE_VISIBLE_INK").toBeGreaterThan(0);
    await userEvent.keyboard("{End}"); expect(document.activeElement).toBe(tabs[1]);
    await commands.focusCapture('[role="tablist"]', `${theme}-${width}-filter-last`);
    const menu = host.querySelector('[data-command-palette]')!;
    const actions = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    for (const [label, action, bottom] of [["first", actions[0], false], ["last", actions.at(-1)!, true]] as const) {
      action.focus(); expect(action.matches(":focus-visible")).toBe(true);
      const menuPng = await pixels(await commands.focusCapture('[data-command-palette]', `${theme}-${width}-slash-${label}`));
      expect.soft(cornerInk(menuPng, theme, false, bottom, 12), `SLASH_${label}_LEFT_CONTINUOUS_INK`).toBeGreaterThan(3);
      expect.soft(cornerInk(menuPng, theme, true, bottom, 12), `SLASH_${label}_RIGHT_CONTINUOUS_INK`).toBeGreaterThan(3);
    }
    for (const [name, selector] of [["surface", '[data-focus-inventory] [role="button"]'], ["rows-first", '[data-focus-rows] > :first-child'], ["rows-last", '[data-focus-rows] > :last-child'], ["composer", 'textarea'], ["other", '[aria-label="Your own answer"]'], ["tools-first", '[aria-label="Inspect fleet"]'], ["tools-last", '[aria-label="Inspect route"]'], ["graph-first", '[aria-label="Show links"]'], ["graph-last", '[aria-label="Show islands"]'], ["locked-model", '[data-locked-action]']] as const) {
      const el = name.startsWith("tools-") ? [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(e => e.textContent?.includes(name === "tools-first" ? "Inspect fleet" : "Inspect route"))!
        : name.startsWith("graph-") ? [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(e => e.textContent?.includes(name === "graph-first" ? "Show links" : "Show islands"))!
        : host.querySelector<HTMLElement>(selector)!; el.focus();
      expect(el.matches(":focus-visible"), `${name} native focus`).toBe(true);
      if (name.startsWith("tools-") || name.startsWith("graph-")) {
        el.parentElement!.dataset.focusSurface = name;
        const rowPng = await pixels(await commands.focusCapture(`[data-focus-surface="${name}"]`, `${theme}-${width}-${name}-corners`));
        for (const right of [false, true]) expect.soft(cornerInk(rowPng, theme, right, name.endsWith("last"), 14), "SURFACE_EDGE_CONTINUOUS_INK").toBeGreaterThan(3);
      }
      if (name === "locked-model") {
        el.dataset.focusAction = "";
        const action = await pixels(await commands.focusCapture("[data-focus-action]", `${theme}-${width}-locked-model-edges`));
        const y = Math.floor(action.height / 2);
        for (const x of [0, action.width - 1]) {
          const i = (y * action.width + x) * 4;
          const light = (action.data[i] + action.data[i + 1] + action.data[i + 2]) / 3;
          expect.soft(theme === "dark" ? light > 160 : light < 60, "LOCKED_MODEL_SIDE_VISIBLE_INK").toBe(true);
        }
      }
      await commands.focusCapture('[data-focus-inventory]', `${theme}-${width}-${name}`);
      if (name === "locked-model") {
        await userEvent.hover(el);
        await commands.buttonPointer("down");
        try {
          expect(el.matches(":active"), "native locked-model press premise").toBe(true);
          expect(getComputedStyle(el).transform, "locked-model control keeps its pressed translation").toBe("matrix(1, 0, 0, 1, 0, 1)");
          expect(getComputedStyle(el).filter, "locked-model control keeps its pressed brightness").toBe("brightness(0.94)");
        } finally { await commands.buttonPointer("up"); }
      }
    }
    expect(document.documentElement.scrollWidth, "no viewport overflow").toBeLessThanOrEqual(width);
  });
}


for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) {
  test(`wrapped suggestions and tight Surfaces retain focused paint: ${theme} ${width}`, async () => {
    iframeViewport = { width: innerWidth, height: innerHeight };
    outerViewport = await commands.formViewport(width, 800); await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    host = document.createElement("div"); host.dataset.focusInventory = "";
    host.style.cssText = "padding:8px;box-sizing:border-box;width:100%;max-width:560px;background:var(--bk-color-canvas)"; document.body.append(host);
    root = createRoot(host); const click = vi.fn();
    flushSync(() => root!.render(<div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <div data-tight-surface=""><Surface pad={3}><Button label="Configure voyage" onClick={click} /></Surface></div>
      <div data-wrapped-suggestions=""><SuggestionChips label="" items={[{ label: "Inspect the route", onClick: click }, { label: "Inspect the fleet", disabled: true, why: "Needs the host" }]} /></div>
      <div data-scrolling-suggestions=""><SuggestionChips label="" wrap={false} items={[{ label: "Inspect the route", onClick: click }, { label: "Inspect the fleet", onClick: click }, { label: "Inspect Ithaca", onClick: click }]} /></div>
    </div>));
    await userEvent.tab();
    for (const [name, selector] of [["tight-button", "[data-tight-surface] .bk-control"], ["wrapped-enabled", "[data-wrapped-suggestions] .bk-control"], ["wrapped-disabled", '[data-wrapped-suggestions] [aria-disabled="true"]']] as const) {
      const el = host.querySelector<HTMLElement>(selector)!; el.focus();
      expect(el.matches(":focus-visible"), "native keyboard focus premise").toBe(true);
      expect.soft(getComputedStyle(el).outlineOffset, "CLIPPED_CONTROL_USES_INSIDE_RING").toBe("-2px");
      el.dataset.focusProbe = name;
      const png = await pixels(await commands.focusCapture(`[data-focus-probe="${name}"]`, `${theme}-${width}-${name}-edge`));
      const mid = Math.floor(png.width / 2);
      const ink = Array.from({ length: 3 }, (_, y) => {
        const i = (y * png.width + mid) * 4;
        const light = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
        return theme === "dark" ? light > 160 : light < 60;
      }).filter(Boolean).length;
      expect.soft(ink, "WRAPPED_OR_TIGHT_TOP_EDGE_VISIBLE_INK").toBeGreaterThan(0);
      await commands.focusCapture('[data-focus-inventory]', `${theme}-${width}-${name}`);
    }
    const scrolling = host.querySelector<HTMLElement>("[data-scrolling-suggestions] .bk-control")!;
    scrolling.focus(); expect(scrolling.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(scrolling).outlineOffset, "padded scrolling suggestions retain outside rings").toBe("2px");
    await commands.focusCapture('[data-focus-inventory]', `${theme}-${width}-scrolling-suggestions`);
    const scrollingLast = [...host.querySelectorAll<HTMLElement>("[data-scrolling-suggestions] .bk-control")].at(-1)!;
    scrolling.focus();
    await userEvent.tab(); await userEvent.tab();
    expect(document.activeElement, "native Tab reaches the last suggestion").toBe(scrollingLast);
    const scrollPng = await pixels(await commands.focusCapture('[data-scrolling-suggestions] .bk-scroll-x', `${theme}-${width}-scrolling-last`));
    await expect.poll(() => {
      const clip = scrollingLast.parentElement!.getBoundingClientRect();
      return clip.right - scrollingLast.getBoundingClientRect().right;
    }, { message: "SCROLLING_LAST_CONTROL_RESERVES_RING" }).toBeGreaterThanOrEqual(3.5);
    const clip = scrollingLast.parentElement!.getBoundingClientRect();
    const target = scrollingLast.getBoundingClientRect();
    const x = Math.floor(target.right - clip.left + 2);
    const y = Math.floor((target.top + target.bottom) / 2 - clip.top);
    const i = (y * scrollPng.width + x) * 4;
    const ringLight = (scrollPng.data[i] + scrollPng.data[i + 1] + scrollPng.data[i + 2]) / 3;
    expect(theme === "dark" ? ringLight > 160 : ringLight < 60, "SCROLLING_LAST_RING_PAINTED_INSIDE_VIEWPORT").toBe(true);
    await commands.focusCapture('[data-focus-inventory]', `${theme}-${width}-scrolling-last-review`);
    const off = host.querySelector<HTMLElement>('[aria-disabled="true"]')!; off.focus();
    await userEvent.keyboard("{Enter} "); expect(click, "disabled suggestion stays inert").not.toHaveBeenCalled();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
}
