import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";

// The cross-backend handoff review (#61) in real Chromium: the real ChatPage
// with a seeded source conversation, at the phone and desktop widths, in both
// themes. Only transports are fixtures; no backend or network is reached.
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
}

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let style: HTMLStyleElement | undefined;
let outerBefore: { width: number; height: number } | undefined;
let frameBefore: { width: number; height: number } | undefined;

const PROVIDERS = [
  { id: "claude", label: "Claude Opus", backendId: "claude" },
  { id: "codex", label: "Codex · gpt-5.5", backendId: "pi", billingMode: "api" },
];
// Configured on the other backend but missing its credential (#1044).
const UNAVAILABLE = [{ id: "ithaca-proxy", label: "Ithaca proxy · gpt-5.5", reason: "needs-credentials", backendId: "pi" }];
const BACKENDS = {
  claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false, autonomous: true } },
  pi: { id: "pi", capabilities: { concurrentSessions: true, followUp: true, autonomous: false } },
};

beforeEach(() => {
  vi.stubGlobal("WebSocket", FixtureSocket);
  // The roster loads on mount: answer it with the two-backend fixture.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
    String(url).includes("/files/resolve")
      ? { path: "plans/ithaca.md", ancestors: ["plans"], exists: true, type: "file" }
      : { entries: [], providers: PROVIDERS, backends: BACKENDS, unavailable: UNAVAILABLE, slugs: {}, models: [], sessions: [] }
  )));
});

afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  renderer = undefined;
  ui = undefined;
  vi.unstubAllGlobals();
  if (frameBefore) await page.viewport(frameBefore.width, frameBefore.height);
  if (outerBefore) await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
});

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function mount(width: number, height: number, theme: "dark" | "light") {
  frameBefore = { width: window.innerWidth, height: window.innerHeight };
  outerBefore = await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;display:flex;flex-direction:column;width:${width}px;height:${height}px`;
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null });
  ui.stores.provider.setState({ available: PROVIDERS as never, unavailable: UNAVAILABLE as never, backends: BACKENDS, pinnedId: "claude", loaded: true });
  const chat = ui.stores.chat.getState();
  chat.setActiveSession("ithaca");
  chat.setSessionBackend("ithaca", "claude");
  chat.addUserMessage("ithaca", "Plan the return to Ithaca; the notes are in plans/ithaca.md.", "typed");
  chat.startAssistantMessage("ithaca");
  chat.appendText("ithaca", "Sail past the Sirens, then keep clear of Scylla.");
  chat.finishAssistantMessage("ithaca");
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><ChatPage /></BrainUiProvider>));
  // The host is reachable: the socket opens, so the summary run can be asked for.
  const socket = FixtureSocket.last!;
  socket.readyState = 1;
  socket.onopen?.();
  await nextFrame();
  const opener = document.createElement("button");
  host.append(opener);
  opener.focus();
  flushSync(() => ui!.stores.handoff.getState().open("ithaca", "h-ithaca-layout-0001"));
  for (let i = 0; i < 5; i++) await nextFrame();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
  expect(dialog, "the review sheet is open").not.toBeNull();
  return { dialog, opener };
}

const cases = [
  { width: 320, height: 640, theme: "dark" },
  { width: 320, height: 640, theme: "light" },
  { width: 1280, height: 800, theme: "dark" },
  { width: 1280, height: 800, theme: "light" },
] as const;

for (const c of cases) {
  const name = `${c.width}×${c.height} ${c.theme === "light" ? "paper" : "dark"}`;

  test(`${name}: the sheet fits the viewport, focuses To, and actions are reachable at their ruled pointer size`, async () => {
    const { dialog } = await mount(c.width, c.height, c.theme);
    const to = dialog.querySelector("select")!;
    expect(document.activeElement, "focus goes to the To select").toBe(to);
    const panel = dialog.querySelector(".bk-overlay-surface")!.getBoundingClientRect();
    expect(panel.left, "no horizontal overflow, left").toBeGreaterThanOrEqual(0);
    expect(panel.height, "the measured surface is the sheet itself").toBeGreaterThan(300);
    expect(panel.top, "the sheet starts on screen").toBeGreaterThanOrEqual(0);
    const title = [...dialog.querySelectorAll("span, h2")].find((e) => e.textContent === "Continue on another backend" && e.getBoundingClientRect().height > 0)!;
    expect(title.getBoundingClientRect().top, "the title is on screen").toBeGreaterThanOrEqual(0);
    expect(panel.bottom, "the sheet ends on screen").toBeLessThanOrEqual(c.height + 0.5);
    expect(panel.right, "no horizontal overflow, right").toBeLessThanOrEqual(c.width + 0.5);
    if (c.width >= 900) expect(panel.width, "the desktop dialog is 480px").toBeCloseTo(480, 0);
    expect(document.documentElement.scrollWidth, "the page does not scroll sideways").toBeLessThanOrEqual(c.width);
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, [role="button"], select, textarea, input')]
      .filter((el) => el.getBoundingClientRect().width > 0);
    expect(controls.length, "the sheet has controls to measure").toBeGreaterThan(4);
    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      const label = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName;
      const compact = el.classList.contains("bk-icon-btn") && el.dataset.size === "sm" && !matchMedia("(any-pointer: coarse)").matches;
      expect(rect.height, `${label} height`).toBeGreaterThanOrEqual(compact ? 28 : 44);
      if (el.matches("button, [role=button]")) expect(rect.width, `${label} width`).toBeGreaterThanOrEqual(compact ? 28 : 36);
    }
    // A configured profile that cannot run is listed, disabled, with its reason.
    expect([...to.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ["Codex · gpt-5.5 · pi · spends", false],
      ["Ithaca proxy · gpt-5.5 · pi — needs credentials", true],
    ]);
    expect(to.value, "the runnable profile stays chosen").toBe("codex");
    expect(to.getBoundingClientRect().right, "the To select fits the sheet").toBeLessThanOrEqual(panel.right + 0.5);
    expect(page.getByRole("button", { name: "Start new chat on Codex · gpt-5.5", exact: true }).elements().length, "handoff start accessible name").toBe(1);
    const startButton = page.getByRole("button", { name: "Start new chat on Codex · gpt-5.5", exact: true }).element() as HTMLElement;
    expect(startButton.getAttribute("aria-label")).toBe("Start new chat on Codex · gpt-5.5");
    // At 320 the two actions sit side by side.
    const cancel = page.getByRole("button", { name: "Cancel", exact: true }).element() as HTMLElement;
    expect(Math.round(cancel.getBoundingClientRect().top)).toBe(Math.round(startButton.getBoundingClientRect().top));
    // The summary's busy state says it spends before anything else is shown.
    expect(dialog.textContent).toContain("Drafting a summary with Claude Opus · spends");
    expect(dialog.textContent).toContain("Nothing is sent until you start it.");
  });

  test(`${name}: Esc cancels and returns focus to the opener`, async () => {
    const { opener } = await mount(c.width, c.height, c.theme);
    await userEvent.keyboard("{Escape}");
    await nextFrame();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
}

for (const width of [1280, 320]) {
  test(`created handoff at ${width}: desktop focuses the destination and phone keeps the keyboard down`, async () => {
    const { opener } = await mount(width, width === 320 ? 640 : 800, "dark");
    ui!.stores.chat.getState().setSessionBackend("ogygia", "pi");
    ui!.stores.chat.getState().addUserMessage("ogygia", "Review the mast and yard on Ogygia.", "typed");
    flushSync(() => ui!.stores.handoff.getState().noteCreated("h-ithaca-layout-0001", "ogygia", true));
    await expect.poll(() => ui!.stores.chat.getState().activeSessionId).toBe("ogygia");
    await nextFrame();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]'), "created handoff closes").toBeNull();
    const composer = host!.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
    expect(composer, "destination composer exists").not.toBeNull();
    if (width >= 900) expect(document.activeElement, "created desktop handoff focuses destination composer").toBe(composer);
    else {
      expect(document.activeElement, "created phone handoff does not restore source opener").not.toBe(opener);
      expect(document.activeElement, "created phone handoff keeps keyboard down").not.toBe(composer);
      expect(document.activeElement, "created phone handoff focus is body").toBe(document.body);
    }
  });
}

for (const c of cases) test(`${c.width} ${c.theme}: handoff actions keep names, focus rings and Add works by click and Enter`, async () => {
  await mount(c.width, c.height, c.theme);
  const cancel = page.getByRole("button", { name: "Cancel", exact: true }).element() as HTMLElement;
  await userEvent.keyboard("{Tab}");
  cancel.focus();
  const ring = getComputedStyle(cancel);
  expect([ring.outlineWidth, ring.outlineStyle, ring.outlineOffset], "handoff action focus ring").toEqual(["2px", "solid", "2px"]);
  await page.getByRole("button", { name: "+ add a file", exact: true }).click();
  await userEvent.fill(page.getByRole("textbox", { name: "Brain file path" }), "notes/sirens.md");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "Remove reference notes/sirens.md", exact: true }).elements()
    .some((el) => el.checkVisibility({ checkVisibilityCSS: true })), { message: "handoff Add click creates a visible reference" }).toBe(true);
  await page.getByRole("button", { name: "Remove reference notes/sirens.md", exact: true }).click();
  await page.getByRole("button", { name: "+ add a file", exact: true }).click();
  await userEvent.fill(page.getByRole("textbox", { name: "Brain file path" }), "notes/sirens.md");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => page.getByRole("button", { name: "Remove reference notes/sirens.md", exact: true }).elements()
    .some((el) => el.checkVisibility({ checkVisibilityCSS: true })), { message: "handoff Add Enter creates a visible reference" }).toBe(true);
});
