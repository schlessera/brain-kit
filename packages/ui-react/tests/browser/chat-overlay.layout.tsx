import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { READING_COLUMN_ATTR } from "../../src/lib/client-environment.js";

// A real ChatPage, including its composer and scroll listener. Only its
// transports are fixtures: no backend, credentials or external resources.
class FixtureSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  send() {}
  close() { this.readyState = 3; }
}

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let style: HTMLStyleElement | undefined;
let outerBefore: { width: number; height: number };
let frameBefore: { width: number; height: number };

beforeEach(() => {
  vi.stubGlobal("WebSocket", FixtureSocket);
  // Settings and provider inventories can load on mount. Every request gets
  // fixture data rather than reaching the runner's Vite server or a provider.
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [],
  })));
});

afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  renderer = undefined;
  ui = undefined;
  host = undefined;
  style = undefined;
  vi.unstubAllGlobals();
  if (frameBefore) await page.viewport(frameBefore.width, frameBefore.height);
  if (outerBefore) await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
});

const sizes = [
  { width: 320, height: 640 },
  { width: 768, height: 1024 },
  // The widest Chat with the New chat disc: from 1280 the Sessions pane's
  // New conversation is New chat instead (D52 §1), checked below.
  { width: 1279, height: 800 },
  { width: 320, height: 640, short: true },
  // Check the container-query threshold itself, not just a wide desktop.
  { width: 879, height: 800 },
  { width: 880, height: 800 },
  { width: 887, height: 800 },
  { width: 888, height: 800 },
];

type Size = (typeof sizes)[number];
const label = (size: Size) => `${size.width}×${size.height}${size.short ? " / 110px area" : ""}`;
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function mount(size: Size) {
  frameBefore = { width: window.innerWidth, height: window.innerHeight };
  // Vitest's iframe otherwise scales down inside its own dashboard. Resize
  // both viewports so elementFromPoint observes the full painted target.
  outerBefore = await commands.formViewport(size.width, size.height);
  await page.viewport(size.width, size.height);
  document.documentElement.dataset.theme = "dark";
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;display:flex;flex-direction:column;width:${size.width}px;height:${size.height}px`;
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null });
  for (let i = 0; i < 30; i++) {
    ui.stores.chat.getState().addUserMessage(null,
      `Odysseus's voyage note ${i + 1}: remember the harbour and the crossing.`, "typed");
  }
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  const column = host.querySelector<HTMLElement>(`[${READING_COLUMN_ATTR}]`)!;
  const scroller = column.parentElement!;
  const area = scroller.parentElement!;
  const chat = area.parentElement!;
  const composer = chat.lastElementChild as HTMLElement;
  if (size.short) {
    // Constrain the embedding surface, not the component's message area.
    // A restored flow row must still consume this available height.
    host.style.height = `${composer.getBoundingClientRect().height + 110}px`;
  }
  await nextFrame();
  // ChatPage initially tails. Drive its real listener to reveal the scroll
  // disc, leaving the first message at the resting scroll position.
  scroller.scrollTop = 0;
  flushSync(() => scroller.dispatchEvent(new Event("scroll")));
  await nextFrame();
  expect(scroller.scrollHeight, "seeded transcript really overflows").toBeGreaterThan(scroller.clientHeight + 20);
  expect(scroller.scrollTop).toBe(0);
  const target = host.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!;
  const scrollDisc = host.querySelector<HTMLButtonElement>('button[aria-label="Scroll to latest"]')!;
  expect(target).not.toBeNull();
  expect(scrollDisc, "both overlay controls are shown").not.toBeNull();
  return { target, scrollDisc, column, scroller, area, chat, composer };
}

for (const size of sizes) {
  test(`${label(size)}: New chat has a 44×44 target`, async () => {
    const { target, area } = await mount(size);
    const rect = target.getBoundingClientRect();
    expect(rect.width, "target width").toBeGreaterThanOrEqual(44);
    expect(rect.height, "target height").toBeGreaterThanOrEqual(44);
    expect(rect.width, "existing target width is preserved").toBe(44);
    expect(rect.height, "existing target height is preserved").toBe(44);
    const areaRect = area.getBoundingClientRect();
    expect(areaRect.right - rect.right, "existing right inset").toBe(16);
    expect(rect.top - areaRect.top, "existing top inset").toBe(10);
    const disc = target.firstElementChild!.getBoundingClientRect();
    expect(disc.width, "painted disc width").toBe(32);
    expect(disc.height, "painted disc height").toBe(32);
  });

  for (const [horizontal, vertical] of [
    ["left", "top"], ["right", "top"], ["left", "bottom"], ["right", "bottom"],
  ] as const) {
    test(`${label(size)}: ${vertical} ${horizontal} target corner registers a hit`, async () => {
      const { target } = await mount(size);
      const rect = target.getBoundingClientRect();
      const x = horizontal === "left" ? rect.left + 1 : rect.right - 1;
      const y = vertical === "top" ? rect.top + 1 : rect.bottom - 1;
      expect(target.contains(document.elementFromPoint(x, y)), `${vertical} ${horizontal} hits New chat`).toBe(true);
    });
  }

  test(`${label(size)}: overlay controls do not intersect`, async () => {
    const { target, scrollDisc } = await mount(size);
    expect(intersects(target.getBoundingClientRect(), scrollDisc.getBoundingClientRect()),
      "New chat clears the visible scroll disc").toBe(false);
    // Below 480 the phone Search disc joins the row (#947); it shares the
    // top band and must clear both, and the resting first message.
    const search = host!.querySelector<HTMLButtonElement>('button[aria-label="Search the brain"]');
    expect(search !== null, "Search disc exactly below 480").toBe(size.width < 480);
    if (search) {
      expect(intersects(search.getBoundingClientRect(), target.getBoundingClientRect()), "Search clears New chat").toBe(false);
      expect(intersects(search.getBoundingClientRect(), scrollDisc.getBoundingClientRect()), "Search clears the scroll disc").toBe(false);
      expect(search.getBoundingClientRect().top, "one vertical range").toBe(target.getBoundingClientRect().top);
    }
  });

  test(`${label(size)}: the scroller uses all available message height`, async () => {
    const { scroller, area, chat, composer } = await mount(size);
    const available = composer.getBoundingClientRect().top - chat.getBoundingClientRect().top;
    // Comparing only scroller to area misses a restored sibling flow row:
    // both shrink equally. Also compare to the whole pre-composer allocation.
    expect(scroller.clientHeight, "no flow row steals transcript height").toBeCloseTo(available, 0);
    expect(scroller.clientHeight, "scroller fills the message area").toBeCloseTo(area.getBoundingClientRect().height, 0);
    if (size.short) expect(available, "the short fixture really supplies 110px").toBeCloseTo(110, 0);
  });
}

for (const size of sizes.filter(size => size.width === 320 || size.width === 880 || size.width === 887)) {
  test(`${label(size)}: resting first message content clears New chat`, async () => {
    const { column, target } = await mount(size);
    const content = column.querySelector<HTMLElement>(".chat-message-body")!;
    expect(content.textContent).toContain("Odysseus's voyage note 1:");
    // The header is readable content too. Measuring only the user bubble
    // misses a removed spacer: its extra header gap can still clear the disc.
    const header = column.firstElementChild!.firstElementChild!;
    expect(header.textContent).toContain("You");
    expect(header.getBoundingClientRect().top, "first message header clears target bottom")
      .toBeGreaterThanOrEqual(target.getBoundingClientRect().bottom);
    expect(content.getBoundingClientRect().top, "first message body clears target bottom")
      .toBeGreaterThanOrEqual(target.getBoundingClientRect().bottom);
  });
}

for (const size of sizes.filter(size => size.width >= 879)) {
  test(`${label(size)}: container query releases the spacer from 888px`, async () => {
    const { scroller, area } = await mount(size);
    expect(area.getBoundingClientRect().width).toBe(size.width);
    expect(getComputedStyle(scroller).paddingTop, "actual container-query padding")
      .toBe(size.width >= 888 ? "0px" : "40px");
  });
}

for (const size of sizes.filter(size => size.width >= 888)) {
  test(`${label(size)}: the wide reading column clears New chat`, async () => {
    const { column, target } = await mount(size);
    const columnRect = column.getBoundingClientRect();
    expect(columnRect.width, "the maximum reading-column width is preserved").toBe(768);
    expect(intersects(column.getBoundingClientRect(), target.getBoundingClientRect()),
      `reading column clears target: column=${JSON.stringify(column.getBoundingClientRect().toJSON())}; target=${JSON.stringify(target.getBoundingClientRect().toJSON())}`).toBe(false);
  });
}

// From 1280 there is no New chat disc: the Sessions pane beside the
// transcript carries New conversation (D52 §1, §8). The scroll disc stays.
for (const width of [1280, 1440]) {
  test(`${width}×800: no New chat disc beside the Sessions pane; the scroll disc stays`, async () => {
    frameBefore = { width: window.innerWidth, height: window.innerHeight };
    outerBefore = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    style = document.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    document.head.append(style);
    host = document.createElement("div");
    host.style.cssText = `position:fixed;inset:0;display:flex;flex-direction:column;width:${width}px;height:800px`;
    document.body.append(host);
    ui = createBrainUiRoot({ storage: null });
    for (let i = 0; i < 30; i++) ui.stores.chat.getState().addUserMessage(null, `Odysseus's voyage note ${i + 1}.`, "typed");
    renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
    await nextFrame();
    const scroller = host.querySelector<HTMLElement>(`[${READING_COLUMN_ATTR}]`)!.parentElement!;
    scroller.scrollTop = 0;
    flushSync(() => scroller.dispatchEvent(new Event("scroll")));
    await nextFrame();
    expect(host.querySelector('section[aria-label="Sessions"]'), "the pane is drawn").not.toBeNull();
    expect(host.querySelector('button[aria-label="New chat"]'), "no New chat disc").toBeNull();
    expect(host.querySelector('button[aria-label="Scroll to latest"]'), "the scroll disc is drawn").not.toBeNull();
    const start = [...host.querySelectorAll<HTMLElement>("[data-bk-button]")].find((b) => b.textContent?.includes("New conversation"));
    expect(start, "New conversation is the pane's primary action").toBeDefined();
  });
}
