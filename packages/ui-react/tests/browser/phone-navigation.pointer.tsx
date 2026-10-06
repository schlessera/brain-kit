/**
 * The phone's navigation in the real shell (#947, D52 §§1–2 and §8).
 *
 * The real AppShell (rail, phone bar, palette) and the real ChatPage,
 * ActivityPage and GraphPage render in Chromium against a real client root,
 * inside the kit's rail projects: fine, coarse and mixed pointers, each in
 * its own browser, all with reduced motion. Every activation is a native
 * mouse click or a native touch tap at the control's own box, never
 * `element.click()`. Only the transports are fixtures: a socket that never
 * opens, and a `request` that answers with Odysseus's data. No key, no
 * network.
 *
 * The matrix records, for every start state and every target, the
 * activations a pointer actually takes, and compares them with D52 §2's
 * phone table: one test per cell, each on a fresh mount (#1077).
 *
 * Every test owns its scene. A test that times out keeps running in the
 * background, so its scene, its recorded writes and its native input are
 * fenced by the test's own abort signal: it cannot act on the next test's
 * root.
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
type Scene = { ui: BrainUiRoot; host: HTMLDivElement; writes: string[]; signal: AbortSignal };

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
const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

type Start = "empty" | "occupied" | "sessions" | "actions" | "graph" | "files" | "settings";

/** Mounts the shell for one test. The test's own end unmounts it. */
async function mount(ctx: TestContext, start: Start, opts: { width?: number; height?: number; theme?: string; connected?: boolean } = {}): Promise<Scene> {
  const width = opts.width ?? 320;
  const height = opts.height ?? 640;
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
  const s: Scene = { ui, host, writes, signal: ctx.signal };
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  // AppShell writes the store theme to the document, so the scene sets it there.
  ui.stores.ui.getState().setTheme(opts.theme === "light" ? "light" : "dark");
  ui.stores.connection.setState({ wsStatus: opts.connected === false ? "disconnected" : "connected" } as never);
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
  ui.stores.connection.setState({ wsStatus: opts.connected === false ? "disconnected" : "connected" } as never);
  await settle(s);
  return s;
}

const PHONE_BAR = 'nav[aria-label="Primary"].tablet\\:hidden';

/** A visible, operable control by accessible name, or null. */
function find(s: Scene, name: string | RegExp, role?: string): HTMLElement | null {
  const all = [...s.host.querySelectorAll<HTMLElement>(role ? `[role="${role}"]` : 'button, [role="button"], [role="tab"]')];
  return all.find((el) => {
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const r = rect(el);
    return (typeof name === "string" ? label === name : name.test(label)) && r.width > 0 && r.height > 0;
  }) ?? null;
}
function must(s: Scene, name: string | RegExp, role?: string): HTMLElement {
  const el = find(s, name, role);
  if (!el) throw new Error(`no visible control ${name}`);
  return el;
}

/**
 * One native press inside the control's box, checked to land on it first.
 * The scene's signal is checked last before the input is sent, with no await
 * in between, so a test that has ended never presses the next test's screen.
 */
async function press(s: Scene, el: HTMLElement, mode: string) {
  // A short viewport scrolls the control into reach first, as a thumb would.
  el.scrollIntoView({ block: "nearest" });
  await settle(s, 1);
  const r = rect(el);
  const point = { x: r.left + Math.min(6, r.width / 4), y: r.top + r.height / 2 };
  const hit = document.elementFromPoint(point.x, point.y);
  expect(el.contains(hit), `nothing covers ${el.getAttribute("aria-label") ?? el.textContent} at ${point.x},${point.y}: ${hit?.outerHTML.slice(0, 120)}`).toBe(true);
  s.signal.throwIfAborted();
  if (mode === "fine") await commands.overlayMouse(point);
  else await commands.rankTap(point);
}
/** A press, then the frames its effects take. */
async function activate(s: Scene, el: HTMLElement, mode: string) {
  await press(s, el, mode);
  await settle(s);
}

/**
 * A finite animation still moving the control: its own entrance, a sheet's
 * around it, or the exit of something over it. A press is only aimed at a
 * control at rest, because a press on a sheet still entering can land beside
 * it (#992). An infinite animation (a pulsing status) never settles and moves
 * nothing a press aims at.
 */
const moving = (el: Element) => document.getAnimations().some((a) => {
  const target = (a.effect as KeyframeEffect | null)?.target;
  return a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity
    && !!target && (target.contains(el) || el.contains(target));
});

const ui$ = (s: Scene) => s.ui.stores.ui.getState();
const chat$ = (s: Scene) => s.ui.stores.chat.getState();
const onlyPanel = (s: Scene, key: string) => {
  const state = ui$(s) as unknown as Record<string, unknown>;
  return ["sessionPanelOpen", "syncPanelOpen", "whatsupPanelOpen", "searchPanelOpen", "addPanelOpen", "filePanelOpen", "settingsPanelOpen"]
    .every((k) => state[k] === (k === key));
};

/**
 * What each target is, and the path a phone takes to it from each start
 * (D52 §2). A step is the control to press next, or null while it is not on
 * screen.
 */
type Step = { name: string; find: (s: Scene) => HTMLElement | null };
const tab = (name: string): Step => ({ name: `${name} tab`, find: (s) => find(s, new RegExp(`^${name}`), "tab") });
const row = (name: string): Step => ({ name, find: (s) => find(s, new RegExp(`^${name}`), "button") });
const more = (name: string) => [tab("More"), row(name)];
const disc = (name: string): Step => ({ name, find: (s) => find(s, name) });
const chip = (label: string): Step => ({ name: label, find: (s) => find(s, new RegExp(`^${label}`), "button") });
const session: Step = { name: "Raft supplies for Ogygia", find: (s) => find(s, /^Raft supplies for Ogygia/) };
const targets: Record<string, { reached: (s: Scene) => boolean; path: (start: Start) => Step[] }> = {
  Chat: { reached: (s) => ui$(s).activeView === "chat" && onlyPanel(s, "none"), path: () => [tab("Chat")] },
  Sessions: { reached: (s) => onlyPanel(s, "sessionPanelOpen"), path: () => [tab("Sessions")] },
  Actions: { reached: (s) => ui$(s).activeView === "activity" && onlyPanel(s, "none"), path: () => [tab("Actions")] },
  Files: { reached: (s) => onlyPanel(s, "filePanelOpen"), path: () => [tab("Files")] },
  Settings: { reached: (s) => onlyPanel(s, "settingsPanelOpen"), path: () => more("Settings") },
  Graph: { reached: (s) => ui$(s).activeView === "graph" && onlyPanel(s, "none"), path: () => more("Graph") },
  "New chat": {
    reached: (s) => ui$(s).activeView === "chat" && chat$(s).draft === null && chat$(s).activeSessionId === null && onlyPanel(s, "none"),
    path: (start) => start === "empty" ? [] : start === "occupied" ? [disc("New chat")] : start === "sessions" ? [disc("New conversation")] : [tab("Sessions"), disc("New conversation")],
  },
  Search: {
    reached: (s) => ui$(s).searchPanelOpen,
    path: (start) => start === "empty" ? [chip("Search…")] : start === "occupied" ? [disc("Search the brain")] : [tab("Chat"), disc("Search the brain")],
  },
  "Add a note": { reached: (s) => ui$(s).addPanelOpen, path: (start) => start === "empty" ? [chip("Add a note…")] : more("Add a note") },
  "Daily briefing": { reached: (s) => ui$(s).whatsupPanelOpen, path: (start) => start === "empty" ? [chip("What's new\\?")] : more("Daily briefing") },
  Sync: { reached: (s) => ui$(s).syncPanelOpen, path: () => more("Sync the brain") },
  Stats: { reached: (s) => (chat$(s).draft?.messages ?? []).some((m) => m.role === "user" && m.content === "Stats"), path: () => more("Brain statistics") },
  "Open a session": { reached: (s) => chat$(s).activeSessionId === "odysseus-B", path: (start) => start === "sessions" ? [session] : [tab("Sessions"), session] },
};

/** D52 §2's phone table: the counts the contract allows. */
const ALLOWED: Record<string, Record<Start, number>> = {
  Chat: { empty: 0, occupied: 0, sessions: 1, actions: 1, graph: 1, files: 1, settings: 1 },
  Sessions: { empty: 1, occupied: 1, sessions: 0, actions: 1, graph: 1, files: 1, settings: 1 },
  Actions: { empty: 1, occupied: 1, sessions: 1, actions: 0, graph: 1, files: 1, settings: 1 },
  Files: { empty: 1, occupied: 1, sessions: 1, actions: 1, graph: 1, files: 0, settings: 1 },
  Settings: { empty: 2, occupied: 2, sessions: 2, actions: 2, graph: 2, files: 2, settings: 0 },
  Graph: { empty: 2, occupied: 2, sessions: 2, actions: 2, graph: 0, files: 2, settings: 2 },
  "New chat": { empty: 0, occupied: 1, sessions: 1, actions: 2, graph: 2, files: 2, settings: 2 },
  Search: { empty: 1, occupied: 1, sessions: 2, actions: 2, graph: 2, files: 2, settings: 2 },
  "Add a note": { empty: 1, occupied: 2, sessions: 2, actions: 2, graph: 2, files: 2, settings: 2 },
  "Daily briefing": { empty: 1, occupied: 2, sessions: 2, actions: 2, graph: 2, files: 2, settings: 2 },
  Sync: { empty: 2, occupied: 2, sessions: 2, actions: 2, graph: 2, files: 2, settings: 2 },
  Stats: { empty: 2, occupied: 2, sessions: 2, actions: 2, graph: 2, files: 2, settings: 2 },
  "Open a session": { empty: 2, occupied: 2, sessions: 1, actions: 2, graph: 2, files: 2, settings: 2 },
};

const STARTS: Start[] = ["empty", "occupied", "sessions", "actions", "graph", "files", "settings"];

test("D52 §2 matrix: its cells are exactly the phone table", () => {
  // Each cell below is its own test, generated from `targets` and STARTS,
  // and asserts its own entry of ALLOWED. A row without a target would go
  // unasserted, and a target without a row would assert nothing.
  expect(Object.keys(targets).sort(), "every row of the table has a target").toEqual(Object.keys(ALLOWED).sort());
  for (const [name, counts] of Object.entries(ALLOWED)) expect(Object.keys(counts).sort(), `${name} covers every start`).toEqual([...STARTS].sort());
});

for (const width of [320, 390]) for (const start of STARTS) for (const [name, target] of Object.entries(targets)) {
  // A fresh mount per cell: Stats only stays unambiguous where a draft holds
  // it, and each count starts from the start state alone.
  test(`D52 §2 matrix at ${width} from ${start}: ${name}`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, start, { width });
    s.writes.length = 0;
    // Already there is 0 (D52 §2); otherwise the adopted path.
    const steps = target.reached(s) ? [] : target.path(start);
    for (const step of steps) {
      // Aim only at a control that is on screen and at rest, checked once a
      // frame rather than at the default 50ms.
      let el: HTMLElement | null = null;
      await expect.poll(() => (el = step.find(s)) !== null && !moving(el),
        { interval: 16, message: `${step.name} on screen and at rest, toward ${name} from ${start}` }).toBe(true);
      await press(s, el!, mode);
    }
    await expect.poll(() => target.reached(s), { message: `${name} from ${start} at ${width} (${mode}) after ${steps.length}` }).toBe(true);
    expect(steps.length, `activations to ${name} from ${start} (D52 §2)`).toBe(ALLOWED[name]![start]);
    // Opening Add, Search or a panel writes nothing. Sync and the briefing
    // start their own job and nothing else (D52 §2). The frames let a write
    // the press queued reach the fixture before it is read.
    await settle(s);
    const job = name === "Sync" ? ["POST /api/brain/sync"] : name === "Daily briefing" ? ["POST /api/brain/whatsup"] : [];
    await expect.poll(() => s.writes, { message: `${name} from ${start}: requests that write` }).toEqual(job);
  });
}

for (const theme of ["dark", "light"]) for (const [width, height] of [[320, 640], [390, 844], [320, 568], [320, 300]] as const) {
  test(`occupied Chat at ${width}×${height} (${theme}): the disc pair, the bar, DOM and focus order`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, "occupied", { width, height, theme });
    const search = must(s, "Search the brain");
    const newChat = must(s, "New chat");
    const bar = s.host.querySelector<HTMLElement>(`${PHONE_BAR} [role="tablist"]`)!;
    const tabs = [...bar.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Chat", "Sessions", "Actions", "Files", "More"]);
    // DOM and tab order (D52 §8): Search, New chat, the transcript, the
    // composer, then the bar.
    const composer = s.host.querySelector<HTMLElement>("textarea")!;
    const order = [search, newChat, s.host.querySelector<HTMLElement>(".chat-message-body")!, composer, tabs[0]!];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `DOM order ${i}`).toBeTruthy();
    }
    search.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement, "Tab from Search reaches New chat").toBe(newChat);
    // Geometry: 44px boxes, inside the viewport, never over each other, the
    // scroll disc or the bar, and every corner hits its own control.
    const controls = [search, newChat, ...tabs];
    for (const el of controls) {
      const r = rect(el);
      const name = el.getAttribute("aria-label") ?? el.textContent;
      expect(r.height, `44px reach: ${name}`).toBeGreaterThanOrEqual(44);
      expect(r.width, `44px reach: ${name}`).toBeGreaterThanOrEqual(44);
      expect(r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= height, `inside the viewport: ${name}`).toBe(true);
      for (const x of [r.left + 1, r.right - 1]) for (const y of [r.top + 1, r.bottom - 1]) {
        expect(el.contains(document.elementFromPoint(x, y)), `corner hit ${name} at ${x},${y}`).toBe(true);
      }
    }
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      expect(intersects(rect(controls[i]!), rect(controls[j]!)), `no overlap: ${controls[i]!.getAttribute("aria-label") ?? controls[i]!.textContent} / ${controls[j]!.getAttribute("aria-label") ?? controls[j]!.textContent}`).toBe(false);
    }
    expect(rect(search).right, "Search sits left of New chat").toBeLessThanOrEqual(rect(newChat).left);
    expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
    // One tap opens Search, and focus moves into its panel. Keyboard focus
    // leaves first, so New chat's focus pill is not open under the finger.
    newChat.blur();
    await settle(s);
    await activate(s, search, mode);
    expect(ui$(s).searchPanelOpen).toBe(true);
    await expect.poll(() => document.activeElement?.closest('[aria-label="Search"], .fixed')?.textContent?.includes("Search") ?? false,
      { message: "focus moves into the Search panel" }).toBe(true);
    if (width === 320 && height === 640 && mode === "mixed") await page.screenshot({ element: s.host, path: `../../.vitest-attachments/phone-navigation/${theme}-320-occupied.png` });
  });

  test(`empty Chat at ${width}×${height} (${theme}): briefing, Search and Add chips, no discs`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, "empty", { width, height, theme, connected: false });
    expect(find(s, "Search the brain"), "no Search disc on the empty chat").toBeNull();
    expect(find(s, "New chat"), "no New chat disc on the empty chat").toBeNull();
    const chips = [must(s, /^What's new\?/, "button"), must(s, /^Search…/, "button"), must(s, /^Add a note…/, "button")];
    expect(chips[0]!.textContent).toContain("spends");
    expect(chips[0]!.textContent, "offline reason printed at rest").toContain("needs the host");
    expect(chips[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(s.host.textContent).not.toContain("Brain stats");
    for (const c of chips) {
      const r = rect(c);
      if (mode !== "fine") expect(r.height, `44px coarse chip: ${c.textContent}`).toBeGreaterThanOrEqual(44);
    }
    await activate(s, chips[0]!, mode);
    expect(ui$(s).whatsupPanelOpen, "a disabled briefing chip does not run").toBe(false);
    if (width === 320 && height === 640 && mode === "mixed") await page.screenshot({ element: s.host, path: `../../.vitest-attachments/phone-navigation/${theme}-320-empty.png` });
    await activate(s, chips[2]!, mode);
    expect(ui$(s).addPanelOpen, "Add opens offline: it is REST").toBe(true);
    expect(s.writes, "opening Add writes nothing").toEqual([]);
  });

  test(`More at ${width}×${height} (${theme}): rows, printed effects and reasons, focus in and back`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, "occupied", { width, height, theme, connected: false });
    const moreTab = must(s, /^More/, "tab");
    await activate(s, moreTab, mode);
    const sheet = s.host.querySelector<HTMLElement>('[role="dialog"][aria-label="More"]')!;
    expect(sheet).not.toBeNull();
    const first = sheet.querySelector<HTMLElement>('[role="button"]')!;
    expect(document.activeElement, "More focuses its first row").toBe(first);
    const text = sheet.textContent!;
    for (const [title, reason, effect] of [
      ["Daily briefing", "needs the host", "spends"],
      ["Sync the brain", "needs the host", "sync"],
    ]) expect(text, `${title} prints ${reason} and keeps ${effect}`).toContain(`${title}${reason}${effect}`);
    expect(text).not.toContain("Sessions");
    const rows = [...sheet.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(rows.map((r) => r.textContent)).toEqual(["Settings", "Graph", "Add a noteWrite it down in the brain", "Brain statisticsDocuments and software versions"]);
    for (const row of rows) {
      // A short viewport scrolls the sheet rather than clipping it.
      row.scrollIntoView({ block: "nearest" });
      const r = rect(row);
      expect(r.height, `44px row: ${row.textContent}`).toBeGreaterThanOrEqual(44);
      expect(r.bottom <= height && r.top >= 0, `row on screen: ${row.textContent}`).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    await settle(s);
    expect(s.host.querySelector('[role="dialog"][aria-label="More"]')).toBeNull();
    expect(document.activeElement, "Esc returns focus to the More slot").toBe(must(s, /^More/, "tab"));
    // A press on the scrim dismisses More and returns focus the same way.
    await activate(s, must(s, /^More/, "tab"), mode);
    const scrim = s.host.querySelector<HTMLElement>('[role="dialog"][aria-label="More"]')!.parentElement!;
    const above = rect(s.host.querySelector('[role="dialog"][aria-label="More"]')!).top;
    if (above > 8) {
      const point = { x: width / 2, y: above / 2 };
      expect(document.elementFromPoint(point.x, point.y), "the scrim is what is pressed").toBe(scrim);
      s.signal.throwIfAborted();
      if (mode === "fine") await commands.overlayMouse(point);
      else await commands.rankTap(point);
      await settle(s);
      expect(s.host.querySelector('[role="dialog"][aria-label="More"]'), "the scrim dismisses More").toBeNull();
      expect(document.activeElement, "a scrim press returns focus to the More slot").toBe(must(s, /^More/, "tab"));
    } else {
      await userEvent.keyboard("{Escape}");
      await settle(s);
    }
    if (width === 320 && height === 640 && mode === "mixed") {
      await activate(s, must(s, /^More/, "tab"), mode);
      await page.screenshot({ element: s.host, path: `../../.vitest-attachments/phone-navigation/${theme}-320-more.png` });
    }
  });

  test(`Files open at ${width}×${height} (${theme}): the bar stays reachable and Search is Chat → disc`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, "files", { width, height, theme });
    expect(ui$(s).filePanelOpen).toBe(true);
    for (const t of [...s.host.querySelectorAll<HTMLElement>(`${PHONE_BAR} [role="tab"]`)]) {
      const r = rect(t);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      expect(t.contains(hit), `the open panel does not cover ${t.textContent}`).toBe(true);
    }
    expect(must(s, /^Files/, "tab").getAttribute("aria-selected"), "Files is here").toBe("true");
    // More opens over the drawer, and Escape dismisses only More.
    await activate(s, must(s, /^More/, "tab"), mode);
    expect(s.host.querySelector('[role="dialog"][aria-label="More"]'), "More opens over Files").not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await settle(s);
    expect(s.host.querySelector('[role="dialog"][aria-label="More"]')).toBeNull();
    expect(ui$(s).filePanelOpen, "Escape leaves Files open under More").toBe(true);
    await activate(s, must(s, /^Chat/, "tab"), mode);
    expect(ui$(s).filePanelOpen, "Chat replaces the panel").toBe(false);
    await activate(s, must(s, "Search the brain"), mode);
    expect(ui$(s).searchPanelOpen).toBe(true);
  });
}

for (const width of [480, 900]) {
  test(`${width}: no phone Search disc and no bar`, async (ctx) => {
    pointer();
    const s = await mount(ctx, "occupied", { width, height: 700 });
    expect(s.host.querySelector('[aria-label="Chat actions"] [aria-label="Search the brain"]'), `no Search disc at ${width}`).toBeNull();
    expect(s.host.querySelector('[aria-label="Chat actions"] [aria-label="New chat"]'), `New chat disc stays at ${width}`).not.toBeNull();
    const nav = s.host.querySelector<HTMLElement>(PHONE_BAR)!;
    expect(rect(nav).height, `no phone bar at ${width}`).toBe(0);
  });
}
