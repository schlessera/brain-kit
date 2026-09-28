/**
 * Prose links in REAL Chrome (#551, D49): the host suffix's layout, its
 * computed style, axe in both themes, and the network.
 *
 * `packages/ui-react/tests/prose-links.test.tsx` asserts the markup. What it
 * cannot see is what the reader sees: whether a long host wraps only after a
 * "." and is never cut, whether the host keeps its style at rest, whether
 * the withheld text reads as the sentence around it, and whether rendering
 * reaches the network. Those need layout and a network stack, so the markup
 * `BrainMarkdown` renders is laid out here with the stylesheet the app ships
 * (`packages/ui-react/src/theme.css`) over the kit's tokens.
 *
 * The network test ends by activating a link and asserting that the harness
 * DOES see the new tab's destination, so it is shown able to observe what
 * the first network test says never happens.
 *
 * Like the other Chrome suites, whether this runs is a decision:
 * `BRAIN_REQUIRE_CHROME=1`, which CI sets, turns a missing Chrome into a
 * failed file rather than a skipped one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";

import { BrainMarkdown } from "../packages/ui-react/src/components/chat/brain-markdown.tsx";
import { BrainUiProvider } from "../packages/ui-react/src/root-context.tsx";
import { createBrainUiRoot } from "../packages/ui-react/src/root.ts";

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

/**
 * The app's stylesheet as the browser would get it from a Tailwind build:
 * the `@theme` blocks become plain custom properties and the package import
 * is replaced by the tokens it names.
 */
const THEME = readFileSync(join(import.meta.dir, "../packages/ui-react/src/theme.css"), "utf8")
  .replace(/@import\s+[^;]+;/g, "")
  .replace(/@theme(\s+\w+)*\s*\{/g, ":root {");
const TOKENS = readFileSync(join(import.meta.dir, "../packages/ui-kit/src/tokens.css"), "utf8");
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

/** A single DNS label at its 63-character limit. */
const LONG_LABEL = `harbour-${"a".repeat(55)}`;

/** The design's paragraph, list and table (the mocks on #551), and one long host. */
const FIXTURE = [
  "Before Tuesday, check the [tide table](https://ithaca-harbour.example/tides),",
  "the [pass notice](https://records.harbour-master.ithaca.gov.example:8443/notices),",
  "[Book XII](https://bücher.example/odyssey/12), write to",
  "[Penelope](mailto:penelope@ithaca.example?subject=Supplies&bcc=x@y.example),",
  "and ignore the note from [your bank](https://account-check.example).",
  "Tides also at https://ithaca-harbour.example/tides.",
  "",
  "- [Crew roster](https://nausicaa:oar@drive.example/roster)",
  "- [Supply manifest](https://records.harbour-master.ithaca.gov.example:8443/m.pdf)",
  "- https://u:p@drive.example/roster",
  "",
  "The archive moved; the old notes point to [the index](../archive/index) which no longer resolves.",
  "",
  `The [long one](https://${LONG_LABEL}.example/) has a single label as wide as DNS allows.`,
  "",
  "| Item | Source |",
  "| --- | --- |",
  "| Tides | [harbour office](https://ithaca-harbour.example/tides) |",
  "| Pass | ithaca-harbour.example |",
].join("\n");

const root = createBrainUiRoot({ storage: null });
const PROSE = renderToStaticMarkup(
  <BrainUiProvider root={root}>
    <BrainMarkdown content={FIXTURE} fileLinks />
  </BrainUiProvider>
);

type Ground = "canvas" | "surface" | "raised";

function documentAt(width: number, theme: "light" | "dark" = "dark", ground: Ground = "canvas"): string {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><title>Prose links</title><meta name="viewport" content="width=device-width"><style>
    ${TOKENS}
    ${THEME}
    body { margin: 0; padding: 16px; background: var(--bk-color-canvas); color: var(--bk-color-ink); }
    main { max-width: ${width}px; background: var(--bk-color-${ground}); }
  </style></head><body><main>${PROSE}</main></body></html>`;
}

let browser: Browser;
beforeAll(async () => {
  if (!chromePath) return;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function open(width: number, theme?: "light" | "dark", ground?: Ground): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: width + 32, height: 1200 });
  await page.setContent(documentAt(width, theme, ground));
  return page;
}

describe.skipIf(!chromePath)("prose links in Chrome", () => {
  for (const width of [320 - 32, 720]) {
    test(`16/17. at a ${width}px measure every host is whole, and breaks only after a "."`, async () => {
      const page = await open(width);
      try {
        const measured = await page.evaluate(() => {
          const prose = document.querySelector<HTMLElement>(".brain-prose")!;
          const hosts = [...document.querySelectorAll<HTMLElement>(".bk-plink-host")];
          // Where each line ends inside a host: the character before a line change.
          const breaks = hosts.map((host) => {
            const chars: { ch: string; top: number }[] = [];
            const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const text = node.textContent ?? "";
              for (let i = 0; i < text.length; i++) {
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const rect = range.getClientRects()[0];
                if (rect) chars.push({ ch: text[i]!, top: Math.round(rect.top) });
              }
            }
            const endsOfLines: string[] = [];
            for (let i = 1; i < chars.length; i++) {
              if (chars[i]!.top > chars[i - 1]!.top) endsOfLines.push(chars[i - 1]!.ch);
            }
            return { text: host.textContent ?? "", endsOfLines };
          });
          const clipped = [...document.querySelectorAll<HTMLElement>(".bk-plink-host")].flatMap((host) => {
            const found: string[] = [];
            for (let el: HTMLElement | null = host; el && el !== prose.parentElement; el = el.parentElement) {
              const style = getComputedStyle(el);
              if (style.textOverflow === "ellipsis") found.push(`${el.tagName} ellipsis`);
              // The table's own horizontal scroll is the one allowed overflow.
              if (style.overflowX === "hidden" || style.overflowY === "hidden") found.push(`${el.tagName} hidden`);
            }
            return found;
          });
          return {
            fits: prose.scrollWidth <= prose.clientWidth,
            hosts: breaks,
            clipped,
          };
        });
        expect(measured.fits).toBe(true);
        expect(measured.clipped).toEqual([]);
        const texts = measured.hosts.map((h) => h.text);
        expect(texts).toEqual([
          " (ithaca-harbour.example)",
          " (records.harbour-master.ithaca.gov.example:8443)",
          " (xn--bcher-kva.example)",
          " (penelope@ithaca.example)",
          " (account-check.example)",
          " (records.harbour-master.ithaca.gov.example:8443)",
          ` (${LONG_LABEL}.example)`,
          " (ithaca-harbour.example)",
        ]);
        for (const host of measured.hosts) {
          // Between the text and "(" is an ordinary space; inside the host a
          // line ends only after a "." — unless one label is wider than the line.
          const allowed = host.text.includes(LONG_LABEL) ? /./ : /[ .]/;
          for (const ch of host.endsOfLines) expect({ host: host.text, ch }).toEqual({ host: host.text, ch: expect.stringMatching(allowed) });
        }
        if (width < 320) {
          // The measure is narrow enough that the long hosts really do wrap.
          expect(measured.hosts.some((h) => h.endsOfLines.includes("."))).toBe(true);
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("6/7. at rest the host is painted, undecorated, in another family, and no state hides it", async () => {
    const page = await open(720);
    try {
      const styles = await page.evaluate(() => {
        const a = document.querySelector<HTMLAnchorElement>("a.bk-plink")!;
        const text = a.querySelector<HTMLElement>(".bk-plink-text")!;
        const host = a.querySelector<HTMLElement>(".bk-plink-host")!;
        const rect = host.getBoundingClientRect();
        const stateRules: string[] = [];
        for (const sheet of document.styleSheets) {
          for (const rule of sheet.cssRules) {
            if (!(rule instanceof CSSStyleRule)) continue;
            if (!/:hover|:focus/.test(rule.selectorText)) continue;
            if (!/bk-plink-host|bk-plink\b[^-]/.test(rule.selectorText + " ")) continue;
            for (const prop of ["display", "visibility", "opacity", "clip", "clip-path"]) {
              if (rule.style.getPropertyValue(prop)) stateRules.push(`${rule.selectorText} ${prop}`);
            }
          }
        }
        return {
          host: getComputedStyle(host).textDecorationLine,
          text: getComputedStyle(text).textDecorationLine,
          anchor: getComputedStyle(a).textDecorationLine,
          sameFamily: getComputedStyle(host).fontFamily === getComputedStyle(text).fontFamily,
          visible: rect.width > 0 && rect.height > 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          stateRules,
        };
      });
      expect(styles).toEqual({ host: "none", text: "underline", anchor: "none", sameFamily: false, visible: true, stateRules: [] });
    } finally {
      await page.close();
    }
  }, 60_000);

  test("12. a withheld link reads as its sentence: the paragraph's ink, no underline, no pointer", async () => {
    const page = await open(720);
    try {
      const refused = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".bk-plink-refused-text")].map((text) => {
          const block = text.closest("p, li")!;
          return {
            sameInk: getComputedStyle(text).color === getComputedStyle(block).color,
            decoration: getComputedStyle(text).textDecorationLine,
            cursor: getComputedStyle(text).cursor,
            link: text.closest("a, [role=link], [tabindex]") !== null,
          };
        })
      );
      expect(refused).toHaveLength(3);
      for (const r of refused) expect(r).toEqual({ sameInk: true, decoration: "none", cursor: "text", link: false });
    } finally {
      await page.close();
    }
  }, 60_000);

  for (const theme of ["dark", "light"] as const) {
    for (const ground of ["canvas", "surface", "raised"] as const) {
      test(`21. axe finds nothing, ${theme} theme on ${ground}`, async () => {
        const page = await open(720, theme, ground);
        try {
          await page.addScriptTag({ content: AXE });
          const violations = await page.evaluate(async () => {
            const axe = (window as unknown as { axe: { run: (context: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe;
            const result = await axe.run(document.querySelector("main"));
            return result.violations.map((v) => `${v.id} ${JSON.stringify(v.nodes.map((n) => n.target))}`);
          });
          expect(violations).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }

  test("20. rendering, hovering and clicking withheld text requests nothing; activating a link does", async () => {
    const page = await browser.newPage();
    const requests: string[] = [];
    const tabs: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const onTarget = (target: { url(): string }) => tabs.push(target.url());
    browser.on("targetcreated", onTarget);
    try {
      await page.setViewport({ width: 752, height: 1200 });
      await page.setContent(documentAt(720));
      const loaders = await page.evaluate(
        () => document.querySelectorAll("main img, main picture, main source, main iframe, main object, main embed, link, script, [srcset]").length
      );
      expect(loaders).toBe(0);
      for (const selector of ["a.bk-plink", ".bk-plink-host"]) {
        for (const handle of await page.$$(selector)) await handle.hover();
      }
      for (const handle of await page.$$(".bk-plink-refused")) await handle.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const outbound = () => requests.filter((url) => !url.startsWith("data:") && url !== "about:blank");
      expect(outbound()).toEqual([]);
      expect(tabs).toEqual([]);
      expect(page.url()).toBe("about:blank");

      // The harness sees a request when there is one.
      const target = new Promise<void>((resolve) => browser.once("targetcreated", () => resolve()));
      await page.click('a.bk-plink[href="https://account-check.example/"]');
      await target;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(tabs.some((url) => url.includes("account-check.example"))).toBe(true);
    } finally {
      browser.off("targetcreated", onTarget);
      await page.close();
    }
  }, 60_000);
});
