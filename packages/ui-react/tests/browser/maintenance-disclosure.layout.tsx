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

for (const width of [320, 1280]) {
  test(`${width}: maintenance list starts collapsed and releases graph space`, async () => {
    await mount(width);
    // This assertion fails against the original always-visible list.
    expect(host!.querySelector('button[data-node-id="1"]')!.getClientRects().length,
      "MAINTENANCE_LIST_COLLAPSED_ON_FRESH_VISIT").toBe(0);
    const toggle = page.getByRole("button", { name: "Show maintenance tasks", exact: true });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    const button = host!.querySelector('[aria-expanded="false"]')!;
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    const list = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(list.hidden).toBe(true);
    await expect.poll(() => host!.querySelectorAll("canvas").length, { timeout: 5000 }).toBeGreaterThan(0);
    const canvas = host!.querySelector("canvas")!;
    const collapsed = canvas.getBoundingClientRect();
    expect(collapsed.width).toBeGreaterThan(width - 2);
    expect(collapsed.height).toBeGreaterThan(600);
    // Native keyboard activation, with focus acquired through Tab.
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    const hide = page.getByRole("button", { name: "Hide maintenance tasks", exact: true });
    await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    expect(list.hidden).toBe(false);
    const expanded = canvas.getBoundingClientRect();
    if (width < 768) {
      expect(canvas.closest('[aria-hidden="true"]')!.parentElement!.getBoundingClientRect().height).toBe(224);
      expect(expanded.height).toBe(223); // Canvas excludes the pane border.
    }
    else expect(expanded.width).toBeLessThan(collapsed.width - 300);
    await expect.poll(() => canvas.width).toBe(Math.round(expanded.width * devicePixelRatio));
    for (const title of ["Orphans (1)", "Unreachable from root (1)", "Broken links (1)", "Stale notes (1)"]) {
      await expect.element(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }
    flushSync(() => ui!.stores.graph.getState().setMaintenanceFilters({ stale: false }));
    expect(list.hidden).toBe(false);
    flushSync(() => ui!.stores.graph.setState({ dataState: "loading" }));
    flushSync(() => ui!.stores.graph.setState({ dataState: "done", findings: { ...findings } }));
    await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(hide);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => host!.querySelector("canvas")!.getBoundingClientRect().width).toBe(collapsed.width);
    await userEvent.keyboard(" ");
    await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    if (width === 320) {
      const target = host!.querySelector('[aria-controls]')!.getBoundingClientRect();
      const x = target.x + target.width / 2, y = target.y + target.height / 2;
      await commands.sheetInput("touch", [{ type: "down", x, y, t: 0 }, { type: "up", x, y, t: 40 }]);
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await commands.sheetInput("touch", [{ type: "down", x, y, t: 0 }, { type: "up", x, y, t: 40 }]);
      await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    }
    expect(host!.scrollWidth).toBeLessThanOrEqual(width);
  });

  test(`${width}: selection never reopens hidden tasks; visible rows and broken links retain actions`, async () => {
    const files = await mount(width);
    const row = host!.querySelector<HTMLButtonElement>('[data-node-id="1"]')!;
    // Observe the actual row method, retaining native scrolling when called.
    const original = Object.getOwnPropertyDescriptor(row, "scrollIntoView");
    const native = row.scrollIntoView;
    let scrolls = 0;
    Object.defineProperty(row, "scrollIntoView", { configurable: true, value: function(this: HTMLElement, options: ScrollIntoViewOptions) {
      scrolls++; native.call(this, options);
    } });
    try {
      flushSync(() => ui!.stores.graph.getState().select(1));
      expect(scrolls, "HIDDEN_MAINTENANCE_SELECTION_DOES_NOT_SCROLL").toBe(0);
      await userEvent.click(page.getByRole("button", { name: "Show maintenance tasks", exact: true }));
      expect(scrolls, "REOPENED_MAINTENANCE_LIST_SYNCHRONIZES_SELECTION").toBe(1);
      await userEvent.click(page.getByRole("button", { name: "Cyclops escape notes/cyclops-escape.md", exact: true }));
      expect(ui!.stores.graph.getState().selectedId).toBe(2);
      flushSync(() => ui!.stores.graph.getState().select(1));
      expect(scrolls).toBe(2);
      await userEvent.dblClick(page.getByRole("button", { name: "Sirens precautions notes/sirens-precautions.md", exact: true }));
      await expect.poll(() => files.some(url => url.includes("sirens-precautions.md"))).toBe(true);
      expect(ui!.stores.ui.getState().filePanelOpen).toBe(true);
      files.length = 0;
      await userEvent.click(page.getByRole("button", { name: "[[Lost sail]] in notes/sirens-precautions.md", exact: true }));
      await expect.poll(() => files.some(url => url.includes("sirens-precautions.md"))).toBe(true);
      await userEvent.click(page.getByRole("button", { name: "Hide maintenance tasks", exact: true }));
      const before = scrolls;
      flushSync(() => ui!.stores.graph.getState().select(2));
      flushSync(() => ui!.stores.graph.getState().select(1));
      expect(scrolls).toBe(before);
      await expect.element(page.getByRole("button", { name: "Show maintenance tasks", exact: true })).toHaveAttribute("aria-expanded", "false");
    } finally {
      if (original) Object.defineProperty(row, "scrollIntoView", original);
      else delete (row as Partial<HTMLButtonElement>).scrollIntoView;
    }
  });
}
