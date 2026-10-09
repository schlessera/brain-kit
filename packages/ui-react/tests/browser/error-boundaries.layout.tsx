import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Suspense, type ReactNode } from "react";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { PageBoundary } from "../../src/components/layout/page-boundary.js";
import { AppErrorBoundary } from "../../src/components/layout/app-error-boundary.js";
import { lazyChunk, RELOAD_MARKER_KEY } from "../../src/lib/lazy-chunk.js";
import { registerUpdateHold } from "../../src/lib/update-holds.js";
import { useUIStore } from "../../src/stores/ui-store.js";

// Page and root error boundaries (#1377) in real Chromium: a page that throws
// keeps the rail and tab bar, a lazy chunk that 404s reaches the stale-chunk
// screen, and the root screen works with no provider and no kit stylesheet.

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement | undefined;
let viewport: { width: number; height: number }, outer: { width: number; height: number } | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; sessionStorage.removeItem(RELOAD_MARKER_KEY); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose(); host?.remove(); styles?.remove(); renderer = undefined; root = undefined; host = undefined; styles = undefined;
  sessionStorage.removeItem(RELOAD_MARKER_KEY); vi.restoreAllMocks();
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});

async function withStyles() { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); }
async function size(width: number) { outer = await commands.formViewport(width, 800); await page.viewport(width, 800); }
function mount(node: (root: BrainUiRoot) => ReactNode, provider = true) {
  root = createBrainUiRoot({ storage: null, request: async () => { throw new Error("no lookup"); } });
  host = document.createElement("div"); document.body.append(host); renderer = createRoot(host);
  flushSync(() => renderer!.render(provider ? <BrainUiProvider root={root!}>{node(root!)}</BrainUiProvider> : node(root!)));
}
const heading = (name: string) => [...document.querySelectorAll<HTMLElement>("[role=heading], h1")].find((h) => h.textContent === name);
const button = (name: string) => [...document.querySelectorAll<HTMLElement>("[role=button], button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name || b.textContent?.trim().startsWith(name));

function ThrowsOn({ view }: { view: string }) {
  const active = useUIStore((s) => s.activeView);
  if (active === view) throw new TypeError("The loom unravelled overnight");
  return <p data-surface>{active} surface</p>;
}

for (const width of [320, 1280]) {
  test(`${width}: a page that throws keeps the navigation, and Go to Chat recovers`, async () => {
    await withStyles(); await size(width);
    mount((r) => { r.stores.ui.getState().setActiveView("graph"); return <AppShell><ThrowsOn view="graph" /></AppShell>; });
    await expect.poll(() => heading("Graph stopped working")).toBeTruthy();
    expect(document.activeElement, "focus moves to the fallback title").toBe(heading("Graph stopped working"));
    expect(document.querySelector("nav"), "the shell's navigation is still rendered").toBeTruthy();
    expect(document.scrollingElement!.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(innerWidth);
    for (const name of ["Try again", "Go to Chat", "Copy details"]) {
      const control = button(name);
      expect(control, name).toBeTruthy();
      expect(control!.getBoundingClientRect().height, `${name} target`).toBeGreaterThanOrEqual(44);
    }
    await userEvent.click(button("Go to Chat")!);
    await expect.poll(() => document.querySelector("[data-surface]")?.textContent).toBe("chat surface");
  });
}

test("Try again remounts a page that recovers", async () => {
  await withStyles();
  // A flag, not a counter: React retries a failed concurrent render once.
  let broken = true;
  function Flaky() { if (broken) throw new TypeError("The raft came apart"); return <p data-surface>recovered</p>; }
  mount(() => <PageBoundary><Flaky /></PageBoundary>);
  await expect.poll(() => heading("Chat stopped working")).toBeTruthy();
  expect(button("Go to Chat"), "no Go to Chat on Chat itself").toBeUndefined();
  broken = false;
  await userEvent.click(button("Try again")!);
  await expect.poll(() => document.querySelector("[data-surface]")?.textContent).toBe("recovered");
});

test("a page that fails again after Try again escalates to Reload app", async () => {
  await withStyles();
  const reload = vi.fn();
  function Always(): ReactNode { throw new TypeError("Charybdis took the mast"); }
  mount(() => <PageBoundary reload={reload}><Always /></PageBoundary>);
  await expect.poll(() => button("Try again")).toBeTruthy();
  expect(button("Reload app"), "the first failure offers a retry, not a reload").toBeUndefined();
  await userEvent.click(button("Try again")!);
  await expect.poll(() => button("Reload app"), { message: "a second failure offers a reload" }).toBeTruthy();
  expect(button("Try again"), "Try again is gone").toBeUndefined();
  expect(document.body.textContent).toContain("It failed again.");
  await userEvent.click(button("Reload app")!);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("Copy details holds facts by default, adds the message only when asked, and returns focus", async () => {
  await withStyles();
  function Broken(): ReactNode { throw new TypeError("Scylla read https://ithaca.example.test/palace"); }
  mount(() => <PageBoundary><Broken /></PageBoundary>);
  await expect.poll(() => button("Copy details")).toBeTruthy();
  await userEvent.click(button("Copy details")!);
  const body = await vi.waitFor(() => { const t = document.querySelector<HTMLTextAreaElement>("textarea"); if (!t) throw new Error("no review"); return t; });
  expect(body.value).toContain("kind: render");
  expect(body.value).toContain("error: TypeError");
  expect(body.value, "the message is opt-in").not.toContain("Scylla");
  await userEvent.click(button("Add error message for review")!);
  await expect.poll(() => body.value).toContain("Scylla read [redacted URL]");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector("textarea")).toBeNull();
  await expect.poll(() => document.activeElement?.closest("[data-fallback-action='copy']")).toBeTruthy();
});

// The pinned browser runs without a network, so it reports itself offline;
// each case states the connectivity it is about.
const online = (value: boolean) => vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);
const missing = () => import(/* @vite-ignore */ `${location.origin}/__missing-chunk-${Math.random().toString(36).slice(2)}__.js`);

test("a lazy chunk that 404s reloads once by itself and writes the loop marker", async () => {
  await withStyles();
  online(true);
  const reload = vi.fn();
  const Page = lazyChunk(missing);
  mount(() => <PageBoundary reload={reload}><Suspense fallback={null}><Page /></Suspense></PageBoundary>);
  await expect.poll(() => reload.mock.calls.length).toBe(1);
  expect(heading("A new version is ready")).toBeTruthy();
  expect(document.querySelector("[role=status]")?.textContent).toBe("Reloading to load the new version.");
  expect(Number(sessionStorage.getItem(RELOAD_MARKER_KEY))).toBeGreaterThan(0);
});

test("a fresh reload marker stops the loop and offers a reload instead", async () => {
  await withStyles();
  online(true);
  sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now()));
  const reload = vi.fn();
  const Page = lazyChunk(missing);
  mount((r) => { r.stores.ui.getState().setActiveView("graph"); return <PageBoundary reload={reload}><Suspense fallback={null}><Page /></Suspense></PageBoundary>; });
  await expect.poll(() => heading("Graph didn't load")).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  await userEvent.click(button("Reload")!);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("unsent work holds the reload and says what it would lose", async () => {
  await withStyles();
  online(true);
  const reload = vi.fn();
  const Page = lazyChunk(missing);
  mount((r) => { registerUpdateHold(r, { busy: () => true, subscribe: () => () => {} }); r.stores.ui.getState().setActiveView("activity"); return <PageBoundary reload={reload}><Suspense fallback={null}><Page /></Suspense></PageBoundary>; });
  await expect.poll(() => button("Reload now, unsent work will be lost")).toBeTruthy();
  expect(document.body.textContent).toContain("Actions needs a reload");
  expect(reload).not.toHaveBeenCalled();
});

test("storage that cannot be read never reloads by itself", async () => {
  await withStyles();
  online(true);
  const getItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
    if (key === RELOAD_MARKER_KEY) throw new DOMException("denied", "SecurityError");
    return getItem.call(this, key);
  });
  const reload = vi.fn();
  const Page = lazyChunk(missing);
  mount(() => <PageBoundary reload={reload}><Suspense fallback={null}><Page /></Suspense></PageBoundary>);
  await expect.poll(() => button("Reload now")).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
});

test("offline, the chunk waits for the connection and reloads when it returns", async () => {
  await withStyles();
  const connectivity = online(false);
  const reload = vi.fn();
  const Page = lazyChunk(missing);
  mount((r) => { r.stores.ui.getState().setActiveView("graph"); return <PageBoundary reload={reload}><Suspense fallback={null}><Page /></Suspense></PageBoundary>; });
  await expect.poll(() => heading("You're offline")).toBeTruthy();
  expect(button("Go to Chat"), "the one way forward offline").toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  connectivity.mockReturnValue(true);
  window.dispatchEvent(new Event("online"));
  await expect.poll(() => reload.mock.calls.length).toBe(1);
});

// Relative luminance per WCAG 2, from computed rgb() colours.
function luminance(css: string) {
  const [r, g, b] = css.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function background(element: Element): string {
  for (let e: Element | null = element; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor;
    if (!/rgba\(.*,\s*0\)$|transparent/.test(bg)) return bg;
  }
  return "rgb(255, 255, 255)";
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

for (const [label, kit, theme] of [["no stylesheet", false, "dark"], ["kit dark", true, "dark"], ["kit light", true, "light"]] as const) {
  for (const width of [320, 1280]) {
    test(`${width} ${label}: the root screen renders with no provider, is legible and operable`, async () => {
      if (kit) await withStyles();
      await size(width);
      const before = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = theme;
      try {
        const reload = vi.fn();
        // The fallback must not read context: this tree has no provider at all.
        function NeedsProvider(): ReactNode { throw new TypeError("No BrainUiProvider above this component"); }
        mount(() => <AppErrorBoundary reload={reload}><NeedsProvider /></AppErrorBoundary>, false);
        const title = await vi.waitFor(() => { const h = heading("Brain stopped working"); if (!h) throw new Error("no fallback"); return h; });
        expect(document.activeElement).toBe(title);
        const reloadButton = document.querySelector<HTMLButtonElement>("button[aria-label='Reload Brain']")!;
        const box = reloadButton.getBoundingClientRect();
        expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
        const summary = document.querySelector("summary")!;
        expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        for (const element of [title, document.querySelector("[data-app-fallback] p")!, reloadButton, summary]) {
          const style = getComputedStyle(element);
          expect(contrast(style.color, background(element)), `${element.tagName} contrast`).toBeGreaterThanOrEqual(4.5);
        }
        expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(innerWidth);
        await userEvent.click(reloadButton);
        expect(reload).toHaveBeenCalledTimes(1);
        await userEvent.click(summary);
        expect(document.querySelector("pre")!.textContent).toContain("error: TypeError");
        expect(document.querySelector("pre")!.textContent).not.toMatch(/\bat\s/);
      } finally {
        document.documentElement.dataset.theme = before;
      }
    });
  }
}
