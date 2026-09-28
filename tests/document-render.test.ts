/**
 * The document shell in REAL Chrome (#530). Unit tests can say what the shell
 * writes; only a browser says what it means: that an author's own rule beats
 * the shell's, that the footer's margin rules are live rather than text, and
 * that a cover page is followed by its content and no blank page.
 *
 * Like the renderer's runtime tests, whether this runs is a decision:
 * `BRAIN_REQUIRE_CHROME=1`, which CI sets, turns a missing Chrome into a
 * failed file rather than a skipped one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import puppeteer, { type Browser } from "puppeteer-core";
import { buildHtmlDocument } from "@schlessera/brain-render-template";
import { DOCUMENT_KINDS, readSkeleton } from "@schlessera/brain-render-template/kinds";

import { createRenderer, type Renderer } from "../packages/ui-render-puppeteer/src/renderer.ts";
import { countPdfPages } from "../packages/core/src/cli/commands/render.ts";

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

/** The page rules as Chrome parsed them: selector, margin box, content. */
async function pageRules(browser: Browser, html: string): Promise<string[]> {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(() => {
      const out: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSPageRule) {
            for (const box of Array.from(rule.cssRules)) {
              const margin = box as CSSRule & { name: string; style: CSSStyleDeclaration };
              out.push(`${rule.selectorText || "*"} @${margin.name} ${margin.style.getPropertyValue("content")}`);
            }
          } else if ("cssRules" in rule) {
            walk((rule as CSSGroupingRule).cssRules);
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
      return out;
    });
  } finally {
    await page.close();
  }
}

/**
 * Each page of a Chrome PDF, in order: its MediaBox and its decompressed
 * content stream. Skia writes a plain cross-reference table and no object
 * streams, so objects can be read by number.
 */
function pdfPages(pdf: Buffer): { box: number[]; content: string }[] {
  const text = pdf.toString("latin1");
  const object = (n: string): string => {
    const at = text.search(new RegExp(`(?:^|\\n)${n} 0 obj\\b`));
    if (at < 0) throw new Error(`object ${n} not found`);
    return text.slice(at, text.indexOf("endobj", at));
  };
  const stream = (n: string): string => {
    const body = object(n);
    const start = body.indexOf("stream") + "stream".length;
    const raw = body.slice(body[start] === "\r" ? start + 2 : start + 1, body.lastIndexOf("endstream"));
    const bytes = Buffer.from(raw, "latin1");
    return /\/FlateDecode/.test(body) ? inflateSync(bytes).toString("latin1") : raw;
  };
  const pages: { box: number[]; content: string }[] = [];
  const walk = (n: string) => {
    const node = object(n);
    if (/\/Type\s*\/Pages\b/.test(node)) {
      for (const [, kid] of (/\/Kids\s*\[([^\]]*)\]/.exec(node)?.[1] ?? "").matchAll(/(\d+) 0 R/g)) walk(kid);
      return;
    }
    const box = /\/MediaBox\s*\[([^\]]*)\]/.exec(node)![1].trim().split(/\s+/).map(Number);
    const contents = /\/Contents\s+(\d+) 0 R/.exec(node)![1];
    pages.push({ box, content: stream(contents) });
  };
  walk(/\/Pages\s+(\d+) 0 R/.exec(text.slice(text.search(/\/Type\s*\/Catalog/) - 200))![1]);
  return pages;
}

const isA4 = ([, , w, h]: number[]) => Math.abs(w - 595.3) < 1 && Math.abs(h - 841.9) < 1;
/** Whether a content stream draws any text. */
const drawsText = (content: string) => /\bT[jJ]\b/.test(content);

describe.skipIf(!chromePath)("the document shell in real Chrome", () => {
  let browser: Browser;
  let renderer: Renderer;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: chromePath!, headless: true });
    renderer = createRenderer({ executablePath: chromePath!, maxConcurrent: 1 });
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.shutdown();
  });

  test("an author's own rules beat the shell's, whatever their specificity", async () => {
    const html = buildHtmlDocument({
      contentType: "html",
      content: `<!doctype html><html><head><style>
        h2 { color: rgb(1, 2, 3); }
        div { background: rgb(4, 5, 6); }
      </style></head><body><h2>Own</h2><div class="doc-card">Own</div><h3>Shell</h3></body></html>`,
    });
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const drawn = await page.evaluate(() => ({
        h2: getComputedStyle(document.querySelector("h2")!).color,
        // `.doc-card` sets a background in the shell; the author's bare `div` still wins.
        card: getComputedStyle(document.querySelector(".doc-card")!).backgroundColor,
        // What the author left alone still comes from the shell.
        h3: getComputedStyle(document.querySelector("h3")!).fontSize,
      }));
      expect(drawn).toEqual({ h2: "rgb(1, 2, 3)", card: "rgb(4, 5, 6)", h3: "16px" });
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the footer's margin rules parse as written: title and count, none on page 1 or a cover", async () => {
    const rules = await pageRules(browser, buildHtmlDocument({ content: "# x", contentType: "markdown", title: "Launch day" }));
    expect(rules).toEqual([
      '* @bottom-left "Launch day"',
      '* @bottom-right counter(page) " / " counter(pages)',
      ":first @bottom-left none",
      ":first @bottom-right none",
      "doc-cover @bottom-left none",
      "doc-cover @bottom-right none",
    ]);
  }, 60_000);

  test("the footer prints: a running title changes page 2 onwards and leaves page 1 alone", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\nA paragraph of text.`).join("\n\n");
    const render = (runningTitle: string | false) =>
      renderer.renderPdf({ html: buildHtmlDocument({ content: long, contentType: "markdown", title: "T", runningTitle }) });
    const titled = pdfPages(await render("Zeta footer"));
    const bare = pdfPages(await render(false));
    expect(titled.length).toBeGreaterThan(1);
    expect(titled.length).toBe(bare.length);
    expect(titled[0].content).toBe(bare[0].content);
    expect(titled[1].content).not.toBe(bare[1].content);
  }, 60_000);

  test("every skeleton renders to A4 pages; the invitation is its cover, then its programme", async () => {
    for (const kind of DOCUMENT_KINDS) {
      const html = buildHtmlDocument({ content: readSkeleton(kind), contentType: kind.format });
      const pdf = await renderer.renderPdf({ html });
      const pages = pdfPages(pdf);
      expect(pages.length).toBe(countPdfPages(pdf));
      for (const page of pages) expect(isA4(page.box)).toBe(true);
      // A cover exactly one page tall used to risk an empty page after it.
      if (kind.name === "invitation") {
        expect(pages).toHaveLength(2);
        expect(drawsText(pages[1].content)).toBe(true);
      }
    }
  }, 120_000);
});
