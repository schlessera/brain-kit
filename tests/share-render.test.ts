/**
 * A shared answer, end to end, in REAL Chrome (#46): the markdown the client
 * composes, the document shell the server wraps it in, and the network-denied,
 * scriptless renderer that draws it. Unit tests of the composer say what is
 * sent; only a real render says what is drawn, and what the page tried to
 * fetch while drawing it.
 *
 * Like the renderer's own runtime tests, whether this runs is a decision:
 * `BRAIN_REQUIRE_CHROME=1`, which CI sets, turns a missing Chrome into a
 * failed file rather than a skipped one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { SHOW_BLOCK_CONTRACT, visibleToolName, type Block } from "@schlessera/brain-ui-sdk/client";
import { PRINT_TOKENS } from "@schlessera/brain-ui-kit";
import { buildHtmlDocument } from "@schlessera/brain-render-template";

import { createRenderer, type Renderer } from "../packages/ui-render-puppeteer/src/renderer.ts";
import { renderBlockHtml, shareMarkdown } from "../packages/ui-react/src/components/chat/share-document.tsx";
import type { ChatMessage } from "../packages/ui-react/src/stores/chat-state.ts";
import { BLOCKS } from "../packages/ui-react/tests/block-fixtures.ts";

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

const SHOW_BLOCK = visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude");
const KINDS = Object.keys(BLOCKS) as Block["kind"][];
const noMermaid = { renderBlock: renderBlockHtml, inlineMermaid: async (md: string) => md };

/**
 * One pixel, inlined the way a shared image is: the renderer may fetch this
 * and nothing else, so it is how the request listener proves it is listening.
 */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** An answer: prose, then every block kind by `show_block`, prose between. */
function answerWithEveryBlock(): ChatMessage {
  const parts: ChatMessage["parts"] = [
    { kind: "text", text: `## The voyage home\n\nEvery block, in order. ![map](${PIXEL})` },
  ];
  const toolCalls: ChatMessage["toolCalls"] = [];
  KINDS.forEach((kind, i) => {
    toolCalls.push({
      id: `s${i}`,
      name: SHOW_BLOCK,
      input: {},
      inputJson: "{}",
      output: JSON.stringify({ block: BLOCKS[kind] }),
      status: "complete",
    } as ChatMessage["toolCalls"][number]);
    parts.push({ kind: "tool", toolIndex: i }, { kind: "text", text: `After the ${kind} block.` });
  });
  return { id: "m", role: "assistant", content: "", parts, toolCalls, isStreaming: false, timestamp: 0 };
}

/** The same shape with no block: plain prose and a table. */
const PLAIN = "## The voyage home\n\nNo blocks here.\n\n| Island | Nights |\n| --- | --- |\n| Aeaea | 365 |\n";
const plainAnswer = (): ChatMessage => ({
  id: "p", role: "assistant", content: PLAIN, parts: [{ kind: "text", text: PLAIN }], toolCalls: [], isStreaming: false, timestamp: 0,
});

const html = async (message: ChatMessage) =>
  buildHtmlDocument({ content: await shareMarkdown(message, noMermaid), contentType: "markdown", title: "Shared" });

/** Every URL any page of the renderer's browser asked for, while it rendered. */
const requested: string[] = [];
let renderer: Renderer;
let inspector: Browser;

beforeAll(async () => {
  if (!chromePath) return;
  renderer = createRenderer({
    renderTimeoutMs: 60_000,
    // The renderer's own launch arguments, unchanged; this only listens.
    launch: async (args) => {
      const browser = await puppeteer.launch(args);
      browser.on("targetcreated", async (target) => {
        const page = await target.page();
        page?.on("request", (request) => void requested.push(request.url()));
      });
      return browser;
    },
  });
  // A separate browser that inspects what the renderer's page would lay out.
  // It runs script (the renderer does not) only to read computed styles, and
  // aborts every request that is not the document or inline data.
  inspector = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
}, 120_000);

afterAll(async () => {
  await renderer?.shutdown();
  await inspector?.close();
});

describe.skipIf(!chromePath)("a shared answer in real Chrome", () => {
  test("renders every block kind as PNG and PDF without a single network request", async () => {
    const document = await html(answerWithEveryBlock());
    requested.length = 0;
    const png = await renderer.renderPng({ html: document });
    const pdf = await renderer.renderPdf({ html: document });

    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // A4, in points, as the renderer asks for.
    expect(pdf.toString("latin1")).toMatch(/\/MediaBox \[0 0 595\.9\d* 841\.9\d*\]/);
    // The listener heard the inlined image, so an empty list cannot pass for "none".
    expect(requested.some((url) => url.startsWith("data:image/png"))).toBe(true);
    expect(requested.filter((url) => !url.startsWith("data:") && url !== "about:blank")).toEqual([]);
  }, 120_000);

  test("draws each block in the print palette: every ground is white, a print mark, or nothing", async () => {
    const page = await inspector.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : r.abort()));
    await page.setViewport({ width: 768, height: 1000 });
    await page.setContent(await html(answerWithEveryBlock()));
    const drawn = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const blocks = [...document.querySelectorAll<HTMLElement>("[data-block]")];
      const inside = blocks.flatMap((b) => [...b.querySelectorAll<HTMLElement>("*")]);
      return {
        canvas: root.getPropertyValue("--bk-color-canvas").trim(),
        ink: root.getPropertyValue("--bk-color-ink").trim(),
        page: getComputedStyle(document.body).backgroundColor,
        kinds: blocks.map((b) => b.dataset.block),
        heights: blocks.map((b) => b.getBoundingClientRect().height),
        grounds: [...new Set(inside.map((el) => getComputedStyle(el).backgroundColor))],
      };
    });
    await page.close();

    expect(drawn.kinds).toEqual(KINDS);
    for (const height of drawn.heights) expect(height).toBeGreaterThan(20);
    expect(drawn.canvas).toBe(PRINT_TOKENS["color-canvas"]);
    expect(drawn.canvas).toBe("#ffffff");
    expect(drawn.ink).toBe(PRINT_TOKENS["color-ink"]);
    expect(drawn.page).toBe("rgb(255, 255, 255)");
    // No wash survives: a background inside a block is transparent or one of
    // the print palette's own opaque values. A light-theme tint would arrive
    // as an rgba() the palette does not have.
    const hexToRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const palette = new Set(Object.values(PRINT_TOKENS).filter((v) => /^#[0-9a-f]{6}$/i.test(v)).map(hexToRgb));
    palette.add("rgba(0, 0, 0, 0)");
    expect(drawn.grounds.length).toBeGreaterThan(2);
    expect(drawn.grounds.filter((ground) => !palette.has(ground))).toEqual([]);
  }, 60_000);

  test("an answer with no block renders byte-identical to sharing before blocks existed", async () => {
    // What `message-share.ts` rendered before #46: the content, as markdown.
    const before = buildHtmlDocument({ content: PLAIN, contentType: "markdown", title: "Shared" });
    const now = await html(plainAnswer());
    expect(now).toBe(before);
    const [a, b] = [await renderer.renderPng({ html: before }), await renderer.renderPng({ html: now })];
    expect(Buffer.compare(a, b)).toBe(0);
  }, 60_000);
});
