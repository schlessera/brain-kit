/**
 * The /stats answer in REAL Chrome at a 320px phone (#97). The composer's
 * unit tests say what is drawn and count characters against the row budget;
 * only a real layout says whether it fits: no horizontal overflow, the tile
 * rows two-up, and every receipt value on one line — so no figure breaks
 * mid-number — at the largest figures a brain and server plausibly reach.
 *
 * The answer box is the one a block gets in the chat at 320px: the message
 * list pads its column 16px a side
 * (`packages/ui-kit/tests/visual/receipt-value-budget.visual.tsx` has the
 * derivation), so 288px.
 *
 * Whether this runs is a decision, as in `share-render.test.ts`:
 * `BRAIN_REQUIRE_CHROME=1`, which CI sets, turns a missing Chrome into a
 * failed file rather than a skipped one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { TOKENS } from "@schlessera/brain-ui-kit";

import { composeStatsAnswer, type StatsInput } from "../packages/ui-react/src/components/chat/stats/compose-stats.ts";
import { StatsAnswer } from "../packages/ui-react/src/components/chat/stats/stats-answer.tsx";
import { actionableTrends, corpusStats, runtimeStats } from "../packages/ui-react/tests/stats-fixtures.ts";

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

const TOKEN_CSS = `:root{color-scheme:dark;${Object.entries(TOKENS)
  .map(([name, value]) => `--bk-${name}:${value};`)
  .join("")}}`;

function page(input: StatsInput): string {
  const body = renderToStaticMarkup(<StatsAnswer sections={composeStatsAnswer(input)} />);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>${TOKEN_CSS} body{margin:0;background:var(--bk-color-canvas)} main{padding:0 16px} [data-stats-answer]>*+*{margin-top:12px}</style>
</head><body><main>${body}</main></body></html>`;
}

/** Every broken layout on the page, as sentences; `[]` when it fits. */
async function misfits(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`page is ${doc.scrollWidth}px wide in ${doc.clientWidth}`);
    const answer = document.querySelector("[data-stats-answer]")!.getBoundingClientRect();
    if (Math.round(answer.width) !== 288) out.push(`answer box is ${answer.width}px, not 288`);
    for (const el of document.querySelectorAll<HTMLElement>("[data-stats-answer] *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > answer.right + 1) {
        out.push(`<${el.tagName.toLowerCase()}>${(el.textContent ?? "").slice(0, 24)} overflows by ${Math.round(r.right - answer.right)}px`);
      }
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "hidden") {
        out.push(`${(el.textContent ?? "").slice(0, 24)} is clipped`);
      }
    }
    // Two tiles per row, side by side: never stacked, never ragged.
    for (const row of document.querySelectorAll('[data-stats-section="tiles"]')) {
      const tops = [...row.querySelectorAll(":scope > * > *")].map((t) => Math.round(t.getBoundingClientRect().top));
      if (tops.length !== 2 || tops[0] !== tops[1]) out.push(`tile row laid out at tops ${tops.join(", ")}`);
    }
    // A receipt value takes one line: a figure never breaks.
    for (const value of document.querySelectorAll<HTMLElement>('[data-stats-section="receipt"] [data-tone]')) {
      const line = parseFloat(getComputedStyle(value).lineHeight);
      if (value.getBoundingClientRect().height > line * 1.5) out.push(`"${value.textContent}" wraps`);
    }
    return out;
  });
}

let browser: Browser | undefined;

beforeAll(async () => {
  if (!chromePath) return;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

const big: StatsInput = {
  corpus: {
    ok: true,
    value: corpusStats({
      tags: 99_999,
      links: 999_999,
      brokenLinks: 120_000,
      chunks: 9_999_999,
      embeddings: 9_999_999,
      health: { ...corpusStats().health, brokenLinkRate: 0.12, embeddingCoverage: 0.5, stale: 99_999, orphans: 99_999, untagged: 99_999 },
      size: {
        corpus: { bytes: 999.9 * 1024 ** 3, files: 123_456 },
        db: { bytes: 999.9 * 1024 ** 3, tables: {}, vectorSlots: { live: null, allocated: null } },
        freeBytes: 999.9 * 1024 ** 4,
      },
    }),
  },
  runtime: {
    ok: true,
    value: runtimeStats({
      window: {
        runs: 99_999,
        failures: 99_999,
        costUsd: 99_999.99,
        effectiveCostUsd: 99_999.99,
        unpricedRuns: 9_999,
        unpricedListCostRuns: 9_999,
        inputTokens: 999_000_000_000,
        outputTokens: 999_000_000_000,
        cacheReadTokens: 999_000_000_000,
        cacheCreationTokens: 999_000_000_000,
      },
      lifetime: { sessions: 999_999, turns: 9_999_999, costUsd: 999_999.99 },
    }),
  },
};

const CASES: [string, StatsInput][] = [
  ["the fixture brain", { corpus: { ok: true, value: corpusStats() }, runtime: { ok: true, value: runtimeStats() } }],
  ["maximum-size figures", big],
  ["actionable recorded trends", { corpus: { ok: true, value: corpusStats({ trends: actionableTrends() }) }, runtime: { ok: true, value: runtimeStats() } }],
  ["runtime unavailable", { corpus: { ok: true, value: corpusStats() }, runtime: { ok: false, error: "the request timed out after 30 seconds" } }],
];

describe.skipIf(!chromePath)("the /stats answer at 320px", () => {
  for (const [name, input] of CASES) {
    test(`${name}: fits, two tiles a row, one line per value`, async () => {
      const p = await browser!.newPage();
      try {
        await p.setViewport({ width: 320, height: 800 });
        await p.setContent(page(input));
        // Something to measure in each kind the checks cover.
        const values = await p.$$eval('[data-stats-section="receipt"] [data-tone]', (els) => els.length);
        expect(values).toBeGreaterThan(10);
        if (input.corpus.ok && input.corpus.value.trends) {
          const text = await p.$eval('[data-stats-answer]', el => el.textContent ?? "");
          expect(text).toContain("Recorded orphans");
          for (const v of input.corpus.value.trends.verdicts) expect(text).toContain(v.message);
        }
        const tileRows = await p.$$eval('[data-stats-section="tiles"]', (els) => els.length);
        expect(tileRows).toBe(name === "runtime unavailable" ? 1 : 2);
        expect(await misfits(p)).toEqual([]);
      } finally {
        await p.close();
      }
    }, 60_000);
  }
});

const identity = { release: "0.38.0", sourceCommit: "a".repeat(40) };
const SOFTWARE_CASES = [
  ["matching", { client: identity, server: { ok: true, value: identity } }],
  ["different", { client: identity, server: { ok: true, value: { release: "0.39.0", sourceCommit: "b".repeat(40) } } }],
  ["unknown", { client: { release: "0.38.0", sourceCommit: "dev" }, server: { ok: false, error: "offline" } }],
] as const;

describe.skipIf(!chromePath)("software identity in real Chrome", () => {
  for (const width of [320, 1024]) for (const [name, software] of SOFTWARE_CASES) {
    test(`${name} at ${width}px: complete selectable identities without overflow`, async () => {
      const p = await browser!.newPage();
      try {
        await p.setViewport({ width, height: 900 });
        await p.setContent(page({ ...big, software }));
        const result = await p.evaluate(() => {
          const section = document.querySelector('[aria-label="Software versions"]')!;
          const values = [...section.querySelectorAll<HTMLElement>("[data-tone]")];
          const range = document.createRange();
          range.selectNodeContents(values[1]);
          const selection = window.getSelection()!;
          selection.removeAllRanges(); selection.addRange(range);
          return {
            values: values.map((el) => el.textContent), selected: selection.toString(),
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            clipped: values.some((el) => el.scrollWidth > el.clientWidth + 1),
          };
        });
        expect(result.values).toHaveLength(4);
        expect(result.values[0]).toBe(identity.release);
        expect(result.selected).toBe(name === "unknown" ? "Unknown" : identity.sourceCommit);
        expect(result.overflow).toBe(false);
        expect(result.clipped).toBe(false);
        await p.screenshot({ path: `/tmp/brain-kit-software-${name}-${width}.png`, fullPage: true });
      } finally { await p.close(); }
    });
  }
});
