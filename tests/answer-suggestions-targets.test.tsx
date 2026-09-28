/**
 * The answer-suggestion chips' hit targets and accessibility, in REAL Chrome
 * (#40, D34).
 *
 * A chip paints about 29px tall and reaches 8px past its paint on every side,
 * through `.answer-chip::before` in `packages/ui-react/src/theme.css`. Whether
 * that makes a 44px target is a question about layout, which happy-dom does
 * not do, so the markup the app renders is laid out here, at a phone width and
 * a desktop one, and `elementFromPoint` is asked what sits just inside each
 * edge of each target. The same page, drawn with the kit's tokens in both
 * themes, goes through axe.
 *
 * Like the other Chrome suites, whether this runs is a decision:
 * `BRAIN_REQUIRE_CHROME=1`, which CI sets, turns a missing Chrome into a
 * failed file rather than a skipped one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";

import { AnswerSuggestionsView, CHIP_GAP } from "../packages/ui-react/src/components/chat/answer-suggestions.tsx";

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));
if (!chromePath && process.env.BRAIN_REQUIRE_CHROME === "1") {
  throw new Error("BRAIN_REQUIRE_CHROME=1, but no Chrome/Chromium executable was found.");
}

/** The chip rules exactly as the app ships them, from the stylesheet itself. */
const THEME = readFileSync(join(import.meta.dir, "../packages/ui-react/src/theme.css"), "utf8");
const CHIP_CSS = THEME.slice(THEME.indexOf("/* Answer suggestions"));
/** The kit's tokens, so axe measures the colours the app draws. */
const TOKENS = readFileSync(join(import.meta.dir, "../packages/ui-kit/src/tokens.css"), "utf8");
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const ITEMS = [
  // 80 characters: the schema's cap, two lines at 320px.
  { label: "What did Circe say about Charybdis, and which of the crew heard her say it aloud" },
  { label: "Who was on watch then?", icon: "ask" },
];

function documentAt(theme?: "light" | "dark"): string {
  const row = renderToStaticMarkup(
    <AnswerSuggestionsView label="Ask next" items={ITEMS} describedBy="d" onTake={() => {}} />
  );
  // 16px of page padding keeps every reach inside the viewport.
  const tokens = theme ? `${TOKENS}\nbody { background: var(--bk-color-canvas); color: var(--bk-color-ink); }` : "";
  return `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ""}><head><title>Answer suggestions</title><meta name="viewport" content="width=device-width"><style>
    body { margin: 0; padding: 16px; font-family: sans-serif; }
    ${tokens}
    ${CHIP_CSS}
  </style></head><body><main>${row}</main></body></html>`;
}

let browser: Browser;
beforeAll(async () => {
  if (!chromePath) return;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

interface Measured {
  label: string;
  width: number;
  height: number;
  border: string;
  /** Whether the point 1px inside each edge of the target lands on this chip. */
  edges: Record<"left" | "right" | "top" | "bottom", boolean>;
}

describe.skipIf(!chromePath)("answer suggestion targets", () => {
  for (const width of [320, 1280]) {
    test(`at ${width}px every chip is a 44px target, hit at all four edges`, async () => {
      expect(ITEMS[0]!.label).toHaveLength(80);
      const page = await browser.newPage();
      try {
        await page.setViewport({ width, height: 800 });
        await page.setContent(documentAt());
        const REACH = 8;
        const measured = await page.evaluate((reach: number) => {
          const chips = [...document.querySelectorAll<HTMLButtonElement>(".answer-chip")];
          return chips.map((chip) => {
            const r = chip.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const on = (x: number, y: number) => chip.contains(document.elementFromPoint(x, y));
            return {
              label: chip.textContent ?? "",
              width: r.width,
              height: r.height,
              border: getComputedStyle(chip).borderTopWidth,
              edges: {
                left: on(r.left - reach + 1, cy),
                right: on(r.right + reach - 1, cy),
                top: on(cx, r.top - reach + 1),
                bottom: on(cx, r.bottom + reach - 1),
              },
            };
          });
        }, REACH);
        expect(measured).toHaveLength(2);
        for (const chip of measured as Measured[]) {
          // D34: the paint carries no border, so the reach is measured from it.
          expect(chip.border).toBe("0px");
          expect(chip.height + 2 * REACH).toBeGreaterThanOrEqual(44);
          expect(chip.width + 2 * REACH).toBeGreaterThanOrEqual(44);
          expect(chip.edges).toEqual({ left: true, right: true, top: true, bottom: true });
        }
        // The gap that makes an 8px reach safe on both axes.
        expect(CHIP_GAP).toBe(2 * REACH);
        // The 80-character chip wraps, and never to a third line.
        const long = (measured as Measured[])[0]!;
        if (width === 320) expect(long.height).toBeGreaterThan(30);
        expect(long.height).toBeLessThan(48);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  for (const theme of ["dark", "light"] as const) {
    test(`axe finds nothing on the row, ${theme} theme`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 390, height: 800 });
        await page.setContent(documentAt(theme));
        // The row fades in; measured mid-fade, its ink blends with the page
        // and axe reads a colour the reader never settles on.
        await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
        await page.addScriptTag({ content: AXE });
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: (context: unknown) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }> } }).axe;
          const result = await axe.run(document.querySelector("[data-answer-suggestions]"));
          return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
        });
        expect(violations).toEqual([]);
        // What axe read: the group's name and each chip's words and description.
        const names = await page.evaluate(() => ({
          group: document.querySelector("[role=group]")?.getAttribute("aria-label"),
          described: [...document.querySelectorAll(".answer-chip")].map(
            (chip) => document.getElementById(chip.getAttribute("aria-describedby") ?? "")?.textContent
          ),
        }));
        expect(names).toEqual({
          group: "Suggested follow-ups",
          described: ["Puts this in the composer to edit. Does not send.", "Puts this in the composer to edit. Does not send."],
        });
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("reduced motion: the row appears without its fade", async () => {
    const page = await browser.newPage();
    try {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.setContent(documentAt("dark"));
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      await page.setContent(documentAt("dark"));
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(1);
    } finally {
      await page.close();
    }
  });
});
