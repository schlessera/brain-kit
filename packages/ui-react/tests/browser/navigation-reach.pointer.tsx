/**
 * Every command has a pointer route on every form factor (#953, the #929
 * epic's integrated reach proof; D52 §§1–2).
 *
 * The real AppShell (rail, phone bar, palette, Sessions pane) and the real
 * ChatPage, ActivityPage and GraphPage render in Chromium against a real
 * client root, in the kit's rail projects: fine, coarse and mixed pointers,
 * each in its own browser, all with reduced motion. Only the transports are
 * fixtures: a socket that never opens, and a `request` that answers with
 * Odysseus's data. No key, no network.
 *
 * Three things are proved here, each per width:
 *
 * 1. **Inventory.** The palette's rows, read from the mounted palette, are
 *    exactly the commands this file routes. A command added to the palette
 *    without a route here fails, so "every command" cannot drift.
 * 2. **The desktop matrix.** For 480, 900, 1279, 1280 and 1440, every start
 *    state (empty and occupied Chat, Sessions, Actions, Graph, Files and
 *    Settings open) and every target: the adopted path, taken by native
 *    presses on visible controls, reaches the target's actual effect in the
 *    number of activations D52 §2's tables allow. Rare commands go through
 *    the visible All commands button. One test per cell, each on its own
 *    scene (#1077). The phone table at 320 and 390 is
 *    `phone-navigation.pointer.tsx`'s.
 * 3. **Parity.** The dedicated route and the palette row do the same thing:
 *    the same view, panels, session, transcript and requests. At 320 and
 *    390, where there is no palette, the phone route is compared with the
 *    palette row's own handler. And every command is reachable by keyboard
 *    alone through All commands, with focus returned on Esc.
 *
 * Every press checks that nothing covers the control, every pressed control
 * has a name, a coarse pointer's controls are 44px targets, and no cell
 * overflows the document sideways.
 */
/// <reference types="@vitest/browser-playwright" />
import { afterAll, afterEach, beforeAll, expect, inject, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { useUIStore } from "../../src/stores/ui-store.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

class FixtureSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() { this.readyState = 3; }
}

const T0 = Date.UTC(2026, 6, 12, 9, 41);
const SESSIONS = [{ id: "odysseus-B", title: "Raft supplies for Ogygia", createdAt: T0 - 3_600_000, lastActiveAt: T0 - 3_600_000 }];

/** Every request the shell makes, answered offline; one scene's writes are recorded. */
function fixtureRequest(writes: string[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path.endsWith("/sessions")) return Response.json({ sessions: SESSIONS });
    if (/\/sessions\/[^/]+/.test(path)) return Response.json({ messages: [] });
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
  };
}

function Shell() {
  const view = useUIStore((s) => s.activeView);
  return (
    <AppShell>
      {view === "activity" ? <ActivityPage /> : view === "graph" ? <GraphPage /> : <ChatPage />}
    </AppShell>
  );
}

/** One test's mounted shell. Nothing about it lives at module scope. */
type Scene = { ui: BrainUiRoot; host: HTMLDivElement; writes: string[]; signal: AbortSignal; width: number };

let styles: HTMLStyleElement | undefined;
let viewport: { width: number; height: number };
/** The size the frame was last given: a mount at the same size skips two browser round trips. */
let sized: string | undefined;

beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(async () => {
  styles?.remove();
  await page.viewport(viewport.width, viewport.height);
});
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  document.documentElement.dataset.theme = "dark";
  vi.unstubAllGlobals();
});

function pointer(): "fine" | "coarse" | "mixed" {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches, "reduced motion premise").toBe(true);
  return mode;
}

/** Lets effects and frames run. A scene whose test has ended stops here. */
const settle = async (s: Scene, n = 3) => {
  for (let i = 0; i < n; i++) {
    s.signal.throwIfAborted();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  s.signal.throwIfAborted();
};
const rect = (el: Element) => el.getBoundingClientRect();

type Start = "empty" | "occupied" | "sessions" | "actions" | "graph" | "files" | "settings";

/** Mounts the shell for one test. The test's own end unmounts it. */
async function mount(ctx: TestContext, start: Start, opts: { width: number; height?: number; theme?: "dark" | "light"; connected?: boolean }): Promise<Scene> {
  const { width } = opts;
  const height = opts.height ?? 760;
  ctx.signal.throwIfAborted();
  vi.stubGlobal("WebSocket", FixtureSocket);
  if (sized !== `${width}x${height}`) {
    sized = undefined;
    await page.viewport(width, height);
    await commands.formViewport(width, height);
    sized = `${width}x${height}`;
  }
  ctx.signal.throwIfAborted();
  document.documentElement.dataset.theme = opts.theme ?? "dark";
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  const writes: string[] = [];
  const ui = createBrainUiRoot({ storage: null, request: fixtureRequest(writes) });
  const renderer: Root = createRoot(host);
  const s: Scene = { ui, host, writes, signal: ctx.signal, width };
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  ui.stores.ui.getState().setTheme(opts.theme ?? "dark");
  const wsStatus = opts.connected === false ? "disconnected" : "connected";
  ui.stores.connection.setState({ wsStatus } as never);
  if (start !== "empty") {
    const chat = ui.stores.chat.getState();
    for (let i = 0; i < 12; i++) {
      chat.addUserMessage(null, `Day ${i + 1} out of Troy: which supplies are still missing for the raft?`, "typed");
      chat.startAssistantMessage(null);
      chat.appendText(null, "Timber and rope are packed; Calypso still owes the sailcloth.");
      chat.finishAssistantMessage(null);
    }
  }
  const state = ui.stores.ui.getState();
  if (start === "sessions") state.openPanel("sessions");
  if (start === "actions") state.setActiveView("activity");
  if (start === "graph") state.setActiveView("graph");
  if (start === "files") state.openPanel("files");
  if (start === "settings") state.openPanel("settings");
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
  await document.fonts.ready;
  await settle(s, 6);
  // ChatPage's socket lease starts the fixture socket, which never opens;
  // the scene's connection state is set after it.
  ui.stores.connection.setState({ wsStatus } as never);
  await settle(s);
  return s;
}

/** A visible control by accessible name (or its text), or null. */
function find(s: Scene, name: string | RegExp, role?: string): HTMLElement | null {
  const all = [...s.host.querySelectorAll<HTMLElement>(role ? `[role="${role}"]` : 'button, [role="button"], [role="tab"], [role="option"]')];
  return all.find((el) => {
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const r = rect(el);
    return (typeof name === "string" ? label === name : name.test(label)) && r.width > 0 && r.height > 0;
  }) ?? null;
}

/**
 * A finite animation still moving the control: its own entrance, a sheet's
 * around it, or the exit of something over it. A press is only aimed at a
 * control at rest (#992).
 */
const moving = (el: Element) => document.getAnimations().some((a) => {
  const target = (a.effect as KeyframeEffect | null)?.target;
  return a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity
    && !!target && (target.contains(el) || el.contains(target));
});

/**
 * One native press inside the control's box, checked to land on it first,
 * with the reach rules every press must meet: a name, a 44px target under a
 * coarse pointer, and nothing covering the point pressed. The scene's
 * signal is checked last before the input is sent, with no await in
 * between, so a test that has ended never presses the next test's screen.
 */
async function press(s: Scene, el: HTMLElement, mode: string) {
  el.scrollIntoView({ block: "nearest" });
  await settle(s, 1);
  const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
  expect(name, `a named control: ${el.outerHTML.slice(0, 80)}`).not.toBe("");
  const r = rect(el);
  // Palette rows are 34px under every pointer: #1120, measured by its own
  // cell below, so that defect does not hide the rest of each cell.
  if (mode !== "fine" && el.getAttribute("role") !== "option") {
    expect(r.height, `44px target height: ${name}`).toBeGreaterThanOrEqual(43.5);
    expect(r.width, `44px target width: ${name}`).toBeGreaterThanOrEqual(43.5);
  }
  const point = { x: r.left + Math.min(6, r.width / 4), y: r.top + r.height / 2 };
  const hit = document.elementFromPoint(point.x, point.y);
  expect(el.contains(hit), `nothing covers ${name} at ${point.x},${point.y}: ${hit?.outerHTML.slice(0, 120)}`).toBe(true);
  s.signal.throwIfAborted();
  if (mode === "fine") await commands.overlayMouse(point);
  else await commands.rankTap(point);
}

const ui$ = (s: Scene) => s.ui.stores.ui.getState();
const chat$ = (s: Scene) => s.ui.stores.chat.getState();
const PANELS = ["sessionPanelOpen", "syncPanelOpen", "whatsupPanelOpen", "searchPanelOpen", "addPanelOpen", "filePanelOpen", "settingsPanelOpen"] as const;
const onlyPanel = (s: Scene, key: string) => {
  const state = ui$(s) as unknown as Record<string, unknown>;
  return PANELS.every((k) => state[k] === (k === key));
};
const pane = (s: Scene) => s.host.querySelector<HTMLElement>("section[data-sessions-pane]");
const wideAt = (width: number) => width >= 1280;

/** What a command did, compared between routes: never the route itself. */
function effect(s: Scene) {
  const ui = ui$(s) as unknown as Record<string, unknown>;
  const chat = chat$(s);
  return {
    view: ui$(s).activeView,
    panels: PANELS.filter((k) => ui[k] === true),
    session: chat.activeSessionId,
    transcript: (chat.draft?.messages ?? []).map((m) => `${m.role}:${m.content}`).slice(-2),
    messages: chat.draft?.messages.length ?? 0,
    paneFocused: pane(s)?.contains(document.activeElement) ?? false,
    writes: [...s.writes],
  };
}

/** A step: the control to press next, or null while it is not on screen. */
type Step = { name: string; find: (s: Scene) => HTMLElement | null };
const tab = (name: string): Step => ({ name: `${name} tab`, find: (s) => find(s, new RegExp(`^${name}`), "tab") });
const act = (name: string): Step => ({ name, find: (s) => s.host.querySelector<HTMLElement>(`[role="toolbar"][aria-label="Acts"] button[aria-label^="${name}"]`) });
/** The rail's palette button, named `All commands` by its text or (collapsed) its label. */
const allCommands: Step = {
  name: "All commands",
  find: (s) => [...s.host.querySelectorAll<HTMLElement>('button[aria-keyshortcuts="Meta+K"]')]
    .find((el) => rect(el).width > 0 && (el.getAttribute("aria-label") ?? el.textContent ?? "").replace("⌘K", "").trim() === "All commands") ?? null,
};
const option = (name: string): Step => ({ name: `palette ${name}`, find: (s) => find(s, new RegExp(`^${name}`), "option") });
const palette = (name: string) => [allCommands, option(name)];
const button = (name: string | RegExp): Step => ({ name: String(name), find: (s) => find(s, name, "button") ?? find(s, name) });
const session: Step = { name: "Raft supplies for Ogygia", find: (s) => s.host.querySelector<HTMLElement>('[data-session="odysseus-B"] [data-session-main] [role="button"]') };

/**
 * What each target is (its effect), and the path the desktop takes to it
 * from each start (D52 §2's three desktop tables). `reached` reads the
 * root's state and the focus; it is the target's actual effect, not where
 * the press landed.
 */
type Target = { reached: (s: Scene) => boolean; path: (start: Start, width: number) => Step[]; palette: string | null };
const targets: Record<string, Target> = {
  Chat: { reached: (s) => ui$(s).activeView === "chat" && onlyPanel(s, "none"), path: () => [tab("Chat")], palette: "Chat" },
  Sessions: {
    // From 1280 Sessions is the pane: Chat stays the view and focus moves into it (D52 §2).
    reached: (s) => wideAt(s.width) ? ui$(s).activeView === "chat" && onlyPanel(s, "none") && (pane(s)?.contains(document.activeElement) ?? false) : onlyPanel(s, "sessionPanelOpen"),
    path: () => [tab("Sessions")], palette: "Sessions",
  },
  Actions: { reached: (s) => ui$(s).activeView === "activity" && onlyPanel(s, "none"), path: () => [tab("Actions")], palette: "Actions" },
  Files: { reached: (s) => onlyPanel(s, "filePanelOpen"), path: () => [tab("Files")], palette: "Files" },
  Settings: { reached: (s) => onlyPanel(s, "settingsPanelOpen"), path: () => [tab("Settings")], palette: "Settings" },
  Graph: { reached: (s) => ui$(s).activeView === "graph" && onlyPanel(s, "none"), path: () => palette("Graph"), palette: "Graph" },
  "New chat": {
    reached: (s) => ui$(s).activeView === "chat" && chat$(s).draft === null && chat$(s).activeSessionId === null && onlyPanel(s, "none"),
    path: (start, width) => wideAt(width)
      ? (start === "empty" ? [] : start === "occupied" ? [button("New conversation")] : [tab("Sessions"), button("New conversation")])
      : (start === "empty" ? [] : start === "occupied" ? [button("New chat")] : start === "sessions" ? [button("New conversation")] : [tab("Chat"), button("New chat")]),
    palette: "New chat",
  },
  Search: { reached: (s) => ui$(s).searchPanelOpen, path: () => [act("Search the brain")], palette: "Search the brain" },
  "Add a note": { reached: (s) => ui$(s).addPanelOpen, path: () => [act("Add a note")], palette: "Add a note" },
  "Daily briefing": {
    reached: (s) => ui$(s).whatsupPanelOpen,
    // Expanded rail: a row of its own. Collapsed: the empty chat's chip, else All commands.
    path: (start, width) => width >= 900 ? [act("Daily briefing")] : start === "empty" ? [button(/^What's new\?/)] : palette("Daily briefing"),
    palette: "Daily briefing",
  },
  Sync: { reached: (s) => ui$(s).syncPanelOpen, path: () => palette("Sync the brain"), palette: "Sync the brain" },
  Stats: { reached: (s) => (chat$(s).draft?.messages ?? []).some((m) => m.role === "user" && m.content === "Stats"), path: () => palette("Brain statistics"), palette: "Brain statistics" },
  "Open a session": {
    reached: (s) => chat$(s).activeSessionId === "odysseus-B" && ui$(s).activeView === "chat",
    path: (start, width) => wideAt(width)
      ? (["empty", "occupied"].includes(start) ? [session] : [tab("Sessions"), session])
      : start === "sessions" ? [session] : [tab("Sessions"), session],
    palette: null,
  },
};

const COLLAPSED_STARTS: Start[] = ["empty", "occupied", "sessions", "actions", "graph", "files", "settings"];
/** From 1280 Sessions is a pane in Chat, not a start of its own. */
const WIDE_STARTS: Start[] = ["empty", "occupied", "actions", "graph", "files", "settings"];
const startsAt = (width: number) => wideAt(width) ? WIDE_STARTS : COLLAPSED_STARTS;

/**
 * D52 §2's desktop tables, as counts per start. Collapsed is 480–899,
 * expanded 900–1279 (the briefing is one press from anywhere), and 1280 up.
 * `Open a session` is not a row of the two narrower tables; its count there
 * is Sessions (1) and the row (1), as their "any destination" row implies.
 */
function allowed(target: string, start: Start, width: number): number {
  const current: Partial<Record<string, Start>> = { Sessions: "sessions", Actions: "actions", Files: "files", Settings: "settings" };
  const chatStart = start === "empty" || start === "occupied";
  if (wideAt(width)) {
    switch (target) {
      case "Chat": return chatStart ? 0 : 1;
      case "Sessions": case "Actions": case "Files": case "Settings": return current[target] === start ? 0 : 1;
      case "Graph": return start === "graph" ? 0 : 2;
      case "New chat": return start === "empty" ? 0 : start === "occupied" ? 1 : 2;
      case "Search": case "Add a note": case "Daily briefing": return 1;
      case "Sync": case "Stats": return 2;
      case "Open a session": return chatStart ? 1 : 2;
    }
  }
  switch (target) {
    case "Chat": return chatStart ? 0 : 1;
    case "Sessions": case "Actions": case "Files": case "Settings": return current[target] === start ? 0 : 1;
    case "Graph": return start === "graph" ? 0 : 2;
    case "New chat": return start === "empty" ? 0 : start === "occupied" || start === "sessions" ? 1 : 2;
    case "Search": case "Add a note": return 1;
    case "Daily briefing": return width >= 900 || start === "empty" ? 1 : 2;
    case "Sync": case "Stats": return 2;
    case "Open a session": return start === "sessions" ? 1 : 2;
  }
  throw new Error(`no count for ${target}`);
}

/** The palette's rows, as the mounted palette lists them, without printed keys. */
function paletteRows(s: Scene): string[] {
  return [...s.host.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Command palette"] [role="option"]')]
    .map((o) => (o.textContent ?? "").replace(/⏎/g, "").replace(/⌘\d$/, "").replace(/(spends|sync|a turn is running|needs the host)+$/g, "").trim());
}
const PALETTE_ROWS = Object.values(targets).flatMap((t) => (t.palette ? [t.palette] : []));

const DESKTOP = [480, 900, 1279, 1280, 1440] as const;
/** The cells' themes alternate by start, so each width is drawn in both. */
const themeOf = (start: Start): "dark" | "light" => (["empty", "sessions", "graph", "settings"].includes(start) ? "dark" : "light");

/** Takes `steps` from the scene's start, each aimed at a control on screen and at rest. */
async function walk(s: Scene, steps: Step[], mode: string, toward: string) {
  for (const step of steps) {
    let el: HTMLElement | null = null;
    await expect.poll(() => (el = step.find(s)) !== null && !moving(el),
      { interval: 16, message: `${step.name} on screen and at rest, toward ${toward}` }).toBe(true);
    await press(s, el!, mode);
    await settle(s);
  }
}

test("the matrix: every target has a count for every start at every width", () => {
  for (const width of DESKTOP) for (const start of startsAt(width)) for (const name of Object.keys(targets)) {
    expect(Number.isInteger(allowed(name, start, width)), `${name} from ${start} at ${width}`).toBe(true);
  }
  expect(new Set(PALETTE_ROWS).size, "one target per palette row").toBe(PALETTE_ROWS.length);
});

for (const width of [320, 390, ...DESKTOP]) for (const theme of ["dark", "light"] as const) {
  test(`inventory at ${width} (${theme}): the palette's rows are exactly the commands routed here`, async (ctx) => {
    pointer();
    const s = await mount(ctx, "occupied", { width, theme });
    ui$(s).setPaletteOpen(true);
    await settle(s);
    // Below 480 the palette is not drawn, but its rows are the same list.
    const rows = paletteRows(s);
    expect([...rows].sort(), `the palette at ${width} lists the routed commands`).toEqual([...PALETTE_ROWS].sort());
    expect(rows.filter((r) => r === "Sessions"), "Sessions once").toHaveLength(1);
  });
}

for (const width of DESKTOP) for (const start of startsAt(width)) for (const [name, target] of Object.entries(targets)) {
  test(`D52 §2 desktop matrix at ${width} from ${start}: ${name}`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, start, { width, theme: themeOf(start) });
    s.writes.length = 0;
    // Already there is 0 (D52 §2); otherwise the adopted path.
    const steps = target.reached(s) ? [] : target.path(start, width);
    await walk(s, steps, mode, `${name} from ${start}`);
    await expect.poll(() => target.reached(s), { message: `${name} from ${start} at ${width} (${mode}) after ${steps.length}` }).toBe(true);
    expect(steps.length, `activations to ${name} from ${start} at ${width} (D52 §2)`).toBe(allowed(name, start, width));
    // Opening Search, Add or a panel writes nothing; Sync and the briefing
    // start their own job and nothing else.
    await settle(s);
    const job = name === "Sync" ? ["POST /api/brain/sync"] : name === "Daily briefing" ? ["POST /api/brain/whatsup"] : [];
    await expect.poll(() => s.writes, { message: `${name} from ${start}: requests that write` }).toEqual(job);
    expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
  });
}

/**
 * Parity: from the same start, the command's dedicated route and its palette
 * row end in the same effect. The palette row is pressed by pointer from 480
 * up. Below 480 there is no palette, so its row's own handler is the
 * reference the phone route is compared with.
 */
const PHONE_PATHS: Record<string, Step[]> = {
  Chat: [tab("Chat")], Sessions: [tab("Sessions")], Actions: [tab("Actions")], Files: [tab("Files")],
  Settings: [tab("More"), button(/^Settings/)], Graph: [tab("More"), button(/^Graph/)],
  "New chat": [button("New chat")], Search: [button("Search the brain")],
  "Add a note": [tab("More"), button(/^Add a note/)], "Daily briefing": [tab("More"), button(/^Daily briefing/)],
  Sync: [tab("More"), button(/^Sync the brain/)], Stats: [tab("More"), button(/^Brain statistics/)],
};
for (const width of [320, 390, ...DESKTOP]) for (const [name, target] of Object.entries(targets)) {
  if (!target.palette) continue;
  const start: Start = name === "Chat" ? "actions" : "occupied";
  test(`parity at ${width}: ${name}'s route and its palette row do the same thing`, async (ctx) => {
    const mode = pointer();
    const theme = width % 2 ? "light" : "dark";
    const reference = await (async () => {
      const s = await mount(ctx, start, { width, theme });
      s.writes.length = 0;
      if (width < 480) {
        ui$(s).setPaletteOpen(true);
        await settle(s);
        const row = [...s.host.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Command palette"] [role="option"]')]
          .find((o) => (o.textContent ?? "").startsWith(target.palette!))!;
        expect(row, `${target.palette} is a palette row`).toBeTruthy();
        // Not drawn below 480: the row's handler, not a press, is the reference.
        row.click();
      } else {
        await walk(s, palette(target.palette!), mode, `${name} by the palette`);
      }
      await expect.poll(() => target.reached(s), { message: `${name} by the palette row` }).toBe(true);
      await settle(s);
      return effect(s);
    })();
    const s = await mount(ctx, start, { width, theme });
    s.writes.length = 0;
    await walk(s, width < 480 ? PHONE_PATHS[name]! : target.path(start, width), mode, `${name} by its route`);
    await expect.poll(() => target.reached(s), { message: `${name} by its route` }).toBe(true);
    await settle(s);
    const routed = effect(s);
    // The pane takes focus from the rail and the palette alike; elsewhere focus is the route's own.
    expect({ ...routed, paneFocused: name === "Sessions" ? routed.paneFocused : null }, `${name}: route and palette agree`)
      .toEqual({ ...reference, paneFocused: name === "Sessions" ? reference.paneFocused : null });
  });
}

/**
 * The palette's rows are the only pointer route to Graph, Sync and Stats
 * (D52 §1), so under a coarse pointer each must be a 44px target (D20). They
 * are 34px today: #1120. Until that lands this cell pins the measured gap,
 * exactly, so it goes red both when the rows shrink further and when the fix
 * lands, which is the prompt to make it the plain 44px assertion.
 */
for (const width of DESKTOP) {
  test(`palette rows under a coarse pointer at ${width}: the known #1120 gap, and nothing worse`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, "occupied", { width, theme: width % 2 ? "light" : "dark" });
    await walk(s, [allCommands], mode, "the palette");
    const rows = [...s.host.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Command palette"] [role="option"]')];
    expect(rows.length, "the palette lists its rows").toBe(PALETTE_ROWS.length);
    for (const row of rows) {
      // The list scrolls on a short palette, as a thumb would scroll it.
      row.scrollIntoView({ block: "nearest" });
      await settle(s, 1);
      const r = rect(row);
      const corner = document.elementFromPoint(r.left + 1, r.bottom - 1);
      expect(row.contains(corner), `the row's own box takes a press at its corner: ${row.textContent}`).toBe(true);
      const height = Math.round(r.height * 10) / 10;
      if (mode === "fine") continue;
      // #1120: a chipped row is 35.7px, every other row 34px.
      expect(height, `#1120 is still open: ${row.textContent} measures ${height}px; at 44px, replace this with the 44px rule`).toBe(/sync|spends/.test(row.textContent ?? "") ? 35.7 : 34);
    }
  });
}

/**
 * Keyboard alone, from 480 up: Tab reaches All commands, Enter opens the
 * palette with focus in its query, arrows reach each row and Enter runs it,
 * with the same effect a pointer gets. Esc from an opened palette returns
 * focus to All commands.
 */
for (const width of DESKTOP) for (const [name, target] of Object.entries(targets)) {
  if (!target.palette) continue;
  test(`keyboard only at ${width}: All commands → ${target.palette}`, async (ctx) => {
    pointer();
    const s = await mount(ctx, "occupied", { width, theme: width % 2 ? "light" : "dark" });
    s.writes.length = 0;
    const all = allCommands.find(s)!;
    (document.activeElement as HTMLElement | null)?.blur();
    // The rail's three stops: destinations, acts, All commands.
    for (let i = 0; i < 3; i++) await userEvent.tab();
    expect(document.activeElement, "Tab reaches All commands").toBe(all);
    await userEvent.keyboard("{Enter}");
    await settle(s);
    const dialog = () => s.host.querySelector<HTMLElement>('[role="dialog"][aria-label="Command palette"]');
    expect(dialog(), "Enter opens the palette").not.toBeNull();
    expect(document.activeElement, "focus enters the query").toBe(dialog()!.querySelector("input"));
    await userEvent.keyboard("{Escape}");
    await settle(s);
    expect(dialog()).toBeNull();
    expect(document.activeElement, "Esc returns focus to All commands").toBe(all);
    await userEvent.keyboard("{Enter}");
    await settle(s);
    const index = paletteRows(s).indexOf(target.palette!);
    expect(index, `${target.palette} is listed`).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{ArrowDown}");
    for (let i = 0; i < index; i++) await userEvent.keyboard("{ArrowDown}");
    expect((document.activeElement?.textContent ?? "").startsWith(target.palette!), `arrows reach ${target.palette}`).toBe(true);
    await userEvent.keyboard("{Enter}");
    await settle(s);
    await expect.poll(() => target.reached(s), { message: `${name} by keyboard` }).toBe(true);
    expect(dialog(), "running a row closes the palette").toBeNull();
  });
}
