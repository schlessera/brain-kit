/// <reference types="@vitest/browser-playwright" />
/**
 * The desktop's destinations, acts and All commands in the real app shell
 * (#946, D52 §1), in Chromium under a fine, a coarse and a mixed pointer —
 * the kit's `rail-*` projects, which launch a browser per pointer scene, so
 * the media queries are real rather than mocked.
 *
 * The real `AppShell` renders against a real client root with fixture
 * transports: no backend, credentials or external resources. Presses are real
 * mouse input or native touch at a target's inset corner, never a forced
 * click.
 */
import { afterEach, beforeEach, expect, inject, test, vi } from "vitest";
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
import type { DestinationPanel } from "../../src/stores/ui-state.js";

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

/** The real pages, for tests that assert a panel is drawn: Chat, Graph and
 * Actions each mount their own panels, so a placeholder child cannot. */
function Pages() {
  const view = useUIStore((s) => s.activeView);
  return view === "activity" ? <ActivityPage /> : view === "graph" ? <GraphPage /> : <ChatPage />;
}

/** The pages' requests, answered offline with Odysseus's data. */
async function request(url: string): Promise<Response> {
  const path = new URL(url, "http://fixture.invalid").pathname;
  if (path.endsWith("/sessions")) return Response.json({ sessions: [] });
  if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
  if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
  return new Response("{}", { status: 404 });
}

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let style: HTMLStyleElement | undefined;
const originalTheme = document.documentElement.dataset.theme;

beforeEach(() => {
  vi.stubGlobal("WebSocket", FixtureSocket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [],
  })));
});

afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  renderer = undefined;
  ui = undefined;
  host = undefined;
  style = undefined;
  vi.unstubAllGlobals();
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});

function pointerScene() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  return mode;
}

async function mount(width: number, height: number, theme: "dark" | "light", connected = false, pages = false) {
  await page.viewport(width, height);
  await commands.formViewport(width, height);
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  document.body.append(host);
  ui = createBrainUiRoot(pages ? { storage: null, request } : { storage: null });
  ui.stores.ui.setState({ theme });
  if (connected) ui.stores.connection.setState({ wsStatus: "connected" } as never);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(
    <BrainUiProvider root={ui}>
      <AppShell>{pages ? <Pages /> : <div>Odysseus’s voyage</div>}</AppShell>
    </BrainUiProvider>,
  ));
  await document.fonts.ready;
  expect(document.documentElement.dataset.theme, "theme applied").toBe(theme);
  const rail = host.querySelector<HTMLElement>('nav[aria-label="Primary"].tablet\\:flex')!;
  return { rail, ui };
}

function parts(rail: HTMLElement) {
  const tabs = [...rail.querySelectorAll<HTMLElement>('[role="tab"]')];
  const toolbar = rail.querySelector<HTMLElement>('[role="toolbar"][aria-label="Acts"]');
  const acts = toolbar ? [...toolbar.querySelectorAll<HTMLElement>("button")] : [];
  const all = rail.querySelector<HTMLElement>('button[aria-keyshortcuts="Meta+K"]');
  return { tabs, acts, all };
}

/** A real mouse press, or a real touch at the target's inset corner. The mouse
 * goes through hover plus a raw down/up, because Playwright's `click` refuses
 * an `aria-disabled` target and a forced click would prove nothing. */
async function press(el: HTMLElement, mode: string) {
  if (mode === "fine") {
    await userEvent.hover(el);
    await commands.buttonPointer("down");
    await commands.buttonPointer("up");
    return;
  }
  const r = el.getBoundingClientRect();
  await commands.rankTouch("touchStart", [{ x: r.left + 0.5, y: r.bottom - 0.5 }]);
  await commands.rankTouch("touchEnd", []);
}

function reach(els: HTMLElement[], coarse: boolean) {
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const name = el.getAttribute("aria-label") ?? el.textContent;
    // Dimensions first, so a density mutation fails here and not on a hit test.
    if (coarse) {
      expect(r.height, `44px target height: ${name}`).toBeGreaterThanOrEqual(44);
      expect(r.width, `44px target width: ${name}`).toBeGreaterThanOrEqual(44);
      for (const x of [r.left + 0.5, r.right - 0.5]) for (const y of [r.top + 0.5, r.bottom - 0.5]) {
        expect(document.elementFromPoint(x, y)?.closest('button, [role="tab"]'), `corner hit: ${name} at ${x},${y}`).toBe(el);
      }
    } else {
      expect(r.height, `fine target height: ${name}`).toBeGreaterThanOrEqual(36);
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      expect(document.elementFromPoint(x, y)?.closest('button, [role="tab"]'), `centre hit: ${name} at ${x},${y}`).toBe(el);
    }
  }
}

const DESTINATIONS = ["Chat", "Sessions", "Actions", "Files", "Settings"];

/** The panel destinations: name, chord digit and store flag. */
const PANELS = [
  ["Sessions", 2, "sessionPanelOpen"],
  ["Files", 4, "filePanelOpen"],
  ["Settings", 5, "settingsPanelOpen"],
] as const;

/**
 * Whether a panel titled `title` is drawn: some box named for it (a pane's
 * `aria-label`, or a drawer's heading) lies inside the viewport and is what a
 * press at its upper middle would hit. A store flag set behind a view that
 * does not mount the panel draws nothing, so this is false for it (#1074).
 */
function shown(title: string) {
  const named = [...host!.querySelectorAll<HTMLElement>(`section[aria-label="${title}"], [role="dialog"][aria-label="${title}"]`)];
  const drawers = [...host!.querySelectorAll<HTMLElement>("h2")]
    .filter((h) => h.textContent === title)
    .map((h) => h.parentElement!.parentElement!);
  return [...named, ...drawers].some((box) => {
    const r = box.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.left < -0.5 || r.right > innerWidth + 0.5) return false;
    const hit = document.elementFromPoint((r.left + r.right) / 2, r.top + Math.min(r.height / 2, 32));
    return hit !== null && box.contains(hit);
  });
}

/** Whether a real press at the tab's centre would land on it, rather than on
 * a panel or backdrop drawn over the rail. */
function reachable(tab: HTMLElement) {
  const r = tab.getBoundingClientRect();
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[role="tab"]') === tab;
}

/** Whether destination `name` is what the screen shows: a panel's drawer or
 * pane, or a view with no panel over it whose own surface takes a press. */
function drawn(name: string) {
  if (PANELS.some(([t]) => t === name)) return shown(name);
  if (PANELS.some(([t]) => shown(t))) return false;
  const surface = host!.querySelector<HTMLElement>(name === "Chat" ? "textarea" : '[aria-label="Actions queue"]');
  if (!surface) return false;
  const r = surface.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return surface.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 16)));
}

/** Waits out every running entrance or exit, so a press cannot land on a
 * drawer still sliding in (#992). */
async function settled() {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [320, 390]) {
    test(`no rail and no palette below 480: ${theme}, ${width}`, async () => {
      pointerScene();
      const { rail, ui } = await mount(width, 640, theme);
      expect(getComputedStyle(rail).display, "rail hidden on a phone").toBe("none");
      ui.stores.ui.getState().setPaletteOpen(true);
      await expect.poll(() => host!.querySelector('[role="dialog"][aria-label="Command palette"]')).not.toBeNull();
      const scrim = host!.querySelector('[role="dialog"]')!.closest(".fixed")!;
      expect(getComputedStyle(scrim).display, "palette is a desktop surface").toBe("none");
    });
  }

  test(`a short viewport keeps All commands pinned and operable: ${theme}`, async () => {
    const mode = pointerScene();
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches, "reduced motion premise").toBe(true);
    const { rail } = await mount(900, 360, theme);
    const { acts, all } = parts(rail);
    const a = all!.getBoundingClientRect();
    expect(a.bottom, "All commands inside the viewport").toBeLessThanOrEqual(innerHeight);
    expect(document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)?.closest("button")).toBe(all);
    // The middle scrolls to the last act rather than pushing the footer out.
    acts[0]!.focus();
    await userEvent.keyboard("{End}");
    const last = acts[acts.length - 1]!;
    expect(document.activeElement).toBe(last);
    expect(last.getBoundingClientRect().bottom, "the last act is scrolled into view").toBeLessThanOrEqual(a.top);
    await press(all!, mode);
    await expect.poll(() => host!.querySelector('[role="dialog"][aria-label="Command palette"]'), { message: "opens when short" }).not.toBeNull();
  });

  for (const width of [480, 900, 1280, 1440]) {
    const expanded = width >= 900;
    test(`rail destinations, acts and All commands: ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const coarse = mode !== "fine";
      const { rail } = await mount(width, 720, theme);
      expect(getComputedStyle(rail).display).toBe("flex");
      const { tabs, acts, all } = parts(rail);
      // Names first: D52's five, in rail order.
      expect(tabs.map((t) => t.getAttribute("aria-label") ?? t.textContent!.replace(/⌘\d$/, ""))).toEqual(DESTINATIONS);
      // Printed chords follow the pointer (D36 addendum); collapsed prints none.
      for (let i = 0; i < tabs.length; i++) {
        if (expanded && mode !== "coarse") expect(tabs[i]!.textContent, `printed chord: ${DESTINATIONS[i]}`).toBe(`${DESTINATIONS[i]}⌘${i + 1}`);
        else expect(tabs[i]!.textContent).not.toMatch(/⌘/);
      }
      // Disconnected: expanded, the briefing prints its cost and its reason at
      // rest; collapsed, it is not drawn and All commands reaches it.
      expect(acts.map((a) => a.getAttribute("aria-label"))).toEqual(expanded
        ? ["Search the brain", "Add a note", "Daily briefing, spends, unavailable: needs the host"]
        : ["Search the brain", "Add a note"]);
      if (expanded) {
        expect(acts[2]!.getAttribute("aria-disabled")).toBe("true");
        expect(acts[2]!.textContent).toBe("Daily briefingspendsneeds the host");
      }
      expect(all, "All commands").not.toBeNull();
      expect(all!.textContent, "⌘K printed on every pointer").toContain("⌘K");
      if (!expanded) expect(all!.getAttribute("aria-label")).toBe("All commands");
      else expect(all!.textContent!.replace("⌘K", "")).toBe("All commands");
      reach([...tabs, ...acts, all!], coarse);
      expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(innerWidth);

      // Three stops: the destinations, the acts, All commands. Then out.
      (document.activeElement as HTMLElement | null)?.blur();
      await userEvent.tab();
      expect(document.activeElement, "stop 1: the amber destination").toBe(tabs[0]);
      await userEvent.tab();
      expect(document.activeElement, "stop 2: the acts").toBe(acts[0]);
      await userEvent.tab();
      expect(document.activeElement, "stop 3: All commands").toBe(all);
      await userEvent.tab();
      expect(rail.contains(document.activeElement), "the fourth Tab leaves the rail").toBe(false);
      if (width === 900 && mode === "mixed") await page.screenshot({ element: rail, path: `../../../../.vitest-attachments/desktop-navigation/${theme}-${width}.png` });
    });

    test(`All commands by pointer and keyboard opens the palette, focus returns: ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const { rail, ui } = await mount(width, 720, theme);
      const { all } = parts(rail);
      const dialog = () => host!.querySelector<HTMLElement>('[role="dialog"][aria-label="Command palette"]');

      await press(all!, mode);
      await expect.poll(dialog, { message: "pointer opens the palette" }).not.toBeNull();
      const input = dialog()!.querySelector("input")!;
      await expect.poll(() => document.activeElement, { message: "focus enters the query" }).toBe(input);
      const names = [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent!.replace("⏎", ""));
      const fine = mode !== "coarse";
      expect(names.slice(0, 7), "Jump to, remapped, with Graph keyless").toEqual([
        ...DESTINATIONS.map((d, i) => (fine ? `${d}⌘${i + 1}` : d)), "Graph", "New chat",
      ]);
      expect(names.filter((n) => n.startsWith("Sessions")), "Sessions once").toHaveLength(1);
      await userEvent.keyboard("{Escape}");
      expect(dialog(), "esc closes").toBeNull();
      expect(document.activeElement, "esc returns focus to All commands").toBe(all);

      // Enter and space on the focused button, and the existing modifier-K.
      await userEvent.keyboard("{Enter}");
      await expect.poll(dialog, { message: "Enter opens" }).not.toBeNull();
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(all);
      await userEvent.keyboard(" ");
      await expect.poll(dialog, { message: "space opens" }).not.toBeNull();
      await userEvent.keyboard("{Escape}");
      // A real press on the scrim, outside the box, is a dismissal too, and
      // the browser's own mousedown focus must not undo the return.
      await userEvent.keyboard("{Enter}");
      await expect.poll(dialog, { message: "reopens" }).not.toBeNull();
      const scrim = dialog()!.closest<HTMLElement>(".fixed")!;
      const corner = { x: 12, y: innerHeight - 12 };
      expect(document.elementFromPoint(corner.x, corner.y), "the corner is the scrim").toBe(scrim);
      if (mode === "fine") {
        await userEvent.hover(scrim, { position: corner });
        await commands.buttonPointer("down");
        await commands.buttonPointer("up");
      } else {
        await commands.rankTouch("touchStart", [corner]);
        await commands.rankTouch("touchEnd", []);
      }
      await expect.poll(dialog, { message: "the scrim dismisses" }).toBeNull();
      expect(document.activeElement, "the scrim returns focus to All commands").toBe(all);
      await userEvent.keyboard("{Control>}k{/Control}");
      await expect.poll(dialog, { message: "Ctrl+K opens" }).not.toBeNull();
      // A Graph row, reached through the visibly opened palette.
      await userEvent.keyboard("gra{Enter}");
      expect(dialog()).toBeNull();
      expect(ui.stores.ui.getState().activeView, "Graph runs from the palette").toBe("graph");
    });

    test(`⌘1–⌘5 reach D52's destinations, and Graph has no chord: ${theme}, ${width}`, async () => {
      pointerScene();
      const { rail, ui } = await mount(width, 720, theme);
      const state = () => ui.stores.ui.getState();
      const amber = () => parts(rail).tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
      document.body.focus();
      await userEvent.keyboard("{Meta>}3{/Meta}");
      expect(state().activeView, "⌘3 is Actions").toBe("activity");
      expect(amber()).toBe(2);
      await userEvent.keyboard("{Meta>}2{/Meta}");
      expect(state().activeView, "⌘2 lands in Chat").toBe("chat");
      expect(state().sessionPanelOpen, "⌘2 is Sessions").toBe(true);
      expect(amber()).toBe(1);
      await userEvent.keyboard("{Control>}4{/Control}");
      expect(state().filePanelOpen, "⌘4 is Files").toBe(true);
      expect(amber()).toBe(3);
      await userEvent.keyboard("{Meta>}5{/Meta}");
      expect(state().settingsPanelOpen, "⌘5 is Settings").toBe(true);
      await userEvent.keyboard("{Meta>}1{/Meta}");
      expect(state().activeView).toBe("chat");
      expect(amber()).toBe(0);
      expect(state().activeView === "graph", "no chord reaches Graph").toBe(false);
    });

    test(`the panel destination you are on never closes, by chord or rail (D52 N3): ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const { rail, ui } = await mount(width, 720, theme, false, true);
      const state = () => ui.stores.ui.getState() as unknown as Record<string, unknown>;
      let railPresses = 0;
      for (const [title, n, flag] of PANELS) {
        document.body.focus();
        await userEvent.keyboard(`{Meta>}${n}{/Meta}`);
        await expect.poll(() => shown(title), { message: `⌘${n} draws ${title}` }).toBe(true);
        // The same chord again, on the panel already open.
        await userEvent.keyboard(`{Meta>}${n}{/Meta}`);
        expect(state()[flag], `⌘${n} again: ${title} stays open`).toBe(true);
        await expect.poll(() => shown(title), { message: `⌘${n} again: ${title} still drawn` }).toBe(true);
        // The rail row. Every panel, drawer or pane, stops beside the rail
        // (#1075), so it is pressable at every rail width.
        await settled();
        const tab = parts(rail).tabs[n - 1]!;
        expect(reachable(tab), `rail ${title} beside its panel`).toBe(true);
        railPresses++;
        await press(tab, mode);
        expect(state()[flag], `rail ${title} again: ${title} stays open`).toBe(true);
        await expect.poll(() => shown(title), { message: `rail ${title} again: still drawn` }).toBe(true);
        expect(tab.getAttribute("aria-selected"), `rail ${title} stays amber`).toBe("true");
      }
      expect(railPresses, "rail presses exercised").toBe(PANELS.length);
    });

    for (const [title] of PANELS) {
      test(`with ${title} open, every destination is one rail press (D52 §2, #1075): ${theme}, ${width}`, async () => {
        const mode = pointerScene();
        const { rail, ui } = await mount(width, 720, theme, false, true);
        for (const [i, target] of DESTINATIONS.entries()) {
          ui.stores.ui.getState().setActiveView("chat");
          ui.stores.ui.getState().openPanel(title.toLowerCase() as DestinationPanel);
          await expect.poll(() => shown(title), { message: `${title} drawn before ${target}` }).toBe(true);
          await settled();
          // Every rail tab, not only the target: a backdrop or drawer over
          // the rail fails here, before any press is spent.
          reach(parts(rail).tabs, mode !== "fine");
          await press(parts(rail).tabs[i]!, mode);
          await expect.poll(() => drawn(target), { message: `${target} drawn after one press with ${title} open` }).toBe(true);
          expect(parts(rail).tabs[i]!.getAttribute("aria-selected"), `${target} is amber`).toBe("true");
        }
      });
    }

    for (const start of ["activity", "graph"] as const) for (const [title, n, flag] of PANELS) {
      test(`one rail ${title} activation from ${start} draws it (D52 N1): ${theme}, ${width}`, async () => {
        const mode = pointerScene();
        const { rail, ui } = await mount(width, 720, theme, false, true);
        ui.stores.ui.getState().setActiveView(start);
        await expect.poll(() => PANELS.some(([t]) => shown(t)), { message: `${start} starts with no panel` }).toBe(false);
        const tab = parts(rail).tabs[n - 1]!;
        expect(reachable(tab), `rail ${title} reachable from ${start}`).toBe(true);
        await press(tab, mode);
        expect((ui.stores.ui.getState() as unknown as Record<string, unknown>)[flag], `${title} flag from ${start}`).toBe(true);
        await expect.poll(() => shown(title), { message: `${title} visible from ${start}` }).toBe(true);
        expect(parts(rail).tabs[n - 1]!.getAttribute("aria-selected"), `${title} is amber`).toBe("true");
      });
    }

    test(`acts run the palette's handlers, mid-turn too, and the briefing says why: ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const { rail, ui } = await mount(width, 720, theme, true);
      ui.stores.ui.getState().setActiveView("activity");
      ui.stores.chat.getState().startAssistantMessage(null);
      await expect.poll(() => parts(rail).acts[0]?.getAttribute("aria-label")).toBe("Search the brain");
      const { acts } = parts(rail);
      if (expanded) {
        expect(acts[2]!.getAttribute("aria-label")).toBe("Daily briefing, spends, unavailable: a turn is running");
        await press(acts[2]!, mode);
        expect(ui.stores.ui.getState().whatsupPanelOpen, "a disabled briefing runs nothing").toBe(false);
        expect(ui.stores.ui.getState().activeView).toBe("activity");
      }
      // Search is REST: a running turn does not stop it, and it lands in Chat.
      await press(acts[0]!, mode);
      await expect.poll(() => ui.stores.ui.getState().searchPanelOpen, { message: "Search opens mid-turn" }).toBe(true);
      expect(ui.stores.ui.getState().activeView).toBe("chat");
      ui.stores.ui.getState().setActiveView("activity");
      await press(parts(rail).acts[1]!, mode);
      await expect.poll(() => ui.stores.ui.getState().addPanelOpen, { message: "Add opens mid-turn" }).toBe(true);
      ui.stores.chat.getState().finishAssistantMessage(null);
      if (expanded) {
        await expect.poll(() => parts(rail).acts[2]!.getAttribute("aria-label")).toBe("Daily briefing, spends");
        await press(parts(rail).acts[2]!, mode);
        await expect.poll(() => ui.stores.ui.getState().whatsupPanelOpen, { message: "a quiet host runs the briefing" }).toBe(true);
      }
    });
  }
}
