/// <reference types="@vitest/browser-playwright" />
/**
 * A palette row's reason (#1106), measured in real Chromium at the widths the
 * palette is shown at (tablet and up; the app does not draw it at 320). It
 * runs in the three `rail-*` projects, so every case is checked with a fine, a
 * coarse and a mixed pointer, in both themes; the pointer premise is asserted,
 * never mocked.
 *
 * The rule: the reason stays on the label's line, right-aligned where the
 * shortcut would be, while the label, its chips and the whole reason fit side
 * by side. Otherwise it drops to a second line under the label and wraps
 * there. The label is never shrunk for it, and it is never cut.
 */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { CommandPalette, type PaletteGroup, type PaletteItem } from "../../src/desktop/CommandPalette.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;
afterEach(() => {
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
  return mode;
}

const THREE = "Ithaca proxy · gpt-5.5, Circe relay · o4-mini, Argo bridge · gemini-2.5-pro need credentials";
const ONE = "Ithaca proxy · gpt-5.5 needs credentials";

/** Each disabled shape beside its enabled twin, so a one-line row's height can
 * be compared with the same row without a reason. */
const ROWS: PaletteItem[] = [
  { icon: "thread", label: "New chat", tone: "amber", shortcut: "⌘N" },
  { icon: "activity", label: "Brain statistics", tone: "neutral" },
  { icon: "activity", label: "Brain statistics", tone: "neutral", why: "a turn is running" },
  { icon: "share", label: "Continue on another backend", tone: "teal", cost: "spends" },
  { icon: "share", label: "Continue on another backend", tone: "teal", cost: "spends", why: ONE },
  { icon: "share", label: "Continue on another backend", tone: "teal", cost: "spends", why: THREE },
  { icon: "retry", label: "Sync the brain", tone: "amber", effect: "sync" },
  { icon: "retry", label: "Sync the brain", tone: "amber", effect: "sync", why: "needs the host" },
  { icon: "graph", label: "The graph around Ithaca", tone: "purple", why: THREE },
  { icon: "edit", label: "Add a note", tone: "neutral" },
];

async function mount(width: number, theme: string) {
  const height = 800;
  await page.viewport(width, height);
  await commands.formViewport(width, height);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;background:var(--bk-color-canvas)`;
  document.body.append(host);
  const clicks = ROWS.map(() => vi.fn());
  const groups: PaletteGroup[] = [{ label: "Run", items: ROWS.map((it, i) => ({ ...it, onClick: clicks[i] })) }];
  root = createRoot(host);
  // The app's frame: 560px, never wider than the viewport less 2rem.
  flushSync(() => root!.render(
    <div style={{ width: 560, maxWidth: "calc(100vw - 2rem)", margin: "110px auto 0" }}>
      <CommandPalette groups={groups} query="" selected={0} maxHeight={640} onSelect={() => {}} onClose={() => {}} />
    </div>,
  ));
  await document.fonts.ready;
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  const rows = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(rows, "every row is an option").toHaveLength(ROWS.length);
  return { dialog, rows, clicks };
}

const spans = (row: HTMLElement, text: string) => [...row.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === text);

for (const theme of ["dark", "light"] as const) {
  for (const width of [768, 1024, 1280, 1440]) {
    test(`a reason that fits stays beside the label, one that does not drops under it: ${theme}, ${width}`, async () => {
      pointerScene();
      const { dialog, rows } = await mount(width, theme);
      const frame = dialog.getBoundingClientRect();
      expect(document.documentElement.scrollWidth, "the page does not scroll sideways").toBeLessThanOrEqual(width);
      ROWS.forEach((item, i) => {
        const row = rows[i];
        const name = `${item.label}${item.why ? ` (${item.why === THREE ? "three" : item.why})` : ""}`;
        const label = spans(row, item.label)!;
        const at = label.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        const glyph = row.querySelector("svg")!.getBoundingClientRect();
        expect(label.scrollWidth, `${name}: the label is whole`).toBeLessThanOrEqual(label.clientWidth);
        expect(box.right, `${name}: the row ends inside the palette`).toBeLessThanOrEqual(frame.right + 0.5);
        expect(Math.abs((glyph.top + glyph.bottom) / 2 - (at.top + at.bottom) / 2), `${name}: the icon sits on the label's line`).toBeLessThanOrEqual(0.5);
        if (!item.why) return;
        const why = spans(row, item.why)!;
        const reason = why.getBoundingClientRect();
        expect(why.scrollWidth, `${name}: the reason is whole`).toBeLessThanOrEqual(why.clientWidth);
        expect(reason.right, `${name}: the reason ends inside its row`).toBeLessThanOrEqual(box.right + 0.5);
        if (item.why === THREE) {
          expect(reason.top, `${name}: the reason is under the label`).toBeGreaterThanOrEqual(at.bottom);
          expect(Math.abs(reason.left - at.left), `${name}: the reason starts at the label's edge`).toBeLessThanOrEqual(0.5);
          expect(reason.right, `${name}: the reason stops at the row's padding`).toBeLessThanOrEqual(box.right - parseFloat(getComputedStyle(row).paddingRight) + 0.5);
          expect(row.offsetHeight, `${name}: two lines are taller than the one-line row above`).toBeGreaterThan(rows[i - 1].offsetHeight);
        } else {
          const middle = (reason.top + reason.bottom) / 2;
          expect(middle > at.top && middle < at.bottom, `${name}: the reason is on the label's line`).toBe(true);
          expect(box.right - parseFloat(getComputedStyle(row).paddingRight) - reason.right, `${name}: the reason is right-aligned`).toBeLessThanOrEqual(0.5);
          // One line, the height of the same row with no reason.
          const twin = rows[ROWS.findIndex((it) => it.label === item.label && !it.why)];
          expect(row.offsetHeight, `${name}: as tall as the row without a reason`).toBe(twin.offsetHeight);
        }
      });
    });
  }
}

test("pressing a two-line disabled row, on its reason, runs nothing", async () => {
  pointerScene();
  const { rows, clicks } = await mount(1280, "dark");
  const i = ROWS.findIndex((it) => it.why === THREE);
  const why = spans(rows[i], THREE)!;
  await userEvent.click(why);
  expect(clicks[i], "the disabled row does not run").not.toHaveBeenCalled();
  expect(rows[i].getAttribute("aria-disabled")).toBe("true");
});
