/// <reference types="@vitest/browser-playwright" />
/**
 * Working sessions in the real app (#950, D52 §3, §4 and §8): the trackers
 * #948 keeps, drawn in the left half of the row above the composer below
 * 1280, and in the Sessions pane's Working group from 1280.
 *
 * The real AppShell and ChatPage render in Chromium against a real client
 * root, inside the kit's `rail-fine`, `rail-coarse` and `rail-mixed`
 * projects, all with reduced motion. Only the transports are fixtures: a
 * socket the test delivers the host's frames over, and a `request` that
 * answers with Odysseus's sessions. No key, no network. Trackers come from
 * those frames (work starting in a session nobody watches), not from
 * writing the tracker store, so each cell exercises the frame → tracker →
 * view path the app runs.
 *
 * Every test owns its scene: a fresh root and mount per cell, removed when
 * the cell ends, and nothing is pressed before entrances have settled
 * (#992). Presses are native mouse clicks or touch taps.
 */
import { afterAll, beforeAll, afterEach, expect, inject, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { trackerViews } from "../../src/stores/tracker-state.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

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
  deliver(frame: unknown) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
  frames(type: string) { return this.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === type); }
}

const T0 = Date.UTC(2026, 6, 12, 9, 41);
const HOUR = 3_600_000;

/** The session in view: Odysseus asking about the way home. */
const ITHACA = { id: "odysseus-ithaca", title: "The way home to Ithaca" };
/** Work left running elsewhere, one per state the cells need. */
const RAFT = { id: "odysseus-raft", title: "Raft lashing plan" };
/** #1004's host labeller gave this one a few-word label, which wins over the title. */
const TIMBER = { id: "odysseus-timber", title: "How much timber does the raft still need?", label: "Raft timber tally" };
const PENELOPE = { id: "odysseus-penelope", title: "Letter to Penelope" };
const CIRCE = { id: "odysseus-circe", title: "Compare Circe's sailing directions against the forecast from the house of the dead" };
const OLDER = Array.from({ length: 6 }, (_, i) => ({ id: `odysseus-day-${i}`, title: `Day ${i + 1} on Ogygia` }));
const LISTED: Array<{ id: string; title: string; label?: string; createdAt: number; lastActiveAt: number; totalCostUsd: number; numTurns: number }> = [ITHACA, RAFT, TIMBER, PENELOPE, CIRCE, ...OLDER].map((s, i) => ({
  ...s, createdAt: T0 - i * HOUR, lastActiveAt: T0 - i * HOUR, totalCostUsd: 0, numTurns: 1,
}));

/** How many times the app has read the session list. */
let sessionReads = 0;

function fixtureRequest() {
  return async (url: string): Promise<Response> => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (path.endsWith("/sessions")) { sessionReads++; return Response.json({ sessions: LISTED }); }
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
  };
}

function Shell() {
  const view = useUIStore((s) => s.activeView);
  return <AppShell>{view === "activity" ? <ActivityPage /> : <ChatPage />}</AppShell>;
}

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; socket: FixtureSocket; width: number; signal: AbortSignal };

let styles: HTMLStyleElement | undefined;
let viewport: { width: number; height: number };
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

const settle = async (s: Scene, n = 3) => {
  for (let i = 0; i < n; i++) {
    s.signal.throwIfAborted();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  s.signal.throwIfAborted();
};

/** A finite animation or transition still running: a drawer entering, a sheet rising (#992). */
const moving = () => document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);

async function resize(width: number, height: number) {
  if (sized === `${width}x${height}`) return;
  sized = undefined;
  await page.viewport(width, height);
  await commands.formViewport(width, height);
  sized = `${width}x${height}`;
}

/** A transcript long enough to scroll at every width, every turn linked to its host turn. */
function history(sessionId: string, turns = 10, linked = true) {
  return Array.from({ length: turns }, (_, i) => [
    { role: "user", content: `Day ${i + 1} out of Troy: what is still missing for the raft?`, toolCalls: [] },
    { role: "assistant", content: "Timber and rope are packed; Calypso still owes the sailcloth.", toolCalls: [], ...(linked ? { turnId: `${sessionId}-turn-${i + 1}` } : {}) },
  ]).flat();
}

async function mount(ctx: TestContext, width: number, height: number, theme: "dark" | "light", opts: { empty?: boolean } = {}): Promise<Scene> {
  ctx.signal.throwIfAborted();
  vi.stubGlobal("WebSocket", FixtureSocket);
  await resize(width, height);
  ctx.signal.throwIfAborted();
  document.documentElement.dataset.theme = theme;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: fixtureRequest() });
  const renderer: Root = createRoot(host);
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  ui.stores.ui.getState().setTheme(theme);
  if (!opts.empty) ui.stores.chat.getState().setActiveSession(ITHACA.id);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
  ui.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, followUpQueue: true } });
  if (!opts.empty) {
    socket.deliver({ type: "session_info", sessionId: ITHACA.id, isNew: false });
    socket.deliver({ type: "session_history", sessionId: ITHACA.id, messages: history(ITHACA.id) });
  }
  const s: Scene = { ui, host, socket, width, signal: ctx.signal };
  await document.fonts.ready;
  await settle(s, 4);
  return s;
}

/** Work that starts in sessions nobody is watching: the frames a host sends for it. */
const work = {
  /** Waiting on an approval: `needs you · approval`. */
  raft: (s: Scene) => {
    s.socket.deliver({ type: "status", sessionId: RAFT.id, status: "thinking", turnId: "raft-turn" });
    s.socket.deliver({ type: "tool_approval_request", sessionId: RAFT.id, turnId: "raft-turn", toolUseId: "tool-raft", toolName: "Write", input: { file_path: "voyage/raft-lashings.md", content: "Lash the beams with the ropes Calypso gave." } });
  },
  /** Still running. */
  timber: (s: Scene) => s.socket.deliver({ type: "status", sessionId: TIMBER.id, status: "thinking", turnId: "timber-turn" }),
  /** Finished. */
  penelope: (s: Scene) => {
    s.socket.deliver({ type: "status", sessionId: PENELOPE.id, status: "thinking", turnId: "penelope-turn" });
    s.socket.deliver({ type: "result", sessionId: PENELOPE.id, turnId: "penelope-turn", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
  },
  /** Running, with a title the pill has to truncate. */
  circe: (s: Scene) => s.socket.deliver({ type: "status", sessionId: CIRCE.id, status: "thinking", turnId: "circe-turn" }),
};

/** Two follow-ups waiting for the session in view (#1002), as the host reports them. */
function pending(s: Scene, n: number) {
  const followUps = Array.from({ length: n }, (_, i) => ({ id: `fu-${i}`, requestId: `req-fu-${i}`, text: i === 0 ? "Ask Aeolus about the west wind" : "Keep the bag of winds shut until we sight Ithaca", queuedAt: i + 1 }));
  s.socket.deliver({ type: "session_queue", sessionId: ITHACA.id, followUps });
}

const rect = (el: Element) => el.getBoundingClientRect();
const half = (s: Scene, side: "left" | "right") => s.host.querySelector<HTMLElement>(`[data-row-half="${side}"]`);
const stripItems = (s: Scene) => [...(half(s, "left")?.querySelectorAll<HTMLElement>('[data-pill][role="button"], [data-strip-summary]') ?? [])];
const pendingItems = (s: Scene) => [...(half(s, "right")?.querySelectorAll<HTMLElement>('[data-pill][role="button"], [data-pending-summary], button') ?? [])].filter((el) => el.getClientRects().length > 0);
const pane = (s: Scene) => s.host.querySelector<HTMLElement>("section[data-sessions-pane]");
const workingRows = (root: Element | null) => [...(root?.querySelectorAll<HTMLElement>('[data-working-row] [role="button"]') ?? [])];
const composer = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
const transcript = (s: Scene) => s.host.querySelector<HTMLElement>("[data-reading-column]")?.parentElement ?? null;
const named = (els: HTMLElement[]) => els.map((el) => el.getAttribute("aria-label") ?? "");
const views = (s: Scene) => trackerViews(s.ui.stores.trackers.getState(), s.ui.stores.chat.getState().queueNotes);

/** A native press: the mouse under a fine pointer, a touch tap otherwise. */
async function press(s: Scene, el: HTMLElement, mode: string) {
  await expect.poll(() => !moving(), { interval: 16, message: "entrances have settled" }).toBe(true);
  el.scrollIntoView({ block: "nearest" });
  await settle(s, 1);
  const r = rect(el);
  const point = { x: r.left + Math.min(12, r.width / 4), y: r.top + r.height / 2 };
  expect(el.contains(document.elementFromPoint(point.x, point.y)), "nothing covers the control").toBe(true);
  s.signal.throwIfAborted();
  if (mode === "fine") await commands.overlayMouse(point);
  else await commands.rankTap(point);
  await settle(s);
}

/** The row's geometry rules (D52 §3), for what is drawn now. */
function rowGeometry(s: Scene, keyboard = false) {
  const left = rect(half(s, "left")!);
  const right = rect(half(s, "right")!);
  const row = rect(s.host.querySelector("[data-composer-row]")!);
  expect(right.left - left.right, "the gutter is at least 8px").toBeGreaterThanOrEqual(7.5);
  expect(row.height, keyboard ? "44px with the keyboard up" : "at most 94px").toBeLessThanOrEqual(keyboard ? 44.5 : 94.5);
  expect(row.bottom, "the row sits on the composer").toBeLessThanOrEqual(rect(composer(s)).top + 0.5);
  for (const [items, box, side] of [[stripItems(s), left, "left"], [pendingItems(s), right, "right"]] as const) {
    for (const el of items) {
      const r = rect(el);
      expect(r.height, `${side}: a 44px target`).toBeGreaterThanOrEqual(43.5);
      expect(r.height, `${side}: a 44px pill`).toBeLessThanOrEqual(44.5);
      expect(r.left, `${side}: inside its half`).toBeGreaterThanOrEqual(box.left - 0.5);
      expect(r.right, `${side}: inside its half`).toBeLessThanOrEqual(box.right + 0.5);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      expect(el.contains(hit), `${side}: nothing overlaps ${el.getAttribute("aria-label")}`).toBe(true);
    }
  }
  const animated = [...(s.host.querySelector("[data-composer-row]")?.getAnimations({ subtree: true }) ?? [])];
  expect(animated, "nothing in the row animates").toEqual([]);
}

const NARROW = [320, 390, 480, 900, 1279] as const;
const WIDE = [1280, 1440] as const;
const THEMES = ["dark", "light"] as const;

for (const theme of THEMES) for (const width of NARROW) {
  test(`${width} (${theme}): three trackers beside two follow-ups, in the left half, apart from the scroll disc`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 640, theme);
    work.raft(s); work.timber(s); work.penelope(s);
    pending(s, 2);
    await expect.poll(() => stripItems(s).length, { message: "the strip is drawn" }).toBe(2);
    await expect.poll(() => named(stripItems(s))[0], { message: "the session list names them" }).toMatch(/^Raft lashing plan/);
    // The most urgent tracker and a summary of the rest (D52 §3).
    expect(named(stripItems(s))).toEqual([
      "Raft lashing plan, needs you, approval. Open session.",
      "2 more working sessions: 1 running, 1 done. Open list.",
    ]);
    expect(pane(s), "no Sessions pane below 1280").toBeNull();
    expect(s.host.querySelector('[aria-label="New chat"]'), "the New chat disc is drawn below 1280").not.toBeNull();
    expect(pendingItems(s).length, "the follow-ups keep the right half").toBeGreaterThan(0);
    rowGeometry(s);

    // Scrolled up, the scroll disc is drawn inside the message area: its
    // 32px paint (6px inside its 44px box) is at least 16px above the row.
    const t = transcript(s)!;
    t.scrollTop = 0;
    t.dispatchEvent(new Event("scroll"));
    await settle(s);
    const disc = s.host.querySelector<HTMLElement>('[aria-label="Scroll to latest"]');
    expect(disc, "the scroll disc is drawn").not.toBeNull();
    expect(rect(s.host.querySelector("[data-composer-row]")!).top - (rect(disc!).bottom - 6), "disc paint ≥16px above the row").toBeGreaterThanOrEqual(15.5);
    rowGeometry(s);

    // The summary opens the Working sheet: every tracker, in order.
    await press(s, stripItems(s)[1]!, mode);
    const sheet = await expect.poll(() => document.querySelector<HTMLElement>("[data-working-sheet]"), { message: "the sheet opens" }).not.toBeNull();
    void sheet;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-working-sheet] [role="button"]')];
    expect(named(rows)).toEqual([
      "Raft lashing plan, needs you, approval. Open session.",
      expect.stringMatching(/^Raft timber tally, running/),
      expect.stringMatching(/^Letter to Penelope, done/),
    ]);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.activeElement, { message: "focus returns to the summary" }).toBe(stripItems(s)[1]);
  });

  test(`${width} (${theme}): one long-titled tracker in an empty chat keeps its column`, async (ctx) => {
    pointer();
    const s = await mount(ctx, width, 640, theme, { empty: true });
    work.circe(s);
    await expect.poll(() => named(stripItems(s))[0] ?? "", { message: "the session list names it" }).toMatch(/^Compare Circe/);
    expect(stripItems(s)).toHaveLength(1);
    const pill = stripItems(s)[0]!;
    // The label truncates; the state word does not.
    const word = [...pill.querySelectorAll<HTMLElement>("span")].find((el) => (el.textContent?.trim() ?? "").startsWith("running"));
    expect(word, "the state word is drawn").toBeDefined();
    expect(word!.scrollWidth, "the state word is not truncated").toBeLessThanOrEqual(word!.clientWidth + 0.5);
    rowGeometry(s);
    // A lone tracker stays in the left half even with nothing on the right.
    expect(rect(pill).right).toBeLessThanOrEqual(rect(half(s, "left")!).right + 0.5);
  });
}

for (const theme of THEMES) for (const width of WIDE) {
  test(`${width} (${theme}): the Sessions pane carries Working, the row carries follow-ups only`, async (ctx) => {
    pointer();
    const s = await mount(ctx, width, 720, theme);
    work.raft(s); work.timber(s); work.penelope(s);
    pending(s, 2);
    const p = await expect.poll(() => pane(s), { message: "the pane is drawn" }).not.toBeNull();
    void p;
    await expect.poll(() => named(workingRows(pane(s))).length, { message: "Working is listed" }).toBe(3);
    await expect.poll(() => named(workingRows(pane(s)))[1] ?? "", { message: "the session list names them" }).toMatch(/^Raft timber tally/);
    expect(named(workingRows(pane(s)))).toEqual([
      "Raft lashing plan, needs you, approval. Open session.",
      expect.stringMatching(/^Raft timber tally, running/),
      expect.stringMatching(/^Letter to Penelope, done/),
    ]);
    // Each tracked session is listed once: in Working, not again in its date group.
    for (const id of [RAFT.id, TIMBER.id, PENELOPE.id]) {
      expect(pane(s)!.querySelectorAll(`[data-session="${id}"]`), `${id} listed once`).toHaveLength(1);
    }
    expect(pane(s)!.querySelector(`[data-session-row][data-session="${ITHACA.id}"]`), "the date groups follow").not.toBeNull();
    const r = rect(pane(s)!);
    expect(r.width, "280px wide").toBeCloseTo(280, 0);
    expect(r.right, "beside the transcript").toBeLessThanOrEqual(rect(transcript(s)!).left + 0.5);
    expect(stripItems(s), "no pills at this width").toHaveLength(0);
    expect(half(s, "left")!.childElementCount, "the left half is empty").toBe(0);
    expect(pendingItems(s).length, "the right half keeps the follow-ups").toBeGreaterThan(0);
    rowGeometry(s);
    expect(s.host.querySelector('[aria-label="New chat"]'), "no New chat disc from 1280").toBeNull();
    const start = [...pane(s)!.querySelectorAll<HTMLElement>("[data-new-conversation] [data-bk-button]")][0]!;
    expect(start.getAttribute("aria-disabled"), "an occupied chat can be left").not.toBe("true");
    expect(pane(s)!.getAnimations({ subtree: true }), "nothing in the pane animates").toEqual([]);

    // One roving list across Working and the date groups.
    workingRows(pane(s))[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(workingRows(pane(s))[1]);
    await userEvent.keyboard("{End}");
    const items = [...pane(s)!.querySelectorAll<HTMLElement>('[data-session-item] [role="button"]')];
    expect(document.activeElement, "End reaches the last date row").toBe(items.at(-1));
    expect(items.filter((el) => el.tabIndex === 0), "one tab stop").toHaveLength(1);
  });

  test(`${width} (${theme}): in an empty chat New conversation is aria-disabled with its reason`, async (ctx) => {
    pointer();
    const s = await mount(ctx, width, 720, theme, { empty: true });
    await expect.poll(() => pane(s), { message: "the pane is drawn" }).not.toBeNull();
    const start = pane(s)!.querySelector<HTMLElement>("[data-new-conversation] [data-bk-button]")!;
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.textContent).toContain("already a new chat");
  });
}

// Keyboard up: each populated half collapses to one 44px summary, side by
// side; past three composer lines the row hides (R4). No platform reports a
// soft keyboard to a test, so its evidence is supplied: a visual viewport
// 260px shorter than the layout one, which is what `useSoftKeyboard` reads.
for (const theme of THEMES) for (const width of [320, 390, 900] as const) {
  test(`${width} (${theme}): keyboard up, the halves are one summary each, and R4 hides the row`, async (ctx) => {
    const mode = pointer();
    if (mode === "fine") ctx.skip();
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const fake = { get height() { return window.innerHeight - 260; }, width: window.innerWidth, scale: 1, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    ctx.onTestFinished(() => {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    });
    const s = await mount(ctx, width, 568, theme);
    work.raft(s); work.timber(s); work.penelope(s);
    pending(s, 2);
    await expect.poll(() => stripItems(s).length, { message: "the strip is drawn" }).toBe(2);
    await press(s, composer(s), mode);
    await expect.poll(() => s.host.querySelector("[data-strip-summary='keyboard']"), { message: "the keyboard summary" }).not.toBeNull();
    expect(named(stripItems(s))).toEqual(["3 working sessions: 1 needs you, 1 running, 1 done. Open list."]);
    rowGeometry(s, true);
    // Four lines: the row hides first, and the transcript keeps its height.
    await userEvent.fill(composer(s), "Line one\nLine two\nLine three\nLine four");
    await expect.poll(() => stripItems(s).length + pendingItems(s).length, { message: "R4: the row hides" }).toBe(0);
    expect(rect(s.host.querySelector("[data-composer-row]")!).height, "no spacer").toBe(0);
    expect(rect(transcript(s)!.parentElement!).height, "the transcript keeps at least 150px").toBeGreaterThanOrEqual(150);
  });
}

// Opening a tracker (D52 §4): reattach without a turn, show the latest
// turn, move focus, and clear only once it is seen.
for (const width of [320, 480, 1279, 1440] as const) {
  test(`${width}: opening a tracker that needs you reattaches it and focuses its card`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 640, "dark");
    work.raft(s);
    const where = () => (width >= 1280 ? workingRows(pane(s)) : stripItems(s));
    await expect.poll(() => named(where())[0] ?? "", { message: "drawn" }).toMatch(/^Raft lashing plan/);
    const before = s.socket.sent.length;
    await press(s, where()[0]!, mode);
    expect(s.ui.stores.chat.getState().activeSessionId).toBe(RAFT.id);
    const sent = s.socket.sent.slice(before).map((raw) => JSON.parse(raw));
    expect(sent.filter((f) => f.type === "session_resume"), "reattached").toEqual([{ type: "session_resume", sessionId: RAFT.id }]);
    expect(sent.filter((f) => f.type === "chat_message"), "no turn started").toEqual([]);
    // The host replays the history, ending on the user's message, and
    // re-delivers the approval (R3: the card is drawn in a turn shell).
    s.socket.deliver({ type: "session_info", sessionId: RAFT.id, isNew: false });
    s.socket.deliver({ type: "session_history", sessionId: RAFT.id, messages: [{ role: "user", content: "Write the lashings note to the raft log.", toolCalls: [] }] });
    s.socket.deliver({ type: "tool_approval_request", sessionId: RAFT.id, turnId: "raft-turn", toolUseId: "tool-raft", toolName: "Write", input: { file_path: "voyage/raft-lashings.md", content: "Lash the beams." } });
    // The resume ends as the host ends it: the turn waiting on the approval is still running.
    s.socket.deliver({ type: "status", sessionId: RAFT.id, status: "thinking", detail: "Session in progress", turnId: "raft-turn" });
    const control = () => s.host.querySelector<HTMLElement>('[data-approval-card] [data-kit-approval-actions] [role="button"]');
    await expect.poll(() => control(), { message: "the card is drawn" }).not.toBeNull();
    expect(control()?.getAttribute("aria-label") ?? control()?.textContent, "the first permission decision is Allow").toMatch(/^Allow(?:$| )/);
    // A waiting card takes focus at every width, the phone included.
    await expect.poll(() => document.activeElement, { message: "focus is on the card's first control" }).toBe(control());
    expect(views(s).find((v) => v.sessionId === RAFT.id)?.state, "still waiting on the reader").toBe("needs_you");
  });

  test(`${width}: opening a finished tracker shows its latest turn, focuses as §4 rules, and clears by proof`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 640, "dark");
    work.penelope(s);
    const where = () => (width >= 1280 ? workingRows(pane(s)) : stripItems(s));
    await expect.poll(() => named(where())[0] ?? "", { message: "drawn" }).toMatch(/^Letter to Penelope, done/);
    await press(s, where()[0]!, mode);
    expect(s.ui.stores.chat.getState().activeSessionId).toBe(PENELOPE.id);
    expect(views(s).find((v) => v.sessionId === PENELOPE.id)?.cleared, "selecting it clears nothing").toBe(false);
    s.socket.deliver({ type: "session_info", sessionId: PENELOPE.id, isNew: false });
    const replay = history(PENELOPE.id, 9);
    replay.push({ role: "user", content: "Write to Penelope that the raft is nearly done.", toolCalls: [] }, { role: "assistant", content: "Written: the raft is nearly done, and the sailcloth is coming.", toolCalls: [], turnId: "penelope-turn" });
    s.socket.deliver({ type: "session_history", sessionId: PENELOPE.id, messages: replay });
    s.socket.deliver({ type: "status", sessionId: PENELOPE.id, status: "idle", detail: "Session loaded" });
    await expect.poll(() => views(s).find((v) => v.sessionId === PENELOPE.id)?.cleared ?? true, { message: "seen once the latest turn is on screen" }).toBe(true);
    expect(s.ui.stores.trackers.getState().records[PENELOPE.id]?.seen?.basis, "by proof").toBe("proof");
    const t = transcript(s)!;
    expect(t.scrollHeight - t.scrollTop - t.clientHeight, "at the latest turn").toBeLessThan(20);
    // Focus moves once the replay has gone quiet.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (width < 480) expect(document.activeElement, "a phone focuses nothing, so no keyboard opens").not.toBe(composer(s));
    else expect(document.activeElement, "the composer").toBe(composer(s));
    expect(where(), "a cleared tracker is not drawn").toHaveLength(0);
  });
}

// A long history comes in chunks; focus waits for the last one, where the
// failed turn is. And a panel opened before the replay lands keeps focus.
for (const width of [320, 900, 1440] as const) {
  test(`${width}: opening a failed tracker waits out a chunked replay and focuses the failure's action`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 640, "dark");
    work.circe(s);
    s.socket.deliver({ type: "result", sessionId: CIRCE.id, turnId: "circe-turn", outcome: "error", isError: true, durationMs: 0, numTurns: 1 });
    const where = () => (width >= 1280 ? workingRows(pane(s)) : stripItems(s));
    await expect.poll(() => named(where())[0] ?? "", { message: "drawn" }).toMatch(/^Compare Circe.*, failed/);
    await press(s, where()[0]!, mode);
    s.socket.deliver({ type: "session_info", sessionId: CIRCE.id, isNew: false });
    s.socket.deliver({ type: "session_history", sessionId: CIRCE.id, messages: history(CIRCE.id, 6) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    s.socket.deliver({
      type: "session_history", sessionId: CIRCE.id, append: true, messages: [
        { role: "user", content: "Check Circe's directions against the forecast.", toolCalls: [] },
        { role: "assistant", content: "", toolCalls: [], turnId: "circe-turn", retryOfTurnId: "circe-turn", failure: { errorClass: "server_error", message: "The storm cut the line to the host." } },
      ],
    });
    s.socket.deliver({ type: "status", sessionId: CIRCE.id, status: "idle", detail: "Session loaded" });
    const action = () => [...s.host.querySelectorAll<HTMLElement>("[data-turn-failure] .bk-turn-error-actions [data-bk-button]")].at(0) ?? null;
    await expect.poll(() => action(), { message: "the failure is drawn with its action" }).not.toBeNull();
    await expect.poll(() => document.activeElement, { message: "focus is on the failure's primary action" }).toBe(action());
  });

  for (const over of ["Settings", "a subagent view"] as const) test(`${width}: ${over} opened before the replay lands keeps focus`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 640, "dark");
    work.penelope(s);
    const where = () => (width >= 1280 ? workingRows(pane(s)) : stripItems(s));
    await expect.poll(() => where().length, { message: "drawn" }).toBe(1);
    await press(s, where()[0]!, mode);
    if (over === "Settings") s.ui.stores.ui.getState().openPanel("settings");
    else s.ui.stores.ui.getState().pushSubagentView("span-sirens");
    await settle(s);
    const overlay = over === "Settings"
      ? s.host.querySelector<HTMLElement>('section[aria-label="Settings"] nav[aria-label="Settings sections"]') ?? [...s.host.querySelectorAll<HTMLElement>("h1, h2")].find((el) => el.textContent === "Settings")
      : [...s.host.querySelectorAll<HTMLElement>("p")].find((el) => el.textContent?.includes("No recorded activity for this subagent"));
    expect(overlay, `${over} is actually drawn before the late replay`).toBeDefined();
    expect(overlay!.getBoundingClientRect().height, `${over} has visible content`).toBeGreaterThan(0);
    const inside = document.activeElement;
    s.socket.deliver({ type: "session_info", sessionId: PENELOPE.id, isNew: false });
    s.socket.deliver({ type: "session_history", sessionId: PENELOPE.id, messages: history(PENELOPE.id, 3) });
    s.socket.deliver({ type: "status", sessionId: PENELOPE.id, status: "idle", detail: "Session loaded" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle(s);
    expect(document.activeElement, `the composer behind ${over} takes nothing`).not.toBe(composer(s));
    expect(document.activeElement).toBe(inside);
  });
}

// R1: a latest turn no replay links offers `Mark as seen`.
for (const width of [390, 1440] as const) for (const turns of [3, 0]) {
  test(`${width}: ${turns ? "an unlinked latest turn" : "an empty history"} offers Mark as seen, stored as acknowledged`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 640, "light");
    work.penelope(s);
    const where = () => (width >= 1280 ? workingRows(pane(s)) : stripItems(s));
    await expect.poll(() => where().length, { message: "drawn" }).toBe(1);
    await press(s, where()[0]!, mode);
    s.socket.deliver({ type: "session_info", sessionId: PENELOPE.id, isNew: false });
    s.socket.deliver({ type: "session_history", sessionId: PENELOPE.id, messages: history(PENELOPE.id, turns, false) });
    s.socket.deliver({ type: "status", sessionId: PENELOPE.id, status: "idle", detail: "Session loaded" });
    const mark = () => s.host.querySelector<HTMLElement>("[data-mark-seen] [data-bk-button]");
    await expect.poll(() => mark(), { message: "Mark as seen is offered" }).not.toBeNull();
    await settle(s, 4);
    expect(views(s).find((v) => v.sessionId === PENELOPE.id)?.cleared, "nothing proves it seen").toBe(false);
    await press(s, mark()!, mode);
    expect(s.ui.stores.trackers.getState().records[PENELOPE.id]?.seen?.basis).toBe("acknowledged");
    expect(mark(), "the row goes with the tracker").toBeNull();
    expect(where()).toHaveLength(0);
  });
}

// Announcements (D52 §3): once, politely, for a change to needs you, failed
// or done. Not for running or queued, not for repeated frames.
for (const width of [390, 1440] as const) {
  test(`${width}: a change to needs you, failed or done is announced once`, async (ctx) => {
    pointer();
    const s = await mount(ctx, width, 640, "dark");
    const live = s.host.querySelector<HTMLElement>("[data-working-live]")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    const spoken: string[] = [];
    // What a polite region speaks: each node added to it, and any text change.
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") spoken.push(r.target.textContent ?? "");
        for (const node of r.addedNodes) spoken.push(node.textContent ?? "");
      }
    });
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    ctx.onTestFinished(() => observer.disconnect());
    // The labels are the session list's; wait for it so the words are final.
    await expect.poll(() => s.ui.stores.sessions.getState().loaded, { message: "listed" }).toBe(true);

    work.timber(s);
    s.socket.deliver({ type: "status", sessionId: TIMBER.id, status: "queued", requestId: "timber-next" });
    s.socket.deliver({ type: "text_delta", sessionId: TIMBER.id, turnId: "timber-turn", text: "Counting beams" });
    await settle(s);
    expect(spoken, "running and queued are not announced").toEqual([]);
    s.socket.deliver({ type: "result", sessionId: TIMBER.id, turnId: "timber-turn", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    s.socket.deliver({ type: "result", sessionId: TIMBER.id, turnId: "timber-turn", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    work.raft(s);
    s.socket.deliver({ type: "tool_approval_request", sessionId: RAFT.id, turnId: "raft-turn", toolUseId: "tool-raft", toolName: "Write", input: { file_path: "voyage/raft-lashings.md" } });
    work.circe(s);
    s.socket.deliver({ type: "result", sessionId: CIRCE.id, turnId: "circe-turn", outcome: "error", isError: true, durationMs: 0, numTurns: 1 });
    await settle(s);
    expect(views(s).find((v) => v.sessionId === TIMBER.id)?.state, "the queued request is the latest work").toBe("queued");
    expect(spoken).toEqual([
      "Raft lashing plan needs you.",
      `${CIRCE.title} failed.`,
    ]);
    // The queued request runs and finishes: done, said once.
    s.socket.deliver({ type: "session_info", sessionId: TIMBER.id, isNew: false, requestId: "timber-next", turnId: "timber-turn-2" });
    s.socket.deliver({ type: "result", sessionId: TIMBER.id, turnId: "timber-turn-2", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    s.socket.deliver({ type: "result", sessionId: TIMBER.id, turnId: "timber-turn-2", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    await settle(s);
    expect(spoken.slice(2)).toEqual(["Raft timber tally is done."]);
  });
}

// #1004's host saves a new label a moment after the turn starts: the end of
// the turn reads the list again, so the pill does not keep the old one.
for (const width of [390, 1440] as const) {
  test(`${width}: a label the host saved during the turn is drawn once the turn ends`, async (ctx) => {
    pointer();
    const listed = LISTED.find((l) => l.id === TIMBER.id)!;
    ctx.onTestFinished(() => { listed.label = TIMBER.label; });
    const s = await mount(ctx, width, 640, "dark");
    const where = () => (width >= 1280 ? workingRows(pane(s)) : stripItems(s));
    work.timber(s);
    await expect.poll(() => named(where())[0] ?? "", { message: "drawn with the label" }).toMatch(/^Raft timber tally, running/);
    await settle(s, 4);
    listed.label = "Beams for the raft";
    s.socket.deliver({ type: "result", sessionId: TIMBER.id, turnId: "timber-turn", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    await expect.poll(() => named(where())[0] ?? "", { message: "the saved label replaces it" }).toMatch(/^Beams for the raft, done/);
  });
}

// The pane is always drawn from 1280, so the end of a turn in the session in
// view reads the list again (its cost, turn count and order move).
test("1440: the end of a turn in the session in view reads the session list again", async (ctx) => {
  pointer();
  const s = await mount(ctx, 1440, 720, "dark");
  await expect.poll(() => pane(s), { message: "the pane is drawn" }).not.toBeNull();
  s.socket.deliver({ type: "status", sessionId: ITHACA.id, status: "thinking", turnId: "ithaca-turn" });
  s.socket.deliver({ type: "text_delta", sessionId: ITHACA.id, turnId: "ithaca-turn", text: "Past the Sirens, then" });
  s.ui.connection.flushChatDeltas();
  await expect.poll(() => s.ui.stores.chat.getState().buffers[ITHACA.id]?.isStreaming, { message: "a turn runs in view" }).toBe(true);
  await settle(s, 4);
  const before = sessionReads;
  s.socket.deliver({ type: "result", sessionId: ITHACA.id, turnId: "ithaca-turn", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
  await expect.poll(() => sessionReads, { message: "the list is read again" }).toBeGreaterThan(before);
});

// A focused row that moves keeps focus: a date row whose session becomes
// tracked is drawn again in Working, and focus goes with it.
test("1440: a focused date row that becomes a Working row keeps focus", async (ctx) => {
  pointer();
  const s = await mount(ctx, 1440, 720, "dark");
  const dateRow = () => pane(s)?.querySelector<HTMLElement>(`[data-session-row][data-session="${PENELOPE.id}"] [role="button"]`) ?? null;
  await expect.poll(() => dateRow(), { message: "listed in its date group" }).not.toBeNull();
  dateRow()!.focus();
  work.penelope(s);
  await expect.poll(() => workingRows(pane(s)).length, { message: "now in Working" }).toBe(1);
  expect(dateRow(), "not in its date group any more").toBeNull();
  expect(document.activeElement, "focus followed it").toBe(workingRows(pane(s))[0]);
  await userEvent.keyboard("{ArrowDown}");
  expect(pane(s)!.contains(document.activeElement), "the arrows still rove").toBe(true);
  expect(document.activeElement).not.toBe(workingRows(pane(s))[0]);
});

// Each root numbers its announcements from one: a replacement root under
// the same mounted Chat still speaks its first.
test("390: a replacement root's first announcement is spoken", async (ctx) => {
  pointer();
  await resize(390, 640);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:390px;height:640px";
  document.body.append(host);
  const a = createBrainUiRoot({ storage: null, request: fixtureRequest() });
  const b = createBrainUiRoot({ storage: null, request: fixtureRequest() });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); a.dispose(); b.dispose(); host.remove(); });
  const say = (r: BrainUiRoot) => {
    const frame = (msg: Record<string, unknown>) => r.connection.handleServerMessage(msg as never);
    frame({ type: "server_hello", protocolRev: 5, capabilities: {} });
    frame({ type: "status", sessionId: RAFT.id, status: "thinking", turnId: "raft-turn" });
    frame({ type: "tool_approval_request", sessionId: RAFT.id, turnId: "raft-turn", toolUseId: "tool-raft", toolName: "Write", input: { file_path: "voyage/raft-lashings.md" } });
  };
  // Root A announced before Chat mounted: that is not spoken again.
  say(a);
  expect(a.stores.trackers.getState().announcements, "root A announced").toHaveLength(1);
  flushSync(() => renderer.render(<BrainUiProvider root={a}><ChatPage /></BrainUiProvider>));
  const live = () => host.querySelector<HTMLElement>("[data-working-live]")!;
  expect(live().textContent, "made before the region mounted").toBe("");
  flushSync(() => renderer.render(<BrainUiProvider root={b}><ChatPage /></BrainUiProvider>));
  say(b);
  await expect.poll(() => live().textContent, { message: "root B's first is spoken" }).toContain("needs you");
});

// The 1280 boundary: the drawer becomes the pane, the strip goes, and back.
test("1279 ↔ 1280: an open Sessions drawer becomes the pane with focus in it, the strip gives way, and returns", async (ctx) => {
  const mode = pointer();
  const s = await mount(ctx, 1279, 720, "dark");
  work.timber(s);
  await expect.poll(() => stripItems(s).length, { message: "a pill below 1280" }).toBe(1);
  const sessionsTab = [...s.host.querySelectorAll<HTMLElement>('nav[aria-label="Primary"] [role="tab"]')][1]!;
  await press(s, sessionsTab, mode);
  await expect.poll(() => s.ui.stores.ui.getState().sessionPanelOpen, { message: "the drawer opens below 1280" }).toBe(true);
  await expect.poll(() => workingRows(s.host.querySelector("h2")?.closest(".fixed") ?? null).length, { message: "Working in the drawer" }).toBe(1);
  await expect.poll(() => !moving(), { interval: 16, message: "the drawer has settled" }).toBe(true);
  await resize(1280, 720);
  s.host.style.width = "1280px";
  await expect.poll(() => pane(s), { message: "the pane from 1280" }).not.toBeNull();
  expect(s.ui.stores.ui.getState().sessionPanelOpen, "the drawer closes").toBe(false);
  await expect.poll(() => pane(s)!.contains(document.activeElement), { message: "focus moves into the pane" }).toBe(true);
  expect(stripItems(s), "no pill from 1280").toHaveLength(0);
  expect(workingRows(pane(s))).toHaveLength(1);
  const amber = [...s.host.querySelectorAll<HTMLElement>('nav[aria-label="Primary"] [role="tab"]')].findIndex((t) => t.getAttribute("aria-selected") === "true");
  expect(amber, "Chat stays the destination").toBe(0);
  await resize(1279, 720);
  s.host.style.width = "1279px";
  await expect.poll(() => stripItems(s).length, { message: "the pill returns below 1280" }).toBe(1);
  expect(pane(s)).toBeNull();
});
