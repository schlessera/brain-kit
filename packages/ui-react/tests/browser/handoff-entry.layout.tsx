import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";

// The handoff entry points (#61 §1) in real Chromium when every other backend
// is set up but cannot run (#1090): the locked model picker, a session row's
// overflow (the drawer at 320, the Sessions pane at 1280) and the desktop
// palette. The reason names every such backend, wraps rather than being cut
// off, and the entry stays disabled: pressing it asks for no summary. Only
// transports are fixtures; no backend or network is reached.
class FixtureSocket {
  static last: FixtureSocket | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { FixtureSocket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frames(type: string) { return this.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === type); }
}

const T0 = Date.UTC(2026, 6, 12, 9, 41);
const SESSION = { id: "odysseus-ithaca", title: "The way home to Ithaca", createdAt: T0, lastActiveAt: T0, totalCostUsd: 0, numTurns: 1, backendId: "claude" };
const PROVIDERS = [{ id: "claude", label: "Claude Opus", backendId: "claude" }];
const BACKENDS = {
  claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false, autonomous: true } },
  pi: { id: "pi", capabilities: { concurrentSessions: true, followUp: true, autonomous: false } },
  codex: { id: "codex", capabilities: { concurrentSessions: true, followUp: true, autonomous: false } },
  gemini: { id: "gemini", capabilities: { concurrentSessions: true, followUp: true, autonomous: false } },
};
// Configured, but missing their credentials (#1044).
const ONE = [{ id: "ithaca-proxy", label: "Ithaca proxy · gpt-5.5", reason: "needs-credentials", backendId: "pi" }];
const THREE = [
  ...ONE,
  { id: "circe-relay", label: "Circe relay · o4-mini", reason: "needs-credentials", backendId: "codex" },
  { id: "argo-bridge", label: "Argo bridge · gemini-2.5-pro", reason: "needs-credentials", backendId: "gemini" },
];
const COPY = {
  one: "Ithaca proxy · gpt-5.5 needs credentials",
  three: "Ithaca proxy · gpt-5.5, Circe relay · o4-mini, Argo bridge · gemini-2.5-pro need credentials",
};

let styles: HTMLStyleElement | undefined;
let viewport: { width: number; height: number };
let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;

beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(async () => {
  styles?.remove();
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
// The outer window is shared across spec files; the first mount records it.
let outer: { width: number; height: number } | undefined;
afterEach(() => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  renderer = undefined;
  ui = undefined;
  document.documentElement.dataset.theme = "dark";
  vi.unstubAllGlobals();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** A finite animation or transition still running: a drawer entering, a sheet rising (#992). */
const moving = () => document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await frame();
  }
  for (let i = 0; i < 120 && moving(); i++) await frame();
  expect(moving(), "entrances have settled").toBe(false);
}

async function mount(width: number, height: number, theme: "dark" | "light", unavailable: typeof THREE) {
  await page.viewport(width, height);
  const previous = await commands.formViewport(width, height);
  outer ??= previous;
  document.documentElement.dataset.theme = theme;
  vi.stubGlobal("WebSocket", FixtureSocket);
  const roster = { providers: PROVIDERS, backends: BACKENDS, unavailable };
  const request = async (url: string): Promise<Response> => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (path.endsWith("/sessions")) return Response.json({ sessions: [SESSION] });
    if (path.endsWith("/providers")) return Response.json(roster);
    return new Response("{}", { status: 404 });
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => request(String(url))));
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null, request });
  ui.stores.ui.getState().setTheme(theme);
  ui.stores.provider.setState({ available: PROVIDERS as never, unavailable: unavailable as never, backends: BACKENDS, pinnedId: "claude", loaded: true });
  const chat = ui.stores.chat.getState();
  chat.setActiveSession(SESSION.id);
  chat.setSessionBackend(SESSION.id, "claude");
  chat.addUserMessage(SESSION.id, "Plan the return to Ithaca; the notes are in plans/ithaca.md.", "typed");
  chat.startAssistantMessage(SESSION.id);
  chat.appendText(SESSION.id, "Sail past the Sirens, then keep clear of Scylla.");
  chat.finishAssistantMessage(SESSION.id);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  ui.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  flushSync(() => ui!.stores.provider.setState({ available: PROVIDERS as never, unavailable: unavailable as never, backends: BACKENDS, loaded: true }));
  await document.fonts.ready;
  await settle();
  return { ui, socket };
}

const visible = (el: Element) => el.getBoundingClientRect().width > 0;

/**
 * The reason is all there, on screen and inside `within`: not cut off, not
 * clipped, not pushing the page sideways. Returns its height in lines.
 */
function expectWhole(why: HTMLElement, within: Element, width: number, text: string) {
  expect(why.textContent, "the reason, word for word").toBe(text);
  const rect = why.getBoundingClientRect();
  const box = within.getBoundingClientRect();
  expect(why.scrollWidth, "the reason is not cut off").toBeLessThanOrEqual(why.clientWidth + 0.5);
  expect(rect.left, "the reason starts inside its surface").toBeGreaterThanOrEqual(box.left - 0.5);
  expect(rect.right, "the reason ends inside its surface").toBeLessThanOrEqual(box.right + 0.5);
  expect(rect.right, "the reason ends on screen").toBeLessThanOrEqual(width + 0.5);
  expect(document.documentElement.scrollWidth, "the page does not scroll sideways").toBeLessThanOrEqual(width);
  const style = getComputedStyle(why);
  expect(style.textOverflow === "ellipsis" && style.overflow === "hidden", "no ellipsis on the reason").toBe(false);
  return Math.round(rect.height / parseFloat(style.lineHeight || "0"));
}

/** Pressing the disabled entry opens no review and asks for no summary. */
async function expectInert(entry: HTMLElement, socket: FixtureSocket) {
  expect(entry.getAttribute("aria-disabled"), "the entry is disabled").toBe("true");
  entry.click();
  await settle();
  expect(socket.frames("handoff_prepare"), "no handoff preparation summary").toEqual([]);
  expect(ui!.stores.handoff.getState().sheet, "no review is open").toBeNull();
}

const cases = [
  { width: 320, height: 640, theme: "dark" },
  { width: 320, height: 640, theme: "light" },
  { width: 1280, height: 800, theme: "dark" },
  { width: 1280, height: 800, theme: "light" },
] as const;

for (const c of cases) {
  for (const [count, unavailable] of [["one", ONE], ["three", THREE]] as const) {
    const name = `${c.width}×${c.height} ${c.theme === "light" ? "paper" : "dark"}, ${count} unavailable`;
    const wraps = c.width === 320 && count === "three";

    test(`${name}: the locked model picker names them and stays disabled`, async () => {
      const { socket } = await mount(c.width, c.height, c.theme, unavailable);
      const trigger = document.querySelector<HTMLElement>("[data-model-trigger]")!;
      expect(trigger, "the composer offers its model picker").not.toBeNull();
      trigger.click();
      await settle();
      const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Model and effort"]')!;
      const entry = panel.querySelector<HTMLElement>("button[data-locked-action]")!;
      const why = entry.lastElementChild as HTMLElement;
      const lines = expectWhole(why, panel, c.width, COPY[count]);
      if (wraps) expect(lines, "the reason wraps at 320").toBeGreaterThan(1);
      await expectInert(entry, socket);
    });

    test(`${name}: a session row's overflow names them and stays disabled`, async () => {
      const { ui: root, socket } = await mount(c.width, c.height, c.theme, unavailable);
      // Below 1280 the rows are in the drawer; at 1280 in the Sessions pane.
      if (c.width < 1280) {
        flushSync(() => root.stores.ui.getState().setSessionPanelOpen(true));
        await settle();
      }
      const more = [...document.querySelectorAll<HTMLElement>(`button[aria-label="More for ${SESSION.title}"]`)].find(visible)!;
      expect(more, "the row offers its overflow").toBeTruthy();
      more.click();
      await settle();
      const menu = document.querySelector<HTMLElement>(`[role="menu"][aria-label="Actions for ${SESSION.title}"]`)!;
      const entry = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
      const why = entry.lastElementChild as HTMLElement;
      const lines = expectWhole(why, menu, c.width, COPY[count]);
      if (wraps) expect(lines, "the reason wraps at 320").toBeGreaterThan(1);
      await expectInert(entry, socket);
    });

    if (c.width >= 1280) {
      test(`${name}: the palette names them and stays disabled`, async () => {
        const { ui: root, socket } = await mount(c.width, c.height, c.theme, unavailable);
        flushSync(() => root.stores.ui.getState().setPaletteOpen(true));
        await settle();
        const entry = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((row) => row.textContent?.includes("Continue on another backend"))!;
        expect(entry, "the palette offers the entry").toBeTruthy();
        const why = [...entry.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === COPY[count])!;
        expect(why, "the reason is printed in the row").toBeTruthy();
        const palette = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Command palette"]')!;
        expectWhole(why, entry, c.width, COPY[count]);
        const label = [...entry.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === "Continue on another backend")!;
        // The label is never shrunk for the reason, however many backends it
        // names (#1106): neither is cut, and both sit inside the palette (the
        // reason inside its row, which is inside the palette).
        expect(label.scrollWidth, "the entry's own label is not cut off").toBeLessThanOrEqual(label.clientWidth + 0.5);
        const at = label.getBoundingClientRect();
        const box = palette.getBoundingClientRect();
        expect(at.left, "the label starts inside the palette").toBeGreaterThanOrEqual(box.left - 0.5);
        expect(at.right, "the label ends inside the palette").toBeLessThanOrEqual(box.right + 0.5);
        expect(entry.getBoundingClientRect().right, "the row ends inside the palette").toBeLessThanOrEqual(box.right + 0.5);
        const reason = why.getBoundingClientRect();
        if (count === "one") {
          // One name fits beside the label: it stays on the label's line.
          const middle = (reason.top + reason.bottom) / 2;
          expect(middle > at.top && middle < at.bottom, "the reason is on the label's line").toBe(true);
        } else {
          // Three do not: the reason drops under the label and wraps there.
          expect(reason.top, "the reason is under the label").toBeGreaterThanOrEqual(at.bottom - 0.5);
          expect(Math.abs(reason.left - at.left), "the reason starts at the label's edge").toBeLessThanOrEqual(0.5);
        }
        expect(label.title).toBe("Continue on another backend");
        expect(entry.getAttribute("aria-label")).toBe(`Continue on another backend, spends, ${COPY[count]}`);
        await expectInert(entry, socket);
      });
    }
  }
}

for (const width of [1280, 320]) test(`created handoff entry at ${width}: destination composer focus follows device`, async () => {
  // Mutations: discard destination returnFocus, or return the source opener on phone.
  const { ui: root } = await mount(width, width === 320 ? 640 : 800, "dark", THREE);
  const opener = host!.querySelector<HTMLElement>('[data-model-trigger]')!;
  expect(opener, "real handoff source opener exists").not.toBeNull();
  opener.focus();
  const handoffId = "h-ithaca-entry-0001";
  flushSync(() => root.stores.handoff.getState().open(SESSION.id, handoffId));
  await settle();
  expect(host!.querySelector('[role="dialog"][aria-modal="true"]'), "real handoff review opens").not.toBeNull();
  root.stores.chat.getState().setSessionBackend("ogygia", "pi");
  root.stores.chat.getState().addUserMessage("ogygia", "Review the mast and yard.", "typed");
  flushSync(() => root.stores.handoff.getState().noteCreated(handoffId, "ogygia", true));
  await settle();
  expect(root.stores.chat.getState().activeSessionId, "destination session is active").toBe("ogygia");
  expect(host!.querySelector('[role="dialog"][aria-modal="true"]'), "created review closes").toBeNull();
  const composer = host!.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  expect(composer, "destination composer exists").not.toBeNull();
  expect(document.activeElement, width >= 900 ? "created desktop focuses destination composer" : "created phone focus is body and keyboard stays down")
    .toBe(width >= 900 ? composer : document.body);
});
