/// <reference types="@vitest/browser-playwright" />
/**
 * The working-session strip and the shared row above the composer (D52 §3–4,
 * #949), measured in real Chromium. It runs in the three `rail-*` projects, so
 * every case is checked with a fine, a coarse and a mixed pointer, all under
 * reduced motion; the pointer premise is asserted, never mocked.
 *
 * The scene is the app's arrangement: a message area holding the scroll disc
 * at `bottom: 16px`, then the row, then a composer, inside the column a rail
 * leaves at that width. The kit cannot know the width rules of the app that
 * places it, so the 1280 and 1440 cases measure the strip the kit would draw
 * there; the app (#950) passes no left half at those widths.
 */
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { WORKING_NOW, longWorkingSession, ogygiaClock, workingSessions, type WorkingFixture } from "../../fixtures/sessions.js";
import { ComposerRow } from "../../src/chrome/ComposerRow.js";
import { SessionStrip, type WorkingSession } from "../../src/chrome/SessionStrip.js";
import { ListRow } from "../../src/rows/ListRow.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});

function pointerScene() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(pointer: fine)").matches, "primary pointer premise").toBe(mode !== "coarse");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches, "reduced motion premise").toBe(true);
  return mode;
}

/** The column the composer gets at a width: the collapsed rail is 60px, the expanded one 208px. */
const railAt = (width: number) => (width >= 900 ? 208 : width >= 480 ? 60 : 0);

interface Mounted {
  opens: ReturnType<typeof vi.fn>[];
  row: HTMLElement;
  left: HTMLElement;
  right: HTMLElement;
  disc: HTMLElement;
  composer: HTMLTextAreaElement;
  before: HTMLButtonElement;
  render: (sessions: WorkingFixture[], keyboardOpen?: boolean) => void;
}

async function mount(opts: { width: number; height?: number; theme: string; sessions: WorkingFixture[]; pending?: number; keyboardOpen?: boolean }): Promise<Mounted> {
  const height = opts.height ?? 700;
  await page.viewport(opts.width, height);
  await commands.formViewport(opts.width, height);
  document.documentElement.dataset.theme = opts.theme;
  host = document.createElement("div");
  host.style.cssText = `display:flex;width:${opts.width}px;height:${height}px;background:var(--bk-color-canvas)`;
  document.body.append(host);
  const opens: ReturnType<typeof vi.fn>[] = [];
  const pending = opts.pending ?? 0;
  root = createRoot(host);
  const draw = (sessions: WorkingFixture[], keyboardOpen?: boolean) => {
    opens.length = 0;
    const live: WorkingSession[] = sessions.map((s) => {
      const onOpen = vi.fn();
      opens.push(onOpen);
      return { ...s, onOpen };
    });
    flushSync(() => root!.render(
      <>
        <nav style={{ width: railAt(opts.width), flex: "none" }} />
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div data-message-area="" style={{ position: "relative", flex: 1, minHeight: 0 }}>
            <button type="button" data-before="">Odysseus’s last answer</button>
            <button type="button" data-disc="" aria-label="Scroll to latest" style={{ position: "absolute", bottom: 16, left: "50%", width: 44, height: 44, marginLeft: -22 }} />
          </div>
          <div style={{ padding: "0 12px" }}>
            <ComposerRow
              left={<SessionStrip sessions={live} now={WORKING_NOW} formatClock={ogygiaClock} keyboardOpen={keyboardOpen} />}
              right={pending ? (
                <div role="group" aria-label="Pending follow-ups" className="bk-pill-group">
                  {Array.from({ length: Math.min(pending, keyboardOpen ? 1 : 2) }, (_, i) => (
                    <ListRow key={i} density="pill" icon="later" title={`Follow-up ${i + 1} about the raft`} value="pending" onClick={() => {}} />
                  ))}
                </div>
              ) : null}
            />
          </div>
          <textarea data-composer="" aria-label="Message" defaultValue="Can you also check the April receipts" style={{ height: 56, margin: "8px 12px 12px", boxSizing: "border-box" }} />
        </main>
      </>,
    ));
  };
  draw(opts.sessions, opts.keyboardOpen);
  await document.fonts.ready;
  const q = <T extends HTMLElement>(sel: string) => host!.querySelector<T>(sel)!;
  return {
    opens,
    get row() { return q("[data-composer-row]"); },
    get left() { return q('[data-row-half="left"]'); },
    get right() { return q('[data-row-half="right"]'); },
    get disc() { return q("[data-disc]"); },
    get composer() { return q<HTMLTextAreaElement>("[data-composer]"); },
    get before() { return q<HTMLButtonElement>("[data-before]"); },
    render: draw,
  };
}

const ITEMS = '[data-session-strip] [data-pill][role="button"], [data-strip-summary]';
const items = () => [...host!.querySelectorAll<HTMLElement>(ITEMS)];
const rect = (el: Element) => el.getBoundingClientRect();
const sheet = () => document.body.querySelector<HTMLElement>("[data-working-sheet]");

/** Five sessions of mixed urgency, arriving least urgent first. */
const five = [workingSessions[7]!, workingSessions[3]!, workingSessions[0]!, workingSessions[5]!, longWorkingSession];

function geometry(m: Mounted, n: number, keyboardOpen: boolean, pending: number) {
  expect([innerWidth, innerHeight, rect(host!).bottom], "viewport premise").toEqual([innerWidth, rect(host!).bottom, rect(host!).bottom]);
  const row = rect(m.row);
  if (n === 0 && pending === 0) {
    expect(row.height, "an empty row is absent").toBe(0);
    return;
  }
  const left = rect(m.left);
  const right = rect(m.right);
  // Size assertions first, so a target mutation fails on the size it broke.
  for (const el of items()) {
    const r = rect(el);
    expect(r.height, "44px pill target").toBe(44);
    expect(r.width, "pill width").toBeGreaterThanOrEqual(44);
  }
  expect(row.height, "row cap").toBeLessThanOrEqual(keyboardOpen ? 44 : 94);
  expect(right.left - left.right, "gutter").toBeGreaterThanOrEqual(8);
  expect(Math.abs(left.width - right.width), "equal halves").toBeLessThanOrEqual(1);
  expect(row.width, "720px measure").toBeLessThanOrEqual(720);
  for (const el of m.left.querySelectorAll("*")) {
    const r = rect(el);
    if (!r.width) continue;
    expect(r.left, "left content stays in its column").toBeGreaterThanOrEqual(left.left - 0.5);
    expect(r.right, "left content never crosses the gutter").toBeLessThanOrEqual(left.right + 0.5);
  }
  expect(row.top - rect(m.disc).bottom, "scroll disc at least 16px above the row").toBeGreaterThanOrEqual(16);
  if (n === 0) {
    expect(m.left.childElementCount, "an empty half paints nothing").toBe(0);
    return;
  }
  expect(items(), "drawn items").toHaveLength(keyboardOpen ? 1 : Math.min(n, 2));
  if (!keyboardOpen && n >= 3) expect(items()[1]!.dataset.stripSummary, "the second item is the summary").toBe("overflow");
  if (!keyboardOpen && n === 2) expect(rect(items()[1]!).top - rect(items()[0]!).bottom, "6px apart").toBe(6);
  const twoLine = left.width < 240;
  for (const pill of m.left.querySelectorAll<HTMLElement>("[data-pill]")) {
    const title = pill.querySelector<HTMLElement>("[data-pill-title]")!;
    const value = pill.querySelector<HTMLElement>("[data-pill-value]")!;
    expect(value.scrollWidth, "the state word never truncates").toBeLessThanOrEqual(value.clientWidth);
    expect(rect(value).right, "the state word stays inside the pill").toBeLessThanOrEqual(rect(pill).right);
    if (twoLine) expect(rect(value).top, "two lines under 240px").toBeGreaterThanOrEqual(rect(title).bottom - 0.5);
    else expect(Math.abs(rect(value).top + rect(value).height / 2 - (rect(title).top + rect(title).height / 2)), "one line at 240px or wider").toBeLessThan(2);
  }
  for (const el of items()) {
    const r = rect(el);
    for (const x of [r.left + 0.5, r.right - 0.5]) for (const y of [r.top + 0.5, r.bottom - 0.5]) {
      expect(document.elementFromPoint(x, y)?.closest(ITEMS), `corner hit at ${x},${y}`).toBe(el);
    }
  }
  expect(m.row.getAnimations({ subtree: true }), "nothing in the row animates").toEqual([]);
  expect(m.row.querySelectorAll('[tabindex="0"], button:not([tabindex="-1"])').length >= 1).toBe(true);
  expect(m.left.querySelectorAll('[tabindex="0"]'), "the strip is one tab stop").toHaveLength(1);
  expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(innerWidth);
}

function unmount() {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
}

for (const theme of ["dark", "light"]) {
  for (const width of [320, 390, 480, 900, 1280, 1440]) {
    test(`row geometry, 0–5 sessions, keyboard down and up: ${theme}, ${width}`, async () => {
      pointerScene();
      for (const keyboardOpen of [false, true]) {
        for (let n = 0; n <= 5; n++) {
          unmount();
          const pending = n % 3;
          const m = await mount({ width, theme, sessions: five.slice(0, n), pending, keyboardOpen });
          geometry(m, n, keyboardOpen, pending);
        }
      }
    });
  }

  test(`short viewport, keyboard up: ${theme}, 320 × 308`, async () => {
    pointerScene();
    const m = await mount({ width: 320, height: 308, theme, sessions: five, pending: 2, keyboardOpen: true });
    geometry(m, 5, true, 2);
    expect(rect(m.row).height).toBe(44);
    expect(document.documentElement.scrollHeight, "contained vertically").toBeLessThanOrEqual(innerHeight);
  });

  for (const width of [320, 900]) {
    test(`roving group, one tab stop: ${theme}, ${width}`, async () => {
      pointerScene();
      const m = await mount({ width, theme, sessions: five.slice(0, 2) });
      const [a, b] = items();
      m.disc.focus();
      await userEvent.tab();
      expect(document.activeElement, "Tab enters on the most urgent pill").toBe(a);
      await userEvent.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(b);
      await userEvent.keyboard("{ArrowRight}");
      expect(document.activeElement, "arrows wrap inside the group").toBe(a);
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(b);
      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(a);
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(b);
      expect(m.left.querySelectorAll('[tabindex="0"]'), "still one tab stop after roving").toHaveLength(1);
      expect(b!.tabIndex, "the stop follows the caret").toBe(0);
      for (const open of m.opens) expect(open, "arrows never open").not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      // `five[0]` is done and `five[1]` running: running sorts first, so b is done.
      expect(m.opens[0], "Enter and Space open the focused session").toHaveBeenCalledTimes(2);
      await userEvent.tab();
      expect(document.activeElement, "Tab leaves the group in one step").toBe(m.composer);
      await userEvent.tab({ shift: true });
      expect(document.activeElement, "Shift+Tab returns to where the caret was").toBe(b);
    });

    test(`overflow sheet: focus moves, is trapped and returns: ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const m = await mount({ width, theme, sessions: five });
      expect(items(), "hidden sessions are not in the tab order").toHaveLength(2);
      expect(host!.querySelectorAll("[data-session]"), "only the most urgent pill is drawn").toHaveLength(1);
      expect(host!.querySelector<HTMLElement>("[data-session]")!.dataset.state, "the most urgent session is the drawn one").toBe("needs-you");
      const summary = items()[1]!;
      expect(summary.getAttribute("aria-label")).toBe("4 more working sessions: 2 running, 1 unknown, 1 done. Open list.");
      summary.focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => sheet(), { message: "the sheet opens" }).not.toBeNull();
      const rows = [...sheet()!.querySelectorAll<HTMLElement>('[role="button"]')];
      expect(rows, "the sheet opens every session").toHaveLength(5);
      for (const row of rows) expect(rect(row).height, "44px sheet row target").toBeGreaterThanOrEqual(44);
      expect(sheet()!.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement, "focus moves to the first row").toBe(rows[0]);
      expect([...sheet()!.querySelectorAll<HTMLElement>("[data-state]")].map((el) => el.dataset.state)).toEqual(["needs-you", "running", "running", "unknown", "done"]);
      await userEvent.tab({ shift: true });
      expect(document.activeElement, "Shift+Tab wraps to the last row").toBe(rows[4]);
      await userEvent.tab();
      expect(document.activeElement, "Tab wraps to the first row").toBe(rows[0]);
      expect(sheet()!.getAnimations({ subtree: true })).toEqual([]);
      if (mode === "mixed") await page.screenshot({ element: sheet()!, path: `../../.vitest-attachments/session-strip/sheet-${theme}-${width}.png` });
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => sheet()).toBeNull();
      expect(document.activeElement, "Esc returns focus to the summary").toBe(items()[1]);

      // Pointer: the summary, then the scrim.
      if (mode === "fine") await userEvent.click(items()[1]!);
      else {
        const r = rect(items()[1]!);
        await commands.rankTouch("touchStart", [{ x: r.right - 0.5, y: r.bottom - 0.5 }]);
        await commands.rankTouch("touchEnd", []);
      }
      await expect.poll(() => sheet(), { message: "a pointer opens the sheet" }).not.toBeNull();
      const scrim = document.body.querySelector<HTMLElement>("[data-working-scrim]")!;
      if (mode === "fine") await userEvent.click(scrim, { position: { x: 4, y: 4 } });
      else {
        await commands.rankTouch("touchStart", [{ x: 4, y: 4 }]);
        await commands.rankTouch("touchEnd", []);
      }
      await expect.poll(() => sheet(), { message: "the scrim dismisses" }).toBeNull();
      await expect.poll(() => document.activeElement).toBe(items()[1]);

      // Opening a session from the sheet closes it and leaves focus to the caller.
      items()[1]!.focus();
      await userEvent.keyboard(" ");
      await expect.poll(() => sheet()).not.toBeNull();
      const last = [...sheet()!.querySelectorAll<HTMLElement>('[role="button"]')][4]!;
      last.focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => sheet()).toBeNull();
      expect(m.opens[0], "the done session opened").toHaveBeenCalledTimes(1);
      expect(document.activeElement, "focus is the caller's after opening").not.toBe(items()[1]);
    });

    test(`keyboard-open summary blurs the composer and restores its caret: ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const m = await mount({ width, theme, sessions: five, keyboardOpen: true });
      const summary = items()[0]!;
      expect(summary.getAttribute("aria-label")).toBe("5 working sessions: 1 needs you, 2 running, 1 unknown, 1 done. Open list.");
      m.composer.focus();
      m.composer.setSelectionRange(8, 8);
      if (mode === "fine") await userEvent.click(summary);
      else {
        const r = rect(summary);
        await commands.rankTouch("touchStart", [{ x: r.left + 0.5, y: r.top + 0.5 }]);
        await commands.rankTouch("touchEnd", []);
      }
      await expect.poll(() => sheet()).not.toBeNull();
      expect(document.activeElement, "the composer is blurred").not.toBe(m.composer);
      expect(sheet()!.contains(document.activeElement), "focus is in the sheet").toBe(true);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => sheet()).toBeNull();
      await expect.poll(() => document.activeElement, { message: "focus returns to the composer" }).toBe(m.composer);
      expect([m.composer.selectionStart, m.composer.selectionEnd], "with the caret restored").toEqual([8, 8]);
    });

    test(`touch and pointer open a pill once, at its corners: ${theme}, ${width}`, async () => {
      const mode = pointerScene();
      const m = await mount({ width, theme, sessions: five.slice(0, 2) });
      const pill = items()[1]!;
      if (mode === "fine") await userEvent.click(pill, { position: { x: 1, y: 1 } });
      else {
        const r = rect(pill);
        await commands.rankTouch("touchStart", [{ x: r.left + 0.5, y: r.bottom - 0.5 }]);
        await commands.rankTouch("touchEnd", []);
      }
      await expect.poll(() => m.opens[0]!.mock.calls.length, { message: "opens once" }).toBe(1);
      expect(m.opens[1]).not.toHaveBeenCalled();
    });
  }
}

for (const theme of ["dark", "light"]) for (const [width, keyboardOpen] of [[320, false], [320, true], [390, false], [900, false]] as const) {
  test(`baseline: ${theme}, ${width}${keyboardOpen ? ", keyboard up" : ""}`, async () => {
    const mode = pointerScene();
    const m = await mount({ width, theme, sessions: five, pending: 1, keyboardOpen });
    const name = `session-strip-${theme}-${width}${keyboardOpen ? "-keyboard" : ""}`;
    if (mode === "mixed") await expect(page.elementLocator(m.row)).toMatchScreenshot(name);
    else await page.screenshot({ element: m.row, path: `../../.vitest-attachments/session-strip/${name}-${mode}.png` });
  });
}

/** The app's arrangement for the three cases below: `keyboardOpen` follows the
 * composer's focus, the session list can change, and the strip can sit in a
 * subtree themed apart from `<html>`. */
function FocusDriven(props: { sessions: WorkingSession[]; theme?: string }) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  return (
    <div data-theme={props.theme} style={{ width: 320, padding: 12, boxSizing: "border-box", background: "var(--bk-color-canvas)" }}>
      <ComposerRow left={<SessionStrip sessions={props.sessions} now={WORKING_NOW} formatClock={ogygiaClock} keyboardOpen={keyboardOpen} />} />
      <textarea
        data-composer=""
        aria-label="Message"
        defaultValue="Can you also check the April receipts"
        onFocus={() => setKeyboardOpen(true)}
        onBlur={() => setKeyboardOpen(false)}
        style={{ width: "100%", height: 56, marginTop: 8, boxSizing: "border-box" }}
      />
    </div>
  );
}

async function mountDriven(sessions: WorkingFixture[], theme: string, subtree?: string) {
  await page.viewport(320, 640);
  await commands.formViewport(320, 640);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const live = sessions.map((s) => ({ ...s, onOpen: vi.fn() }));
  const draw = (list: WorkingSession[]) => flushSync(() => root!.render(<FocusDriven sessions={list} theme={subtree} />));
  draw(live);
  await document.fonts.ready;
  return { live, draw, composer: host.querySelector<HTMLTextAreaElement>("[data-composer]")! };
}

for (const theme of ["dark", "light"]) {
  for (const n of [2, 5]) {
    test(`keyboardOpen driven by composer focus: the press opens the sheet and the caret returns: ${theme}, ${n} sessions`, async () => {
      const mode = pointerScene();
      const { composer } = await mountDriven(five.slice(0, n), theme);
      composer.focus();
      composer.setSelectionRange(5, 5);
      await expect.poll(() => host!.querySelector("[data-strip-summary]")?.getAttribute("data-strip-summary"), { message: "composer focus collapses the strip" }).toBe("keyboard");
      const summary = host!.querySelector<HTMLElement>('[data-strip-summary="keyboard"]')!;
      if (mode === "fine") await userEvent.click(summary);
      else {
        const r = rect(summary);
        await commands.rankTouch("touchStart", [{ x: r.left + r.width / 2, y: r.top + r.height / 2 }]);
        await commands.rankTouch("touchEnd", []);
      }
      await expect.poll(() => sheet(), { message: "the pressed summary opens the sheet" }).not.toBeNull();
      expect(document.activeElement, "the composer is blurred").not.toBe(composer);
      expect(sheet()!.contains(document.activeElement), "focus is in the sheet").toBe(true);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => sheet()).toBeNull();
      await expect.poll(() => document.activeElement, { message: "focus returns to the composer" }).toBe(composer);
      expect([composer.selectionStart, composer.selectionEnd], "with the caret restored").toEqual([5, 5]);
    });
  }

  test(`a session leaving under the sheet's caret keeps focus in the sheet: ${theme}`, async () => {
    pointerScene();
    const { live, draw } = await mountDriven(five, theme);
    items()[1]!.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => sheet()).not.toBeNull();
    const rows = () => [...sheet()!.querySelectorAll<HTMLElement>('[role="button"]')];
    rows()[1]!.focus();
    const leaving = sheet()!.querySelectorAll<HTMLElement>("[data-session]")[1]!.dataset.session;
    draw(live.filter((s) => s.id !== leaving));
    expect(rows(), "the row left").toHaveLength(4);
    await expect.poll(() => sheet()!.contains(document.activeElement), { message: "focus stays in the dialog" }).toBe(true);
    await userEvent.tab({ shift: true });
    expect(sheet()!.contains(document.activeElement), "Tab is still trapped").toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => sheet(), { message: "Esc still reaches the dialog" }).toBeNull();
  });

  test(`the sheet keeps a subtree theme past the portal: ${theme} page`, async () => {
    pointerScene();
    const other = theme === "dark" ? "light" : "dark";
    await mountDriven(five, theme, other);
    const surfaceIn = getComputedStyle(host!.querySelector<HTMLElement>("[data-pill]")!).backgroundColor;
    items()[1]!.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => sheet()).not.toBeNull();
    expect(document.body.querySelector<HTMLElement>("[data-working-scrim]")!.dataset.theme).toBe(other);
    const panel = sheet()!.querySelector<HTMLElement>(":scope > div")!;
    expect(getComputedStyle(panel).backgroundColor, "the sheet's surface is the strip's theme").toBe(surfaceIn);
  });
}
