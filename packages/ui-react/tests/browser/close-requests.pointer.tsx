/// <reference types="@vitest/browser-playwright" />
/**
 * Close requests for non-modal panels and panes, in real Chromium (#2577).
 *
 * Escape is Chromium's close request: the same path Android back takes into a
 * `CloseWatcher`. A non-modal surface (the phone destination drawers, the
 * ≥900px Settings and Files panes, the dictation field) must close on it once,
 * through its watcher, return focus to its opener (D52 N2) and leave history
 * alone. Without `CloseWatcher` (Firefox Android before 149), Escape still
 * closes it once. The watcher path is asserted by spying on the real
 * constructor and its `close` events.
 */
import { afterAll, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { watchCloseRequests } from "@schlessera/brain-ui-kit/internal";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { SlidePanel } from "../../src/components/layout/slide-panel.js";
import { ShareMenu } from "../../src/components/share/share-menu.js";
import { PasskeyList } from "../../src/components/settings/passkey-list.js";
import { DictationCapture, DictationNotices } from "../../src/components/voice/dictation-field.js";
import { useVoiceStore } from "../../src/voice/voice-store.js";

class FixtureSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() { this.readyState = 3; }
}
let styles: HTMLStyleElement;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Counts the real CloseWatcher's constructions and `close` events; restores the constructor afterwards. */
function spyCloseWatcher(ctx: TestContext) {
  const Native = (window as unknown as { CloseWatcher: new () => EventTarget }).CloseWatcher;
  expect(typeof Native, "this Chromium has CloseWatcher").toBe("function");
  const seen = { created: 0, closed: 0 };
  const descriptor = Object.getOwnPropertyDescriptor(window, "CloseWatcher")!;
  class Spy extends Native {
    constructor() {
      super();
      seen.created++;
      this.addEventListener("close", () => { seen.closed++; });
    }
  }
  Object.defineProperty(window, "CloseWatcher", { ...descriptor, value: Spy });
  ctx.onTestFinished(() => { Object.defineProperty(window, "CloseWatcher", descriptor); });
  return seen;
}

/** Deletes CloseWatcher for the test (the fallback path), restoring its full descriptor afterwards. */
function withoutCloseWatcher(ctx: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(window, "CloseWatcher")!;
  Reflect.deleteProperty(window, "CloseWatcher");
  expect("CloseWatcher" in window).toBe(false);
  ctx.onTestFinished(() => { Object.defineProperty(window, "CloseWatcher", descriptor); });
}

async function mount(ctx: TestContext, width: number) {
  const viewport = { width: innerWidth, height: innerHeight };
  const theme = document.documentElement.dataset.theme;
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  vi.stubGlobal("WebSocket", FixtureSocket);
  // Host answers every Settings section can read (as overlay-stacking and
  // destination-press do): an unreadable answer crashes the Chat page into its
  // error boundary, which unmounts the pane under test.
  const ui = createBrainUiRoot({ storage: null, request: async (url) => {
    const path = new URL(String(url), "http://fixture.invalid").pathname;
    if (path.endsWith("/models")) return Response.json({ models: [{ id: "ithaca-1", label: "Ithaca model", hidden: false }], customModels: [], discovery: { enabled: false }, stale: false, refreshedAt: null });
    if (path.endsWith("/agent-policy")) return Response.json({
      path: "context/policies/governance.md", hash: null, source: "default",
      errors: [], warnings: [], profiles: { interactive: "governed", voice: "strict" },
      protectedPaths: [], workerLimits: null,
    });
    return Response.json({ entries: [], sessions: [], principals: [], providers: [], backends: {},
      slugs: {}, models: [], live: [], history: [], intents: [] });
  } });
  ui.stores.ui.getState().setTheme("dark");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.append(host);
  const renderer = createRoot(host);
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount());
    ui.dispose(); host.remove();
    vi.unstubAllGlobals();
    document.documentElement.dataset.theme = theme;
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  await frame();
  /** The phone bar's tab, or the rail's, for a destination. */
  const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('nav [role="tab"]')]
    .find(el => el.getClientRects().length > 0 && (el.textContent?.trim() ?? "").replace(/⌘\d$/, "") === name)!;
  return { host, ui, tab };
}

const where = () => ({ length: history.length, href: location.href });

/** The three destinations the issue names, at the widths where they are non-modal. */
const SURFACES = [
  { name: "Sessions drawer", width: 390, tab: "Sessions", flag: "sessionPanelOpen", selector: '[data-panel="Sessions"]' },
  { name: "Settings pane", width: 1024, tab: "Settings", flag: "settingsPanelOpen", selector: 'section[aria-label="Settings"]' },
  { name: "Files pane", width: 1024, tab: "Files", flag: "filePanelOpen", selector: 'section[aria-label="Files"]' },
] as const;

for (const surface of SURFACES) {
  test(`${surface.name}: a close request closes it once through its watcher, returns focus and leaves history alone`, async ctx => {
    const seen = spyCloseWatcher(ctx);
    const s = await mount(ctx, surface.width);
    const before = where();
    const opener = s.tab(surface.tab);
    expect(opener, `${surface.tab} opener`).toBeTruthy();
    opener.focus(); await userEvent.click(opener); await frame();
    expect(s.ui.stores.ui.getState()[surface.flag], `${surface.name} opens`).toBe(true);
    expect(document.querySelector(surface.selector), `${surface.name} is drawn`).not.toBeNull();
    expect(document.querySelector(surface.selector)!.matches("dialog:modal"), `${surface.name} is non-modal`).toBe(false);
    expect(seen.created, "CLOSE_WATCHER_ARMED: the open surface holds a close watcher").toBeGreaterThan(0);

    await userEvent.keyboard("{Escape}"); await frame();
    expect(seen.closed, "CLOSE_WATCHER_CLOSED: the close request reached the surface's watcher, once").toBe(1);
    expect(s.ui.stores.ui.getState()[surface.flag], `${surface.name} closed`).toBe(false);
    await expect.poll(() => document.activeElement, { message: "focus returns to the opener (D52 N2)" }).toBe(opener);
    expect(where(), "no history entry and no navigation").toEqual(before);

    // A second close request with nothing open closes nothing more.
    await userEvent.keyboard("{Escape}"); await frame();
    expect(seen.closed, "no watcher is left behind").toBe(1);
  });

  test(`${surface.name}: without CloseWatcher, Escape still closes it once`, async ctx => {
    withoutCloseWatcher(ctx);
    const s = await mount(ctx, surface.width);
    const opener = s.tab(surface.tab);
    opener.focus(); await userEvent.click(opener); await frame();
    expect(s.ui.stores.ui.getState()[surface.flag]).toBe(true);
    await userEvent.keyboard("{Escape}"); await frame();
    expect(s.ui.stores.ui.getState()[surface.flag], "the keydown fallback closed it").toBe(false);
    await expect.poll(() => document.activeElement).toBe(opener);
  });
}

test("a modal over a destination panel takes the first close request, the panel the next", async ctx => {
  const seen = spyCloseWatcher(ctx);
  const s = await mount(ctx, 390);
  s.tab("Files").focus(); await userEvent.click(s.tab("Files")); await frame();
  const more = s.tab("More");
  more.focus(); await userEvent.click(more); await frame();
  expect(document.querySelector('[data-overlay-site="more"]')?.matches("dialog:modal"), "More is a native sheet over Files").toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.querySelector('[data-overlay-site="more"]'), "More closed first").toBeNull();
  expect(s.ui.stores.ui.getState().filePanelOpen, "Files stays open under More").toBe(true);
  expect(seen.closed, "the dialog took that request, not the panel's watcher").toBe(0);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.ui.stores.ui.getState().filePanelOpen, "the next request closes Files").toBe(false);
  expect(seen.closed, "through the panel's watcher").toBe(1);
});

/** A non-modal pane holding `children`, opened from a real button, for inner Escape consumers. */
async function pane(ctx: TestContext, children: (close: () => void) => React.ReactNode, closedBy: "any" | "none" = "any") {
  await page.viewport(1024, 800);
  const host = document.createElement("div");
  document.body.append(host);
  const closes: number[] = [];
  function Scene() {
    const [open, setOpen] = useState(false);
    const close = () => { closes.push(Date.now()); setOpen(false); };
    return <>
      <button data-test-open="" onClick={() => setOpen(true)}>Open the pane</button>
      <SlidePanel open={open} onClose={close} title="Ithaca" mode="pane" closedBy={closedBy}>{children(close)}</SlidePanel>
    </>;
  }
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); ui.dispose(); host.remove(); });
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Scene /></BrainUiProvider>));
  await userEvent.click(host.querySelector<HTMLElement>("[data-test-open]")!); await frame();
  return { host, closes };
}

test("Escape in the share menu inside a pane closes only the menu", async ctx => {
  spyCloseWatcher(ctx);
  const s = await pane(ctx, () => <ShareMenu title="Share the chart" options={[{ id: "copy", label: "Copy the chart", run: async () => true }, { id: "save", label: "Save the chart", run: async () => true }]} />);
  await userEvent.click(s.host.querySelector<HTMLElement>('[aria-label="Share the chart"]')!); await frame();
  // The menu may draw in a portal: read the whole document.
  await expect.poll(() => document.body.textContent, { message: "the menu is open" }).toContain("Copy the chart");
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.body.textContent, "the menu closed").not.toContain("Copy the chart");
  expect(s.closes, "PREVENTED_INNER_ESCAPE: the pane stays open").toEqual([]);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.closes, "the next Escape closes the pane").toHaveLength(1);
});

test("a pane that cannot be dismissed takes each close request and stays open, re-armed", async ctx => {
  const seen = spyCloseWatcher(ctx);
  const s = await pane(ctx, () => <p>The suitors wait.</p>, "none");
  expect(seen.created, "a closedBy=none pane still holds a close watcher").toBeGreaterThan(0);
  for (let i = 1; i <= 3; i++) {
    await userEvent.keyboard("{Escape}"); await frame();
    expect(seen.closed, `request ${i} reached the pane's watcher`).toBe(i);
    expect(s.closes, "the pane stays open").toEqual([]);
  }
  expect(document.querySelector('section[aria-label="Ithaca"]'), "still drawn").not.toBeNull();
});

for (const watcher of [true, false]) test(`a modal opened over a pane takes Escape first${watcher ? "" : " (without CloseWatcher)"}, the pane the next`, async ctx => {
  if (watcher) spyCloseWatcher(ctx); else withoutCloseWatcher(ctx);
  const s = await pane(ctx, () => <p>Penelope's loom.</p>);
  const dialog = document.createElement("dialog");
  dialog.textContent = "The suitors' demands";
  document.body.append(dialog);
  ctx.onTestFinished(() => dialog.remove());
  const open = document.createElement("button");
  open.textContent = "Show demands";
  open.onclick = () => dialog.showModal();
  document.body.append(open);
  ctx.onTestFinished(() => open.remove());
  await userEvent.click(open);
  expect(dialog.open).toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(dialog.open, "the modal closed first").toBe(false);
  expect(s.closes, "the pane stays open under it").toEqual([]);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.closes, "the next Escape closes the pane").toHaveLength(1);
});

test("Escape in the passkey rename field inside a pane cancels only the rename", async ctx => {
  spyCloseWatcher(ctx);
  const keys = [{ id: "bow", label: "Odysseus’s bow", rpId: "localhost", createdAt: Date.UTC(2026, 6, 1), lastUsedAt: null, backedUp: false, deviceType: null, transports: null, aaguid: null }];
  const s = await pane(ctx, () => <PasskeyList credentials={keys} status="ready" busy={false} error={null} supported hostname="localhost" onAdd={() => {}} onRename={() => {}} onDelete={() => {}} onSignOut={() => {}} />);
  await userEvent.click(s.host.querySelector<HTMLElement>('[aria-label^="Rename"]')!); await frame();
  const field = s.host.querySelector<HTMLInputElement>("input")!;
  expect(field, "the rename field is open").toBeTruthy();
  field.focus();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.host.querySelector("input"), "the rename was cancelled").toBeNull();
  expect(s.closes, "PREVENTED_INNER_ESCAPE: the pane stays open").toEqual([]);
});

test("a dictation take that is finishing survives a close request; once it is not, the next one cancels it once", async ctx => {
  const seen = spyCloseWatcher(ctx);
  const host = document.createElement("div");
  document.body.append(host);
  const voice = useVoiceStore.getState();
  ctx.onTestFinished(() => { useVoiceStore.setState(voice, true); });
  const cancels: number[] = [];
  useVoiceStore.setState({ mode: "dictate", dictationGate: null, draining: true });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); host.remove(); });
  // Mounted from a real press, as a take starts from the mic.
  const start = document.createElement("button");
  start.textContent = "Dictate";
  start.onclick = () => flushSync(() => renderer.render(<DictationCapture onFinish={() => {}} onCancel={() => cancels.push(1)} />));
  host.append(start);
  await userEvent.click(start); await frame();
  expect(host.querySelector('[data-dictation-field="D5"]'), "the take is finishing").not.toBeNull();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(seen.closed, "the close request reached the field's watcher").toBe(1);
  expect(cancels, "a finishing take is not cancelled").toEqual([]);
  flushSync(() => useVoiceStore.setState({ draining: false }));
  await frame();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(cancels, "the re-armed watcher cancels the take once").toEqual([1]);
  expect(seen.closed).toBe(2);
});

test("without CloseWatcher, Escape still cancels a take once, and a finishing take refuses it", async ctx => {
  withoutCloseWatcher(ctx);
  const host = document.createElement("div");
  document.body.append(host);
  const voice = useVoiceStore.getState();
  ctx.onTestFinished(() => { useVoiceStore.setState(voice, true); });
  const cancels: number[] = [];
  useVoiceStore.setState({ mode: "dictate", dictationGate: null, draining: true });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); host.remove(); });
  flushSync(() => renderer.render(<DictationCapture onFinish={() => {}} onCancel={() => cancels.push(1)} />));
  await frame();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(cancels, "D5 refuses the fallback's Escape").toEqual([]);
  flushSync(() => useVoiceStore.setState({ draining: false }));
  await frame();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(cancels, "then Escape cancels the take once").toEqual([1]);
});

test("without CloseWatcher, Escape on a dictation gate notice is Cancel, once", async ctx => {
  withoutCloseWatcher(ctx);
  const host = document.createElement("div");
  document.body.append(host);
  const voice = useVoiceStore.getState();
  ctx.onTestFinished(() => { useVoiceStore.setState(voice, true); });
  const cancels: number[] = [];
  useVoiceStore.setState({ dictationGate: { kind: "blocked", reason: "choose", saved: null } });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); host.remove(); });
  flushSync(() => renderer.render(<DictationNotices onConfirm={() => {}} onCancel={() => { cancels.push(1); useVoiceStore.setState({ dictationGate: null }); }} onOpenSettings={() => {}} onRetry={() => {}} onDismiss={() => {}} />));
  await frame();
  expect(host.querySelector('[data-dictation-notice="Dx1"]')).not.toBeNull();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(cancels, "Cancel, once").toEqual([1]);
});

test("a disarmed surface beneath an armed one leaves Escape to the surface above", async ctx => {
  spyCloseWatcher(ctx);
  let lower = 0, upper = 0;
  const openLower = document.createElement("button"); openLower.textContent = "Open the pane";
  const openUpper = document.createElement("button"); openUpper.textContent = "Start the take";
  document.body.append(openLower, openUpper);
  let a: ReturnType<typeof watchCloseRequests> | null = null, b: ReturnType<typeof watchCloseRequests> | null = null;
  // The pane keeps its Escape fallback (it is disarmed, as #2582 will do when drilled in).
  openLower.onclick = () => { a = watchCloseRequests(document, () => { lower++; return true; }); a.disarm(); };
  openUpper.onclick = () => { b = watchCloseRequests(document, () => { upper++; return true; }); };
  ctx.onTestFinished(() => { a?.destroy(); b?.destroy(); openLower.remove(); openUpper.remove(); });
  await userEvent.click(openLower); await userEvent.click(openUpper);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([upper, lower], "the armed surface above closes; the disarmed pane beneath does not").toEqual([1, 0]);
  b!.destroy();
  await userEvent.keyboard("{Escape}"); await frame();
  expect([upper, lower], "with the upper gone, Escape reaches the pane's fallback").toEqual([1, 1]);
});

test("re-arming a surface beneath another waits until the upper one closes", async ctx => {
  const seen = spyCloseWatcher(ctx);
  let lower = 0, upper = 0;
  const openLower = document.createElement("button"); openLower.textContent = "Open the pane";
  const openUpper = document.createElement("button"); openUpper.textContent = "Start the take";
  document.body.append(openLower, openUpper);
  let a: ReturnType<typeof watchCloseRequests> | null = null, b: ReturnType<typeof watchCloseRequests> | null = null;
  openLower.onclick = () => { a = watchCloseRequests(document, () => { lower++; return true; }, { escape: false }); };
  openUpper.onclick = () => { b = watchCloseRequests(document, () => { upper++; return false; }, { escape: false }); };
  ctx.onTestFinished(() => { a?.destroy(); b?.destroy(); openLower.remove(); openUpper.remove(); });
  await userEvent.click(openLower);
  // Drilled in (#2582): the pane is disarmed. Then a take opens above it.
  a!.disarm();
  await userEvent.click(openUpper);
  // Back at the pane's root while the take is still open: the pane re-arms.
  a!.arm();
  expect(a!.watching, "the pane's arming waits beneath the take").toBe(false);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([upper, lower], "the take, on top, takes the request").toEqual([1, 0]);
  b!.destroy();
  expect(a!.watching, "with the take gone, the pane's watcher is armed").toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([upper, lower], "the next request reaches the pane").toEqual([1, 1]);
  expect(seen.closed).toBe(2);
});

test("a disarmed surface above an armed one lets the close request reach the page, not the surface beneath", async ctx => {
  spyCloseWatcher(ctx);
  type Watcher = EventTarget & { destroy(): void };
  const Native = (window as unknown as { CloseWatcher: new () => Watcher }).CloseWatcher;
  let reachedPage = 0;
  let pageWatcher: Watcher | null = null;
  const armPage = () => { pageWatcher = new Native(); pageWatcher.addEventListener("close", () => { reachedPage++; armPage(); }); };
  armPage();
  ctx.onTestFinished(() => pageWatcher?.destroy());
  let take = 0, pane = 0;
  const startTake = document.createElement("button"); startTake.textContent = "Start the take";
  const openPane = document.createElement("button"); openPane.textContent = "Open the pane";
  document.body.append(startTake, openPane);
  let a: ReturnType<typeof watchCloseRequests> | null = null, b: ReturnType<typeof watchCloseRequests> | null = null;
  startTake.onclick = () => { a = watchCloseRequests(document, () => { take++; return true; }, { escape: false }); };
  openPane.onclick = () => { b = watchCloseRequests(document, () => { pane++; return true; }, { escape: false }); };
  ctx.onTestFinished(() => { a?.destroy(); b?.destroy(); startTake.remove(); openPane.remove(); });
  // A take is live, then a pane opens above it and drills in (#2582 disarms it).
  await userEvent.click(startTake); await userEvent.click(openPane);
  expect([a!.watching, b!.watching], "only the topmost surface holds a watcher").toEqual([false, true]);
  b!.disarm();
  await userEvent.keyboard("{Escape}"); await frame();
  expect([take, pane, reachedPage], "Back pops the pane's drill-in: the page takes it, not the take beneath").toEqual([0, 0, 1]);
  // Back at the pane's root: the pane closes on the next request, then the take.
  b!.arm();
  await userEvent.keyboard("{Escape}"); await frame();
  expect([take, pane, reachedPage], "the pane closes").toEqual([0, 1, 1]);
  b!.destroy();
  expect(a!.watching, "the take holds the watcher again").toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([take, pane, reachedPage], "then the take").toEqual([1, 1, 1]);
});

test("a dictation gate notice takes a close request as Cancel, once", async ctx => {
  const seen = spyCloseWatcher(ctx);
  const host = document.createElement("div");
  document.body.append(host);
  const voice = useVoiceStore.getState();
  ctx.onTestFinished(() => { useVoiceStore.setState(voice, true); });
  const cancels: number[] = [];
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); host.remove(); });
  flushSync(() => renderer.render(<DictationNotices onConfirm={() => {}} onCancel={() => { cancels.push(1); useVoiceStore.setState({ dictationGate: null }); }} onOpenSettings={() => {}} onRetry={() => {}} onDismiss={() => {}} />));
  // A blocked take's notice (Dx1: choose a service) opens from the mic press.
  const start = document.createElement("button");
  start.textContent = "Dictate";
  start.onclick = () => flushSync(() => useVoiceStore.setState({ dictationGate: { kind: "blocked", reason: "choose", saved: null } }));
  host.append(start);
  await userEvent.click(start); await frame();
  expect(host.querySelector('[data-dictation-notice="Dx1"]'), "the blocked-take notice shows").not.toBeNull();
  expect(seen.created, "the notice holds a close watcher").toBeGreaterThan(0);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(cancels, "Cancel, once").toEqual([1]);
  expect(seen.closed, "through the notice's watcher").toBe(1);
  expect(host.querySelector('[data-dictation-notice="Dx1"]')).toBeNull();
});

test("arm and disarm: a disarmed surface lets the close request reach the page, re-arming restores exactly one dismissal per request", async ctx => {
  const seen = spyCloseWatcher(ctx);
  type Watcher = EventTarget & { destroy(): void };
  const Native = (window as unknown as { CloseWatcher: new () => Watcher }).CloseWatcher;
  // The page beneath the surface, as #2582's history helper will be: it takes
  // a close request (Android back reaching popstate) and arms itself again in
  // that same handler, with no user activation. It stays beneath throughout,
  // so a re-armed surface watcher that joined its group would show here.
  let reachedPage = 0;
  let pageWatcher: Watcher | null = null;
  const armPage = () => {
    pageWatcher = new Native();
    pageWatcher.addEventListener("close", () => { reachedPage++; armPage(); });
  };
  armPage();
  ctx.onTestFinished(() => pageWatcher?.destroy());
  // The surface opens from a real press, as a panel does. It stays open on
  // every request (closedBy="none" style), so each request is counted.
  let dismissals = 0;
  let watch: ReturnType<typeof watchCloseRequests> | null = null;
  const open = document.createElement("button");
  open.textContent = "Open the surface";
  open.onclick = () => { watch = watchCloseRequests(document, () => { dismissals++; return false; }, { escape: false }); };
  document.body.append(open);
  ctx.onTestFinished(() => { watch?.destroy(); open.remove(); });
  await userEvent.click(open);
  expect(watch!.watching).toBe(true);

  watch!.disarm();
  expect(watch!.watching, "disarmed").toBe(false);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(dismissals, "a disarmed surface ignores the close request").toBe(0);
  expect(reachedPage, "it reached the page instead").toBe(1);

  // Re-armed from script with no user activation, as #2582 will re-arm from
  // popstate when the depth returns to the root. Then two requests: one
  // dismissal each, the page beneath never, nothing grouped or skipped.
  watch!.arm();
  expect(watch!.watching, "re-armed").toBe(true);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([dismissals, reachedPage], "first request after re-arming: the surface only").toEqual([1, 1]);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([dismissals, reachedPage], "second request: the surface only, not grouped with the page").toEqual([2, 1]);
  // Disarm again: the page, still armed beneath, takes the next request alone.
  watch!.disarm();
  await userEvent.keyboard("{Escape}"); await frame();
  expect([dismissals, reachedPage], "disarmed again: the page only").toEqual([2, 2]);
  expect(seen.created, "a watcher per arming and re-arming").toBeGreaterThanOrEqual(4);
});

test("repeated refusals re-arm without joining the surface beneath: one action per request", async ctx => {
  // A surface that refuses (a finishing take, closedBy="none") re-arms with a
  // watcher created inside the close event, with no new user activation. It
  // must stay its own step: the surface beneath (a pane under the take) is
  // never closed along with it, however many requests it refuses.
  spyCloseWatcher(ctx);
  let lower = 0, upper = 0, upperCloses = false;
  const openLower = document.createElement("button"); openLower.textContent = "Open the pane";
  const openUpper = document.createElement("button"); openUpper.textContent = "Start the take";
  document.body.append(openLower, openUpper);
  let a: ReturnType<typeof watchCloseRequests> | null = null, b: ReturnType<typeof watchCloseRequests> | null = null;
  openLower.onclick = () => { a = watchCloseRequests(document, () => { lower++; return true; }, { escape: false }); };
  // When the upper surface closes, its owner destroys the watch, as an unmount does.
  openUpper.onclick = () => { b = watchCloseRequests(document, () => { upper++; if (upperCloses) queueMicrotask(() => b!.destroy()); return upperCloses; }, { escape: false }); };
  ctx.onTestFinished(() => { a?.destroy(); b?.destroy(); openLower.remove(); openUpper.remove(); });
  await userEvent.click(openLower); await userEvent.click(openUpper);
  for (let i = 1; i <= 8; i++) {
    await userEvent.keyboard("{Escape}"); await frame();
    expect([upper, lower], `refusal ${i} reached only the upper surface`).toEqual([i, 0]);
  }
  upperCloses = true;
  await userEvent.keyboard("{Escape}"); await frame();
  expect([upper, lower], "the upper surface closes on its own").toEqual([9, 0]);
  await userEvent.keyboard("{Escape}"); await frame();
  expect([upper, lower], "the next request reaches the surface beneath").toEqual([9, 1]);
});

test("a disarmed surface with the Escape fallback still closes on Escape, and the page does not also take it", async ctx => {
  spyCloseWatcher(ctx);
  const pageWatcher = new (window as unknown as { CloseWatcher: new () => EventTarget & { destroy(): void } }).CloseWatcher();
  let reachedPage = 0;
  pageWatcher.addEventListener("close", () => { reachedPage++; });
  ctx.onTestFinished(() => pageWatcher.destroy());
  let dismissals = 0;
  const watch = watchCloseRequests(document, () => { dismissals++; return true; }, { armed: false });
  ctx.onTestFinished(() => watch.destroy());
  await userEvent.keyboard("{Escape}"); await frame();
  expect(dismissals, "Escape closes it at any depth (D52 N2)").toBe(1);
  expect(reachedPage, "one gesture, one action").toBe(0);
});
