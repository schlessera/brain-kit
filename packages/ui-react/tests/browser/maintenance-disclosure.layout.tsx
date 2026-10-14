import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { MaintenanceBody } from "../../src/components/graph/graph-maintenance.js";
import type { GraphMaintenanceResponse, GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";

const note = (id: number, title: string): GraphNodePayload => ({
  id, title, path: `notes/${title.toLowerCase().replaceAll(" ", "-")}.md`,
  type: "note", inDegree: 0, outDegree: 0,
});
const findings: GraphMaintenanceResponse = {
  orphans: [note(1, "Sirens precautions")],
  unreachable: [note(2, "Cyclops escape")],
  brokenLinks: [{ sourcePath: "notes/sirens-precautions.md", target: "Lost sail" }],
  stale: [{ ...note(3, "Ithaca provisions"), updated: "2026-01-01" }], staleDays: 180,
};
let react: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement | undefined;
let frame: { width: number; height: number } | undefined, outer: { width: number; height: number } | undefined;
let previousTheme: string | null;
afterEach(async () => {
  if (react) flushSync(() => react!.unmount());
  ui?.dispose(); host?.remove(); styles?.remove();
  if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", previousTheme);
  if (frame) await page.viewport(frame.width, frame.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  react = undefined; ui = undefined; host = undefined; styles = undefined;
});

async function mount(width: number) {
  frame = { width: innerWidth, height: innerHeight };
  outer = await commands.formViewport(width, 760);
  await page.viewport(width, 760);
  previousTheme = document.documentElement.getAttribute("data-theme");
  document.documentElement.dataset.theme = "light";
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:760px`;
  document.body.append(host);
  const files: string[] = [];
  ui = createBrainUiRoot({ storage: null, request: async url => {
    files.push(url);
    return Response.json({ path: "notes/sirens-precautions.md", content: "# Sirens precautions", frontmatter: {}, body: "# Sirens precautions" });
  } });
  ui.stores.graph.setState({ mode: "maintenance", dataState: "done", findings });
  react = createRoot(host);
  flushSync(() => react!.render(<BrainUiProvider root={ui!}><MaintenanceBody /></BrainUiProvider>));
  return files;
}

const categories = ["Orphans (1)", "Unreachable from root (1)", "Broken links (1)", "Stale notes (1)"];
function category(name: string) {
  return page.getByRole("button", { name, exact: true });
}
function categoryButton(name: string) {
  return [...host!.querySelectorAll<HTMLButtonElement>("h2 button")].find(button => button.textContent === name)!;
}
function content(name: string) {
  return document.getElementById(categoryButton(name).getAttribute("aria-controls")!)!;
}

for (const width of [320, 1280]) {
  test(`${width}: each maintenance category starts collapsed and expands independently`, async () => {
    await mount(width);
    expect(host!.querySelector('button[data-node-id="1"]')!.getClientRects().length,
      "MAINTENANCE_CATEGORY_COLLAPSED_ON_FRESH_VISIT").toBe(0);
    expect(host!.querySelector('button[data-node-id="2"]')!.getClientRects().length).toBe(0);
    expect(host!.querySelector('button[data-node-id="3"]')!.getClientRects().length).toBe(0);
    expect(host!.querySelector('button:not([data-node-id])')?.textContent).not.toBe("Show maintenance tasks");
    for (const name of categories) {
      await expect.element(category(name)).toHaveAttribute("aria-expanded", "false");
      expect(content(name).hidden).toBe(true);
      expect(categoryButton(name).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await expect.poll(() => host!.querySelectorAll("canvas").length, { timeout: 5000 }).toBeGreaterThan(0);
    const canvas = host!.querySelector("canvas")!;
    const bounds = canvas.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(200);
    expect(bounds.height).toBeGreaterThan(200);
    const closedHeight = host!.querySelector('[data-node-id="1"]')!.closest("section")!.getBoundingClientRect().height;
    await userEvent.click(category(categories[0]!));
    await expect.element(category(categories[0]!)).toHaveAttribute("aria-expanded", "true");
    expect(content(categories[0]!).hidden).toBe(false);
    expect(content(categories[1]!).hidden).toBe(true);
    expect(content(categories[2]!).hidden).toBe(true);
    expect(content(categories[3]!).hidden).toBe(true);
    expect(host!.querySelector('[data-node-id="1"]')!.closest("section")!.getBoundingClientRect().height).toBeGreaterThan(closedHeight + 44);
    await userEvent.keyboard(" ");
    await expect.element(category(categories[0]!)).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{Enter}");
    await expect.element(category(categories[0]!)).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(category(categories[2]!));
    expect(content(categories[0]!).hidden).toBe(false);
    expect(content(categories[2]!).hidden).toBe(false);
    expect(content(categories[1]!).hidden).toBe(true);
    flushSync(() => ui!.stores.graph.getState().setMaintenanceFilters({ orphans: false }));
    flushSync(() => ui!.stores.graph.getState().setMaintenanceFilters({ orphans: true }));
    expect(content(categories[0]!).hidden).toBe(false);
    flushSync(() => ui!.stores.graph.setState({ dataState: "loading" }));
    flushSync(() => ui!.stores.graph.setState({ dataState: "done", findings: { ...findings } }));
    expect(content(categories[0]!).hidden).toBe(false);
    expect(content(categories[2]!).hidden).toBe(false);
    expect(content(categories[1]!).hidden).toBe(true);
    expect(content(categories[3]!).hidden).toBe(true);
    await userEvent.click(category(categories[0]!));
    expect(content(categories[0]!).hidden).toBe(true);
    expect(content(categories[2]!).hidden).toBe(false);
    expect(host!.querySelector('[data-node-id="1"]')!.closest("section")!.getBoundingClientRect().height).toBe(closedHeight);
    if (width === 320) {
      const target = categoryButton(categories[0]!).getBoundingClientRect();
      const x = target.x + target.width / 2, y = target.y + target.height / 2;
      await commands.sheetInput("touch", [{ type: "down", x, y, t: 0 }, { type: "up", x, y, t: 40 }]);
      await expect.element(category(categories[0]!)).toHaveAttribute("aria-expanded", "true");
      await commands.sheetInput("touch", [{ type: "down", x, y, t: 0 }, { type: "up", x, y, t: 40 }]);
      await expect.element(category(categories[0]!)).toHaveAttribute("aria-expanded", "false");
    }
    await userEvent.click(category(categories[1]!));
    await userEvent.click(category(categories[3]!));
    expect(content(categories[1]!).hidden).toBe(false);
    expect(content(categories[3]!).hidden).toBe(false);
    await expect.poll(() => host!.querySelector("canvas")!.getBoundingClientRect().width).toBe(bounds.width);
    expect(host!.scrollWidth).toBeLessThanOrEqual(width);
  });

  test(`${width}: selection never expands hidden categories; visible rows and broken links retain actions`, async () => {
    const files = await mount(width);
    const row = host!.querySelector<HTMLButtonElement>('[data-node-id="1"]')!;
    const original = Object.getOwnPropertyDescriptor(row, "scrollIntoView");
    const native = row.scrollIntoView;
    let scrolls = 0;
    Object.defineProperty(row, "scrollIntoView", { configurable: true, value: function(this: HTMLElement, options: ScrollIntoViewOptions) {
      scrolls++; native.call(this, options);
    } });
    try {
      flushSync(() => ui!.stores.graph.getState().select(1));
      expect(scrolls, "HIDDEN_MAINTENANCE_SELECTION_DOES_NOT_SCROLL").toBe(0);
      await userEvent.click(category(categories[2]!));
      expect(scrolls).toBe(0);
      expect(content(categories[0]!).hidden).toBe(true);
      await userEvent.click(category(categories[0]!));
      expect(scrolls, "EXPANDED_MAINTENANCE_CATEGORY_SYNCHRONIZES_SELECTION").toBe(1);
      await userEvent.click(category(categories[1]!));
      await userEvent.click(page.getByRole("button", { name: "Cyclops escape notes/cyclops-escape.md", exact: true }));
      expect(ui!.stores.graph.getState().selectedId).toBe(2);
      const beforeSelect = scrolls;
      flushSync(() => ui!.stores.graph.getState().select(1));
      expect(scrolls).toBe(beforeSelect + 1);
      await userEvent.dblClick(page.getByRole("button", { name: "Sirens precautions notes/sirens-precautions.md", exact: true }));
      await expect.poll(() => files.some(url => url.includes("sirens-precautions.md"))).toBe(true);
      expect(ui!.stores.ui.getState().filePanelOpen).toBe(true);
      files.length = 0;
      await userEvent.click(page.getByRole("button", { name: "[[Lost sail]] in notes/sirens-precautions.md", exact: true }));
      await expect.poll(() => files.some(url => url.includes("sirens-precautions.md"))).toBe(true);
      await userEvent.click(category(categories[0]!));
      const before = scrolls;
      flushSync(() => ui!.stores.graph.getState().select(2));
      flushSync(() => ui!.stores.graph.getState().select(1));
      expect(scrolls).toBe(before);
      expect(content(categories[0]!).hidden).toBe(true);
      expect(content(categories[1]!).hidden).toBe(false);
    } finally {
      if (original) Object.defineProperty(row, "scrollIntoView", original);
      else delete (row as Partial<HTMLButtonElement>).scrollIntoView;
    }
  });
}
