/// <reference types="@vitest/browser-playwright" />
/**
 * Pending follow-ups in the right half of the shared row (D52 §3, #1002),
 * measured in real Chromium beside a populated working-session half. It runs
 * in the three `rail-*` projects, so every case is checked with a fine, a
 * coarse and a mixed pointer, under reduced motion; the pointer premise is
 * asserted, never mocked.
 *
 * The scene is the app's arrangement, as in `session-strip.visual.tsx`: a
 * message area holding the scroll disc at `bottom: 16px`, then the row, then
 * a composer, in the column a rail leaves at that width.
 */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { longFollowUp, pendingFollowUps } from "../../fixtures/follow-ups.js";
import { WORKING_NOW, ogygiaClock, workingSessions } from "../../fixtures/sessions.js";
import { ComposerRow } from "../../src/chrome/ComposerRow.js";
import { PendingFollowUps, type PendingFollowUp } from "../../src/chrome/PendingFollowUps.js";
import { SessionStrip } from "../../src/chrome/SessionStrip.js";

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

const railAt = (width: number) => (width >= 900 ? 208 : width >= 480 ? 60 : 0);

async function mount(opts: { width: number; theme: string; working: number; followUps: PendingFollowUp[]; keyboardOpen?: boolean }) {
  const height = 700;
  await page.viewport(opts.width, height);
  await commands.formViewport(opts.width, height);
  document.documentElement.dataset.theme = opts.theme;
  host = document.createElement("div");
  host.style.cssText = `display:flex;width:${opts.width}px;height:${height}px;background:var(--bk-color-canvas)`;
  document.body.append(host);
  root = createRoot(host);
  const sessions = workingSessions.slice(0, opts.working).map((s) => ({ ...s, onOpen: () => {} }));
  flushSync(() => root!.render(
    <>
      <nav style={{ width: railAt(opts.width), flex: "none" }} />
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div data-message-area="" style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <button type="button" data-disc="" aria-label="Scroll to latest" style={{ position: "absolute", bottom: 16, left: "50%", width: 44, height: 44, marginLeft: -22 }} />
        </div>
        <div style={{ padding: "0 12px" }}>
          <ComposerRow
            left={<SessionStrip sessions={sessions} now={WORKING_NOW} formatClock={ogygiaClock} keyboardOpen={opts.keyboardOpen} />}
            right={<PendingFollowUps followUps={opts.followUps} keyboardOpen={opts.keyboardOpen} />}
          />
        </div>
        <textarea data-composer="" aria-label="Message" style={{ height: 56, margin: "8px 12px 12px", boxSizing: "border-box" }} />
      </main>
    </>,
  ));
  await document.fonts.ready;
  const q = (sel: string) => host!.querySelector<HTMLElement>(sel)!;
  return { row: q("[data-composer-row]"), left: q('[data-row-half="left"]'), right: q('[data-row-half="right"]'), disc: q("[data-disc]") };
}

const rect = (el: Element) => el.getBoundingClientRect();
const pendingItems = () => [...host!.querySelectorAll<HTMLElement>('[data-pending-follow-ups] [data-pill][role="button"], [data-pending-summary]')];
const workingItems = () => [...host!.querySelectorAll<HTMLElement>('[data-session-strip] [data-pill][role="button"], [data-strip-summary]')];
const popovers = () => [...host!.querySelectorAll<HTMLElement>("[data-follow-up-text]")];

const WIDTHS = [320, 390, 480, 900, 1279];
const COUNTS = [1, 2, 3, 6];

for (const theme of ["dark", "light"]) {
  for (const width of WIDTHS) {
    for (const keyboardOpen of [false, true]) {
      test(`the halves never overlap, the disc stays clear: ${theme}, ${width}${keyboardOpen ? ", keyboard up" : ""}`, async () => {
        pointerScene();
        for (const n of COUNTS) {
          const followUps = [...pendingFollowUps, longFollowUp].slice(0, n);
          const m = await mount({ width, theme, working: 3, followUps, keyboardOpen });
          const row = rect(m.row);
          const left = rect(m.left);
          const right = rect(m.right);
          // Every target is the 44px pill box, in its own half.
          for (const el of pendingItems()) {
            const r = rect(el);
            expect(r.height, `${n}: 44px pending target`).toBe(44);
            expect(r.left, `${n}: pending stays right of the gutter`).toBeGreaterThanOrEqual(right.left);
            expect(r.right, `${n}: pending stays inside the row`).toBeLessThanOrEqual(right.right + 0.5);
          }
          for (const el of workingItems()) expect(rect(el).right, `${n}: working stays left of the gutter`).toBeLessThanOrEqual(left.right + 0.5);
          expect(right.left - left.right, `${n}: gutter`).toBeGreaterThanOrEqual(8);
          expect(pendingItems(), `${n}: pills drawn`).toHaveLength(keyboardOpen ? 1 : Math.min(n, 2));
          expect(row.height, `${n}: row cap`).toBeLessThanOrEqual(keyboardOpen ? 44 : 94);
          expect(row.top - rect(m.disc).bottom, `${n}: the disc is 16px above the row`).toBeGreaterThanOrEqual(16);
          expect(document.getAnimations(), "nothing animates").toEqual([]);
          flushSync(() => root!.unmount());
          root = undefined;
          host!.remove();
          host = undefined;
        }
      });
    }
  }
}

for (const width of [320, 900]) {
  test(`a pill's full text opens inside its half, and a touch tap toggles it: ${width}`, async () => {
    const mode = pointerScene();
    const m = await mount({ width, theme: "dark", working: 2, followUps: [longFollowUp, pendingFollowUps[1]!] });
    const [pill] = pendingItems();
    const [text] = popovers();
    expect(text!.hidden).toBe(true);
    if (mode === "fine") {
      await userEvent.hover(pill!);
    } else {
      const r = rect(pill!);
      await commands.rankTouch("touchStart", [{ x: r.left + 20, y: r.top + 20 }]);
      await commands.rankTouch("touchEnd", []);
    }
    await expect.poll(() => text!.hidden, { message: "revealed" }).toBe(false);
    const box = rect(text!);
    const half = rect(m.right);
    expect(box.width).toBeLessThanOrEqual(Math.min(280, half.width) + 0.5);
    expect(box.left, "never across the gutter").toBeGreaterThanOrEqual(half.left - 0.5);
    expect(box.bottom, "above its pill").toBeLessThanOrEqual(rect(pill!).top);
    expect(document.getAnimations(), "no transition").toEqual([]);
    if (mode !== "fine") {
      // Another tap closes it; a tap outside closes one a tap opened.
      const r = rect(pill!);
      await commands.rankTouch("touchStart", [{ x: r.left + 20, y: r.top + 20 }]);
      await commands.rankTouch("touchEnd", []);
      await expect.poll(() => text!.hidden, { message: "a second tap closes" }).toBe(true);
      await commands.rankTouch("touchStart", [{ x: r.left + 20, y: r.top + 20 }]);
      await commands.rankTouch("touchEnd", []);
      await expect.poll(() => text!.hidden, { message: "a tap opens again" }).toBe(false);
      await commands.rankTouch("touchStart", [{ x: 4, y: 4 }]);
      await commands.rankTouch("touchEnd", []);
      await expect.poll(() => text!.hidden, { message: "a tap outside closes" }).toBe(true);
    }
  });
}
