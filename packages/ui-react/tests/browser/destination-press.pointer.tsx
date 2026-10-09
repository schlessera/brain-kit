/**
 * Pressing the current destination (#1078, D52 N3 and its addendum).
 *
 * The real AppShell and the real ChatPage, ActivityPage and GraphPage render
 * in Chromium against a real client root, inside the kit's rail projects:
 * fine, coarse and mixed pointers, each in its own browser, all with reduced
 * motion. Only the transports are fixtures: a socket that never opens, and a
 * `request` that answers with Odysseus's data. No key, no network.
 *
 * Each cell scrolls a destination away from its start, presses it again by
 * pointer (a native mouse click or touch tap) or by its chord, and asserts
 * three things: every container it scrolled is back at its start (the
 * latest turn, for Chat), `document.activeElement` is the adopted target,
 * and nothing the press must not touch has moved: the view and panels, the
 * Settings section, the session in view, the run states and the trackers,
 * the open file and its tree, the selected run and the composer's draft.
 *
 * The targets are found by the semantics that existed before #1078 (roles,
 * names, `aria-selected`, the run detail's heading), so the cells load and
 * fail on their scroll or focus assertion on a tree without the behaviour.
 *
 * Every test owns its scene, as in `phone-navigation.pointer.tsx` (#1077):
 * a fresh mount per cell, fenced by the test's own abort signal.
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
import { activeChat } from "../../src/stores/chat-store.js";

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
const HOUR = 3_600_000;
const PLACES = ["Ismaros", "the Lotus-eaters", "the Cyclops", "Aeolus", "the Laestrygonians", "Aeaea", "the Sirens", "Scylla", "Thrinacia", "Ogygia"];
/** Enough sessions that the drawer's list scrolls; the third is the one in view. */
const SESSIONS = Array.from({ length: 30 }, (_, i) => ({
  id: `odysseus-${i}`,
  title: `Day ${i + 1}: provisions past ${PLACES[i % PLACES.length]}`,
  createdAt: T0 - i * HOUR,
  lastActiveAt: T0 - i * HOUR,
  totalCostUsd: 0,
  numTurns: 0,
}));
const CURRENT = SESSIONS[2]!;
const RUNNING = SESSIONS[20]!;
/** Recorded runs, so the Actions list scrolls; the third is the selected one. */
const RUNS = Array.from({ length: 30 }, (_, i) => ({
  runId: `run-${i}`, origin: "cron", name: `Tally the wine jars, watch ${i + 1}`, sessionId: null, jobName: null,
  startedAt: T0 - i * HOUR, endedAt: T0 - i * HOUR + 4000, outcome: "success", running: false, durationMs: 4000,
  costUsd: null, failureReason: null, detailPruned: false,
}));
const SELECTED_RUN = RUNS[2]!;
/** A run detail long enough to scroll on a phone. */
function runDetail(runId: string) {
  const root = { spanId: `${runId}-root`, runId, name: "Tally the wine jars", kind: "cron", origin: "cron", startedAt: T0, endedAt: T0 + 4000, outcome: "success" };
  const steps = Array.from({ length: 30 }, (_, i) => ({
    spanId: `${runId}-step-${i}`, runId, parentSpanId: root.spanId, name: "Read", toolName: "Read", kind: "tool", origin: "cron",
    startedAt: T0 + i * 100, endedAt: T0 + i * 100 + 50, outcome: "success", attrs: { file_path: `voyage/stores/jar-${i + 1}.md` },
  }));
  return { runId, detailPruned: false, spans: [root, ...steps], events: [], highWaterSeq: 1 };
}
/** A flat tree that scrolls, with the open file third. */
const FILES = Array.from({ length: 40 }, (_, i) => ({
  name: i === 2 ? "crew-roster.md" : `log-${String(i + 1).padStart(2, "0")}.md`,
  path: i === 2 ? "crew-roster.md" : `log-${String(i + 1).padStart(2, "0")}.md`,
  type: "file", size: 400, mtime: T0,
}));
const OPEN_FILE = "crew-roster.md";
const ROSTER = ["# Crew roster for Aeaea", "", ...Array.from({ length: 120 }, (_, i) => `- Oar ${i + 1}: a man of Ithaca, counted at dawn and again at dusk.`)].join("\n");
/** An HTML file, previewed in a sandboxed frame whose scroll the panel cannot reach. */
const HTML_FILE = "voyage-map.html";
const MAP = `<!doctype html><body>${Array.from({ length: 120 }, (_, i) => `<p>League ${i + 1} from Ithaca.</p>`).join("")}</body>`;

/** Every request the shell makes, answered offline. */
function fixtureRequest() {
  return async (url: string): Promise<Response> => {
    const parsed = new URL(url, "http://fixture.invalid");
    const path = parsed.pathname;
    if (path.endsWith("/sessions")) return Response.json({ sessions: SESSIONS });
    if (/\/sessions\/[^/]+/.test(path)) return Response.json({ messages: [] });
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: RUNS });
    const run = /\/activity\/runs\/([^/]+)$/.exec(path);
    if (run) return Response.json(runDetail(decodeURIComponent(run[1]!)));
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
    if (path.endsWith("/files/tree")) return Response.json({ path: "", entries: FILES });
    if (path.endsWith("/files/resolve")) return Response.json({ path: parsed.searchParams.get("path"), ancestors: [], exists: true, type: "file" });
    if (path.endsWith("/files/content") && parsed.searchParams.get("path") === HTML_FILE) {
      return Response.json({ path: HTML_FILE, kind: "html", size: MAP.length, mtime: T0, content: MAP });
    }
    if (path.endsWith("/files/content")) return Response.json({ path: OPEN_FILE, kind: "markdown", size: ROSTER.length, mtime: T0, content: ROSTER });
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

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; width: number; signal: AbortSignal };

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
  await commands.htmlPreviewFixture(null);
  await commands.rankTouch("touchCancel", []);
  document.documentElement.dataset.theme = "dark";
  history.replaceState(null, "", location.pathname + location.search);
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

/** The start states a cell can begin in. */
type Start =
  | "chat" | "chat-empty" | "chat-approval"
  | "sessions" | "sessions-working"
  | "actions" | "actions-selected"
  | "files" | "files-tree"
  | "settings";

const DRAFT = "Also list who stays aboard";

async function mount(ctx: TestContext, start: Start, width: number, height: number, theme: "dark" | "light"): Promise<Scene> {
  ctx.signal.throwIfAborted();
  vi.stubGlobal("WebSocket", FixtureSocket);
  if (sized !== `${width}x${height}`) {
    sized = undefined;
    await page.viewport(width, height);
    await commands.formViewport(width, height);
    sized = `${width}x${height}`;
  }
  ctx.signal.throwIfAborted();
  document.documentElement.dataset.theme = theme;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: fixtureRequest() });
  const renderer: Root = createRoot(host);
  const s: Scene = { ui, host, width, signal: ctx.signal };
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  ui.stores.ui.getState().setTheme(theme);
  ui.stores.connection.setState({ wsStatus: "connected" } as never);
  const chat = ui.stores.chat.getState();
  if (start !== "chat-empty") {
    for (let i = 0; i < 12; i++) {
      chat.addUserMessage(null, `Day ${i + 1} out of Troy: which supplies are still missing for the raft?`, "typed");
      chat.startAssistantMessage(null);
      chat.appendText(null, "Timber and rope are packed; Calypso still owes the sailcloth.");
      chat.finishAssistantMessage(null);
    }
  }
  if (start === "chat-approval") {
    chat.addUserMessage(null, "Write the lashings note to the Ogygia journal.", "typed");
    chat.startAssistantMessage(null);
    chat.requestToolApproval(null, "tool-ogygia", "Write", { file_path: "journeys/ogygia.md", content: "Raft lashings checked." });
  }
  if (start.startsWith("sessions")) chat.setActiveSession(CURRENT.id);
  // Work left running in another session: its tracker is the Working row (#950).
  if (start === "sessions-working") {
    chat.setRunState(RUNNING.id, "streaming");
    const trackers = ui.stores.trackers.getState();
    trackers.track(RUNNING.id);
    trackers.live(RUNNING.id, [{ kind: "running", turnId: "turn-aeaea", requestId: "request-aeaea", dispatch: true }]);
  }
  if (start === "actions-selected") history.replaceState(null, "", `#/activity/${SELECTED_RUN.runId}`);
  if (start.startsWith("files")) {
    await ui.stores.file.getState().openFile(OPEN_FILE);
    if (start === "files-tree") ui.stores.file.getState().setTreeExpanded(true);
  }
  const state = ui.stores.ui.getState();
  if (start.startsWith("sessions")) state.openPanel("sessions");
  if (start.startsWith("actions")) state.setActiveView("activity");
  if (start.startsWith("files")) state.openPanel("files");
  if (start === "settings") state.openPanel("settings");
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
  await document.fonts.ready;
  await settle(s, 6);
  ui.stores.connection.setState({ wsStatus: "connected" } as never);
  await settle(s);
  return s;
}

const PHONE_BAR = 'nav[aria-label="Primary"].tablet\\:hidden';
const RAIL = 'nav[aria-label="Primary"].tablet\\:flex';
const ui$ = (s: Scene) => s.ui.stores.ui.getState();
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const composer = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]") ?? s.host.querySelector<HTMLTextAreaElement>("textarea");

/** The panel drawn under heading `title`: the drawer or pane holding it. */
function panel(s: Scene, title: string): HTMLElement | null {
  const pane = s.host.querySelector<HTMLElement>(`section[aria-label="${title}"], [role="dialog"][aria-label="${title}"]`);
  if (pane) return pane;
  const heading = [...s.host.querySelectorAll<HTMLElement>("h2")].find((h) => textOf(h) === title && h.getClientRects().length > 0);
  return heading?.closest<HTMLElement>(".fixed") ?? null;
}

/** What a cell needs to know about its destination. */
interface Spec {
  /** Rail and phone index, and chord digit. */
  index: number;
  /** Where the destination's scroll containers live. */
  root: (s: Scene) => HTMLElement | null;
  /** Ready to be scrolled and pressed: its content has arrived. */
  ready: (s: Scene) => boolean;
  /** The adopted focus target for this start at this width. */
  target: (s: Scene, phone: boolean, wide: boolean) => HTMLElement | null;
}

const isPhone = (s: Scene) => s.width < 480;
const isWide = (s: Scene) => s.width >= 900;

const SPECS: Record<Start, Spec> = {
  chat: {
    index: 0,
    root: (s) => s.host.querySelector<HTMLElement>("[data-reading-column]")?.parentElement ?? null,
    ready: (s) => s.host.querySelector("[data-reading-column]") !== null && composer(s) !== null,
    target: (s, phone) => phone ? chatTab(s) : composer(s),
  },
  "chat-empty": {
    index: 0,
    root: () => null,
    ready: (s) => composer(s) !== null,
    target: (s, phone) => phone ? chatTab(s) : composer(s),
  },
  "chat-approval": {
    index: 0,
    root: (s) => s.host.querySelector<HTMLElement>("[data-reading-column]")?.parentElement ?? null,
    ready: (s) => s.host.querySelector('[data-approval-card] [data-kit-approval-actions] [role="button"]') !== null,
    // A waiting card wins at every width, the phone included.
    target: (s) => s.host.querySelector<HTMLElement>('[data-approval-card] [data-kit-approval-actions] [role="button"]'),
  },
  sessions: {
    index: 1,
    root: (s) => panel(s, "Sessions"),
    ready: (s) => sessionRow(s, CURRENT.title) !== null,
    target: (s) => sessionRow(s, CURRENT.title),
  },
  "sessions-working": {
    index: 1,
    root: (s) => panel(s, "Sessions"),
    ready: (s) => sessionRow(s, CURRENT.title) !== null && workingRow(s, RUNNING.title) !== null,
    // The first Working row (D52 N3). From 1280 Sessions is the pane, not the
    // current destination, and keeps the 1280 row: the selected row.
    target: (s) => s.width >= 1280 ? sessionRow(s, CURRENT.title) : workingRow(s, RUNNING.title),
  },
  actions: {
    index: 2,
    root: (s) => s.host.querySelector<HTMLElement>('[aria-label="Actions queue"]')?.parentElement ?? null,
    ready: (s) => runRow(s, RUNS[29]!.name) !== null,
    target: (s) => actionsHeading(s),
  },
  "actions-selected": {
    index: 2,
    root: (s) => s.host.querySelector<HTMLElement>('[aria-label="Actions queue"]')?.parentElement ?? null,
    ready: (s) => s.host.querySelector("[data-run-detail-heading]") !== null && textOf(s.host.querySelector("[data-run-detail-heading]")) !== SELECTED_RUN.runId
      && (!isWide(s) || runRow(s, SELECTED_RUN.name) !== null),
    // Below `laptop:` the detail stays open and its heading takes focus;
    // from it, the selected row in the list does.
    target: (s, _phone, wide) => wide ? runRow(s, SELECTED_RUN.name) : s.host.querySelector<HTMLElement>("[data-run-detail-heading]"),
  },
  files: {
    index: 3,
    root: (s) => panel(s, "Files"),
    ready: (s) => (panel(s, "Files")?.textContent ?? "").includes("Oar 120") && (!isWide(s) || treeRow(s) !== null),
    // Below `laptop:` the tree is hidden while a file is open, so the reading
    // pane's title takes focus; from it, the open file's tree row does.
    target: (s, _phone, wide) => wide ? treeRow(s) : fileTitle(s),
  },
  "files-tree": {
    index: 3,
    root: (s) => panel(s, "Files"),
    ready: (s) => (panel(s, "Files")?.textContent ?? "").includes("Oar 120") && treeRow(s) !== null,
    target: (s) => treeRow(s),
  },
  settings: {
    index: 4,
    root: (s) => panel(s, "Settings"),
    ready: (s) => settingsTab(s) !== null,
    target: (s) => settingsTab(s),
  },
};

function chatTab(s: Scene) {
  return s.host.querySelector<HTMLElement>(`${PHONE_BAR} [role="tab"]`);
}
function sessionRow(s: Scene, title: string) {
  const root = panel(s, "Sessions");
  return [...(root?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])].find((r) => textOf(r).startsWith(title)) ?? null;
}
function workingRow(s: Scene, title: string) {
  const root = panel(s, "Sessions");
  return [...(root?.querySelectorAll<HTMLElement>('[data-working-row] [role="button"]') ?? [])].find((r) => textOf(r).startsWith(title)) ?? null;
}
function runRow(s: Scene, name: string) {
  const list = s.host.querySelector<HTMLElement>('[aria-label="Actions queue"]');
  return [...(list?.querySelectorAll<HTMLElement>('[role="button"], button') ?? [])].find((r) => textOf(r).startsWith(name)) ?? null;
}
function actionsHeading(s: Scene) {
  return [...s.host.querySelectorAll<HTMLElement>('[aria-label="Actions queue"] h1')].find((h) => textOf(h) === "Actions") ?? null;
}
function treeRow(s: Scene) {
  return panel(s, "Files")?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ?? null;
}
function fileTitle(s: Scene) {
  return [...(panel(s, "Files")?.querySelectorAll<HTMLElement>(`[title="${OPEN_FILE}"]`) ?? [])].find((el) => textOf(el) === OPEN_FILE) ?? null;
}
function settingsTab(s: Scene) {
  return panel(s, "Settings")?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
}

/** Every element that scrolls vertically under `root`, `root` included. */
function scrollers(root: HTMLElement): HTMLElement[] {
  return [root, ...root.querySelectorAll<HTMLElement>("*")].filter((el) => {
    const y = getComputedStyle(el).overflowY;
    return (y === "auto" || y === "scroll") && el.scrollHeight - el.clientHeight > 1 && el.getClientRects().length > 0;
  });
}

/** What the press must leave as it found it. */
function untouched(s: Scene) {
  const u = ui$(s);
  const chat = s.ui.stores.chat.getState();
  const file = s.ui.stores.file.getState();
  return {
    view: u.activeView,
    panels: [u.sessionPanelOpen, u.filePanelOpen, u.settingsPanelOpen, u.searchPanelOpen, u.addPanelOpen, u.syncPanelOpen, u.whatsupPanelOpen],
    settingsTab: u.settingsTab,
    session: chat.activeSessionId,
    runStates: { ...chat.runStates },
    trackers: Object.keys(s.ui.stores.trackers.getState().records),
    messages: activeChat(chat).messages.length,
    file: file.currentPath,
    tree: file.treeExpanded,
    hash: location.hash,
    runDetail: textOf(s.host.querySelector("[data-run-detail-heading]")),
    draft: composer(s)?.value ?? null,
  };
}

/** Presses the destination at `index`: a native click or tap on its rail row or bar slot, or its chord. */
async function press(s: Scene, spec: Spec, how: "pointer" | "chord", mode: string) {
  if (how === "chord") {
    (document.activeElement as HTMLElement | null)?.blur();
    s.signal.throwIfAborted();
    await userEvent.keyboard(`{Meta>}${spec.index + 1}{/Meta}`);
    return;
  }
  const steps: Array<() => HTMLElement | null> = isPhone(s)
    ? spec.index === 4
      ? [() => [...s.host.querySelectorAll<HTMLElement>(`${PHONE_BAR} [role="tab"]`)][4] ?? null,
         () => [...s.host.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="More"] [role="button"]')].find((r) => textOf(r) === "Settings") ?? null]
      : [() => [...s.host.querySelectorAll<HTMLElement>(`${PHONE_BAR} [role="tab"]`)][spec.index] ?? null]
    : [() => [...s.host.querySelectorAll<HTMLElement>(`${RAIL} [role="tab"]`)][spec.index] ?? null];
  for (const find of steps) {
    let el: HTMLElement | null = null;
    await expect.poll(() => (el = find()) !== null && !moving(), { interval: 16, message: "the control is on screen and at rest" }).toBe(true);
    // A short viewport scrolls the rail; the control is brought into reach first.
    el!.scrollIntoView({ block: "nearest" });
    await settle(s, 1);
    const r = el!.getBoundingClientRect();
    const point = { x: r.left + Math.min(6, r.width / 4), y: r.top + r.height / 2 };
    expect(el!.contains(document.elementFromPoint(point.x, point.y)), "nothing covers the control").toBe(true);
    s.signal.throwIfAborted();
    if (mode === "fine") await commands.overlayMouse(point);
    else await commands.rankTap(point);
    await settle(s);
  }
}

const WIDTHS = [320, 480, 900, 1440] as const;
/** Short enough that every destination's containers scroll at every width. */
const HEIGHT = 420;
const STARTS = Object.keys(SPECS) as Start[];

for (const theme of ["dark", "light"] as const) for (const width of WIDTHS) for (const start of STARTS) {
  // The tree is hidden under an open file only below `laptop:`.
  if (start === "files-tree" && width >= 900) continue;
  // The phone has no chord; the rail widths are pressed both ways.
  for (const how of width < 480 ? ["pointer"] as const : ["pointer", "chord"] as const) {
    test(`D52 N3 at ${width} (${theme}): ${start} pressed again by ${how}`, async (ctx) => {
      const mode = pointer();
      // The Settings pane's sections are short at 1440, so its viewport is too.
      const s = await mount(ctx, start, width, start === "settings" && width >= 1440 ? 300 : HEIGHT, theme);
      const spec = SPECS[start];
      await expect.poll(() => spec.ready(s), { message: `${start} has its content` }).toBe(true);
      await expect.poll(() => moving(), { interval: 16, message: "entrances have settled" }).toBe(false);

      // Away from the start: Chat to its top, everything else to its end.
      const chat = start.startsWith("chat");
      const root = spec.root(s);
      const moved: HTMLElement[] = [];
      if (root) {
        for (const el of scrollers(root)) {
          el.scrollTop = chat ? 0 : el.scrollHeight;
          if (chat ? el.scrollHeight - el.clientHeight - el.scrollTop > 40 : el.scrollTop > 0) moved.push(el);
        }
        expect(moved.length, `${start} scrolled away from its start (premise)`).toBeGreaterThan(0);
      }
      if (composer(s) && start !== "chat-approval") await userEvent.fill(composer(s)!, DRAFT);
      (document.activeElement as HTMLElement | null)?.blur();
      await settle(s);
      const before = untouched(s);

      await press(s, spec, how, mode);
      await settle(s);

      const target = spec.target(s, isPhone(s), isWide(s));
      expect(target, `${start}: the adopted target is drawn`).not.toBeNull();
      if (start === "chat-approval") expect(target?.getAttribute("aria-label") ?? target?.textContent, "reselect selects the Allow decision").toMatch(/^Allow(?:$| )/);
      await expect.poll(() => document.activeElement, { message: `${start}: focus is on the adopted target` }).toBe(target);
      // After focus: revealing a wrong target scrolls its list, which would
      // otherwise fail here first and hide which target was taken.
      for (const el of moved) {
        if (chat) expect(el.scrollHeight - el.clientHeight - el.scrollTop, "Chat is at its latest turn").toBeLessThanOrEqual(2);
        else expect(el.scrollTop, `${start}: a scroll container is at its start`).toBe(0);
      }
      if (target instanceof HTMLTextAreaElement) {
        expect(target.selectionStart, "the caret is at the end of the draft").toBe(target.value.length);
      }
      // A keyboard press shows the ring on what it focused.
      if (how === "chord" && !(target instanceof HTMLTextAreaElement)) {
        expect(target!.matches(":focus-visible"), `${start}: focus is visible`).toBe(true);
        const ring = getComputedStyle(target!);
        expect(ring.outlineStyle, `${start}: a focus ring is drawn`).not.toBe("none");
      }
      expect(untouched(s), `${start}: nothing but scroll and focus changed`).toEqual(before);
    });
  }
}

// The HTML preview is sandboxed (scripts only, #1084): its document has an
// opaque origin, so neither the panel nor this test can read or set its
// scroll. What is observable is that the press loads the same source again,
// which shows the top of the file.
for (const width of [320, 900] as const) {
  test(`D52 N3 at ${width}: Files with an HTML preview loads it again at its top`, async (ctx) => {
    const mode = pointer();
    const painted: Array<{ path: string; paragraphs: number; first: string; last: string; top: number }> = [];
    let frame: HTMLIFrameElement | null = null;
    const observe = (event: MessageEvent) => {
      if (event.source === (frame ?? document.querySelector<HTMLIFrameElement>('iframe[title="HTML preview"]'))?.contentWindow && event.data?.type === "preview-position") painted.push(event.data);
    };
    window.addEventListener("message", observe);
    ctx.onTestFinished(() => window.removeEventListener("message", observe));
    // The sandboxed document reports its own painted content and scroll;
    // parent access to its opaque-origin DOM remains forbidden.
    await commands.htmlPreviewFixture(HTML_FILE, `${MAP}<script>
      const report = () => parent.postMessage({type: 'preview-position', path: new URL(location.href).searchParams.get('path'), paragraphs: document.querySelectorAll('p').length, first: document.querySelector('p').textContent, last: document.querySelector('p:last-of-type').textContent, top: scrollY}, '*');
      addEventListener('load', report);
      addEventListener('message', event => {
        if (event.source === parent && event.data === 'scroll-preview-to-end') {
          scrollTo(0, document.documentElement.scrollHeight);
          requestAnimationFrame(report);
        }
      });
    </script>`);
    const s = await mount(ctx, "files", width, HEIGHT, "dark");
    await s.ui.stores.file.getState().openFile(HTML_FILE);
    await expect.poll(() => (frame = panel(s, "Files")?.querySelector<HTMLIFrameElement>('iframe[title="HTML preview"]') ?? null) !== null,
      { message: "the HTML preview is drawn" }).toBe(true);
    await expect.poll(() => moving(), { interval: 16, message: "entrances have settled" }).toBe(false);
    const src = frame!.getAttribute("src");
    expect(src, "the preview loads the sandboxed route").toContain("/files/html?path=");
    expect(new URL(src!, location.href).searchParams.get("path"), "the preview requests the selected file").toBe("voyage-map.html");
    await expect.poll(() => painted.length, { message: "the native preview document loaded" }).toBeGreaterThan(0);
    expect(painted.at(-1)).toMatchObject({ path: "voyage-map.html", paragraphs: 120, first: "League 1 from Ithaca.", last: "League 120 from Ithaca.", top: 0 });
    frame!.contentWindow!.postMessage("scroll-preview-to-end", "*");
    await expect.poll(() => painted.at(-1)?.top ?? 0, { message: "the preview really scrolled away from its top" }).toBeGreaterThan(100);
    const documentsBefore = painted.length;
    let loads = 0;
    frame!.addEventListener("load", () => { loads++; });
    await settle(s, 6);
    const before = loads;
    await press(s, SPECS.files, "pointer", mode);
    await expect.poll(() => loads, { message: "the press loads the preview again" }).toBeGreaterThan(before);
    await expect.poll(() => painted.length, { message: "the reloaded native document reports" }).toBeGreaterThan(documentsBefore);
    expect(painted.at(-1)).toMatchObject({ path: "voyage-map.html", paragraphs: 120, first: "League 1 from Ithaca.", last: "League 120 from Ithaca.", top: 0 });
    expect(s.ui.stores.file.getState().currentPath, "the file stays open").toBe(HTML_FILE);
    expect(panel(s, "Files")?.querySelector('iframe[title="HTML preview"]'), "the same frame, not a remount").toBe(frame);
    // Reloaded from the same route: an empty srcdoc would win over src and blank the file.
    expect(frame!.getAttribute("srcdoc"), "no srcdoc replaces the file").toBeNull();
    expect(frame!.getAttribute("src"), "the same file again").toBe(src);
  });
}

// A chord still reaches a destination behind a modal, but focus stays in the
// modal: the one-time credential dialog over Settings, and over Chat, where
// the composer would otherwise take it.
for (const width of [480, 900, 1440] as const) for (const start of ["settings", "chat"] as const) {
  test(`D52 N3 at ${width}: ${start} pressed by chord under a modal keeps focus in it`, async (ctx) => {
    pointer();
    const s = await mount(ctx, start, width, HEIGHT, "dark");
    await expect.poll(() => SPECS[start].ready(s), { message: `${start} has its content` }).toBe(true);
    s.ui.stores.principal.setState({ oneTimeCredential: { id: "agent-eumaeus", label: "Eumaeus's swineherd hut", expiresAt: T0 + 30 * 86_400_000, cookie: "fixture-cookie" } });
    let modal: HTMLElement | null = null;
    await expect.poll(() => (modal = document.querySelector<HTMLElement>('[aria-modal="true"]')) !== null, { message: "the modal is open" }).toBe(true);
    await expect.poll(() => moving(), { interval: 16, message: "entrances have settled" }).toBe(false);
    const inside = modal!.querySelector<HTMLElement>("button, [role='button'], [tabindex='0']")!;
    inside.focus();
    expect(document.activeElement, "focus starts in the modal").toBe(inside);
    s.signal.throwIfAborted();
    await userEvent.keyboard(`{Meta>}${SPECS[start].index + 1}{/Meta}`);
    await settle(s);
    expect(modal!.contains(document.activeElement), `${start}: focus stays in the modal`).toBe(true);
  });
}
