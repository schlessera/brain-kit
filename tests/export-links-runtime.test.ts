/** Actual Chrome PDF annotations, rather than predicates about input HTML (#558). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { BLOCKS } from "../packages/ui-react/tests/block-fixtures.ts";
import { renderBlockHtml, shareStyle } from "../packages/ui-react/src/components/chat/share-document.tsx";
import { buildHtmlDocument } from "../packages/render-template/src/template.ts";
import puppeteer, { type ScreenshotOptions } from "puppeteer-core";
import { createRenderer, type Renderer } from "../packages/ui-render-puppeteer/src/renderer.ts";

const chromePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((p) => p && existsSync(p));
if (!chromePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Chrome required for export link policy proof");
let renderer: Renderer;
const observations: { labels: string[]; dnsLabels: { text: string; height: number; lineHeight: number }[]; hidden: number; clipped: number; blocks: { kind: string | undefined; height: number }[]; controls: string[] }[] = [];
const requested: string[] = [];
beforeAll(() => { if (chromePath) renderer = createRenderer({ executablePath: chromePath, noSandbox: true,
  launch: async (args) => {
    const browser = await puppeteer.launch(args);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      page.on("request", (r) => requested.push(r.url()));
      const screenshot = page.screenshot.bind(page);
      page.screenshot = (async (options: ScreenshotOptions = {}) => {
        observations.push(await page.evaluate(() => {
          const labels = [...document.querySelectorAll<HTMLElement>("[data-brain-link-destination]")];
          return { labels: labels.map((el) => el.innerText),
            dnsLabels: labels.flatMap((el) => [...el.querySelectorAll<HTMLElement>(":scope > span")].map((label) => ({ text: label.innerText, height: label.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(label).lineHeight) }))),
            blocks: [...document.querySelectorAll<HTMLElement>("[data-block]")].map((el) => ({ kind: el.dataset.block, height: el.getBoundingClientRect().height })),
            controls: [...document.querySelectorAll<HTMLAnchorElement>("a.bk-control")].map((a) => getComputedStyle(a).display),
            hidden: labels.filter((el) => getComputedStyle(el).display === "none" || getComputedStyle(el).visibility !== "visible" || parseFloat(getComputedStyle(el).opacity) < 1 || parseFloat(getComputedStyle(el).fontSize) < 12).length,
            clipped: labels.filter((el) => { const r = el.getBoundingClientRect(); const b = document.body.getBoundingClientRect(); return r.left < b.left || r.right > b.right + 1 || r.bottom > b.bottom + 1; }).length };
        }));
        return options.encoding === "base64" ? screenshot({ ...options, encoding: "base64" }) : screenshot(options);
      }) as typeof page.screenshot;
      return page;
    };
    return browser;
  },
}); });
afterAll(async () => { await renderer?.shutdown(); });

async function readPdf(bytes: Buffer) {
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await loading.promise;
  try {
    const annotations = []; const text = []; const heights: number[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      annotations.push(...await page.getAnnotations());
      const items = (await page.getTextContent()).items;
      text.push(...items.map((item) => "str" in item ? item.str : ""));
      heights.push(...items.flatMap((item) => "str" in item && item.str.trim() ? [item.height] : []));
    }
    return { annotations, text: text.join(""), heights };
  } finally { await loading.destroy(); }
}

const unsafe = '<a href="https://odysseus:secret@unsafe.example/">Safe-looking label</a>';
const documents = [
  ["fragment", unsafe],
  ["complete", `<!doctype html><html><head><title>Links</title></head><body>${unsafe}</body></html>`],
  ["bare", `<!doctype html><html><head><meta name="brain-render" content="bare"></head><body>${unsafe}</body></html>`],
] as const;

describe.skipIf(!chromePath)("shared exports disclose destinations", () => {
  test.each(documents)("%s has no refused PDF annotation and keeps an accepted useful link", async (_label, content) => {
    const options = { content, contentType: "html" as const, linkPolicy: "visible-destinations" as const };
    const html = buildHtmlDocument(options);
    const renderOptions = { html: html.replace("</body>", '<p><a href="https://ithaca-harbour.example/tides">Tides</a></p></body>'), linkPolicy: "visible-destinations" as const };
    const pdf = await readPdf(await renderer.renderPdf(renderOptions));
    const links = pdf.annotations.filter((a) => a.subtype === "Link");
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((a) => a.unsafeUrl)).not.toContain("https://odysseus:secret@unsafe.example/");
    expect(links.some((a) => a.url === "https://ithaca-harbour.example/tides")).toBe(true);
    expect(pdf.text).toContain("ithaca-harbour.example");
  });
});

const alternateMarkup = `
<base href="https://base.example/">
<h2 id="chapter">Chapter</h2><a href="#chapter">Jump</a>
<a href="notes/log.md">Log</a><a href="file:///notes/log.md">File</a>
<a href="javascript:alert(1)">Script</a><a href="data:text/html,x">Data</a>
<a href="https://ithaca.example/ti&#x202E;des">Hidden</a>
<a href="https://ithaca.example/nu\u0000l">Raw null</a><a href="https://ithaca.example/nu&#0;l">Encoded null</a>
<a href="https://аpple.example/">Mixed script</a>
<a href="mailto:ody%E2%80%AE@ithaca.example">Hidden mail</a>
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="90">
 <a xlink:href="https://odysseus:secret@svg-unsafe.example/"><text x="10" y="25">Refused SVG</text></a>
 <a href="https://svg.example/tides" xlink:href="https://odysseus:secret@ignored.example/">
  <set attributeName="href" to="https://odysseus:secret@animated.example/"/>
  <text x="10" y="55">Accepted SVG</text>
 </a>
</svg>
<div><template shadowrootmode="closed"><a href="https://odysseus:secret@shadow.example/">Refused shadow</a><a href="https://shadow-safe.example/">Accepted shadow</a></template></div>
<iframe srcdoc="&lt;a href=&quot;https://odysseus:secret@frame.example/&quot;&gt;Frame&lt;/a&gt;"></iframe>
<object data="data:text/html,%3Ca%20href%3D%22https%3A%2F%2Fobject.example%2F%22%3EObject%3C%2Fa%3E"></object>
<a href="mailto:odysseus@ithaca.example?bcc=other@example.test&amp;body=private">Write</a>
<a href="https://bücher.example:8443/reading">Library</a>
<img width="1" height="1" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoYAAAAASUVORK5CYII=">
`;

describe.skipIf(!chromePath)("alternate markup and final styled output", () => {
  test("a DNS label that fits a line moves intact instead of splitting beside the words", async () => {
    const html = buildHtmlDocument({ content: '<p><a href="https://ithaca-harbour.example/">Safe-looking words</a> continues.</p>', contentType: "html", linkPolicy: "visible-destinations" });
    observations.length = 0;
    await renderer.renderPng({ html, width: 320, linkPolicy: "visible-destinations" });
    expect(observations).toHaveLength(1);
    const label = observations[0].dnsLabels.find((label) => label.text === "(ithaca-harbour.");
    expect(label).toBeDefined();
    expect(label!.height).toBeLessThanOrEqual(label!.lineHeight + 1);
  });
  test("SVG, shadow content, frames, hidden strings and relative bases leave only accepted actual PDF targets", async () => {
    requested.length = 0;
    const html = buildHtmlDocument({ content: alternateMarkup, contentType: "html", linkPolicy: "visible-destinations" });
    const options = { html, linkPolicy: "visible-destinations" as const };
    expect((await renderer.renderPng(options)).subarray(1, 4).toString()).toBe("PNG");
    const pdf = await readPdf(await renderer.renderPdf(options));
    const links = pdf.annotations.filter((a) => a.subtype === "Link");
    expect(links.length).toBeGreaterThan(0);
    const external = [...new Set(links.map((a) => a.unsafeUrl).filter(Boolean))].sort();
    expect(external).toEqual(["https://shadow-safe.example/", "https://svg.example/tides", "https://xn--bcher-kva.example:8443/reading", "mailto:odysseus@ithaca.example"].sort());
    expect(links.some((a) => a.dest !== undefined)).toBe(true);
    for (const text of ["svg.example", "shadow-safe.example", "odysseus@ithaca.example", "xn--bcher-kva.example:8443", "notes/log.md"]) expect(pdf.text).toContain(text);
    expect(requested.some((url) => url.startsWith("data:image/png"))).toBe(true);
    expect(requested.filter((url) => !url.startsWith("data:") && url !== "about:blank")).toEqual([]);
  });
  test.each([320, 768])("at %d px, supplied CSS cannot hide or clip long destination text in PNG/PDF", async (width) => {
    const host = `${"long-label-".repeat(5)}end.${"another-label-".repeat(4)}end.ithaca.example:8443`;
    const content = `<!doctype html><html><head><meta name="brain-render" content="bare"><style>
      body{font:16px system-ui;margin:16px;max-width:720px}
      .card{width:220px;height:20px;overflow:hidden;clip-path:inset(0 80% 0 0);opacity:.2;-webkit-text-fill-color:transparent;letter-spacing:80px}
      #words{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;width:100px}
      [data-brain-link-destination]{display:none!important;color:transparent!important;font-size:0!important}
      [data-brain-link-destination] span{max-width:1px!important;opacity:0!important}
      #words::after{content:" (false.example)"!important}
      @media print{[data-brain-link-destination]{visibility:hidden!important}}
    </style></head><body><h1>Odysseus — harbour sources</h1><div class="card"><a id="words" href="https://${host}/tides">Harbour source</a></div><p>End.</p></body></html>`;
    const html = buildHtmlDocument({ content, contentType: "html", linkPolicy: "visible-destinations" });
    const options = { html, width, linkPolicy: "visible-destinations" as const };
    observations.length = 0;
    const png = await renderer.renderPng(options);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(observations).toHaveLength(1);
    expect(observations[0].labels.join("").replace(/\s/g, "")).toContain(host);
    expect(observations[0].hidden).toBe(0); expect(observations[0].clipped).toBe(0);
    const pdfBytes = await renderer.renderPdf(options);
    const pdf = await readPdf(pdfBytes);
    expect(pdf.annotations.some((a) => a.url === `https://${host}/tides`)).toBe(true);
    expect(pdf.text.replace(/\s/g, "")).toContain(host);
    expect(pdf.text).not.toContain("false.example");
    const dir = process.env.BRAIN_LINK_POLICY_ARTIFACTS;
    if (dir) { await Bun.write(`${dir}/links-${width}.png`, png); await Bun.write(`${dir}/links-${width}.pdf`, pdfBytes); }
  });
});

describe.skipIf(!chromePath)("export visibility fails closed", () => {
  test("a painted pointer-events:none overlay cannot conceal a live destination", async () => {
    const html = buildHtmlDocument({ content: '<!doctype html><html><head><meta name="brain-render" content="bare"></head><body><a href="https://ithaca.example/">Tides</a><div style="position:fixed;inset:0;background:white;z-index:2147483647;pointer-events:none"></div></body></html>', contentType: "html", linkPolicy: "visible-destinations" });
    await expect(renderer.renderPdf({ html, linkPolicy: "visible-destinations" })).rejects.toThrow("destination is obscured");
  });
});

describe.skipIf(!chromePath)("bounded PNG disclosure", () => {
  test("a destination below the existing bitmap cap refuses PNG rather than silently cropping it", async () => {
    const html = buildHtmlDocument({ content: '<div style="height:9000px"></div><a href="https://ithaca.example/">Tides</a>', contentType: "html", linkPolicy: "visible-destinations" });
    await expect(renderer.renderPng({ html, linkPolicy: "visible-destinations" })).rejects.toThrow("exceeds PNG capture bounds");
  });
});

describe.skipIf(!chromePath)("approved print blocks with export protection", () => {
  test.each([320, 768])("all block kinds keep their layout and link controls at %d px", async (width) => {
    const content = shareStyle() + (await Promise.all(Object.values(BLOCKS).map(renderBlockHtml))).join("\n");
    const html = buildHtmlDocument({ content, contentType: "html", linkPolicy: "visible-destinations" });
    observations.length = 0;
    const png = await renderer.renderPng({ html, width, linkPolicy: "visible-destinations" });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(observations).toHaveLength(1);
    const drawn = observations[0];
    expect(drawn.blocks.length).toBeGreaterThan(0);
    expect(drawn.blocks.map((b) => b.kind)).toEqual(Object.keys(BLOCKS));
    for (const block of drawn.blocks) expect(block.height).toBeGreaterThan(20);
    expect(drawn.controls.length).toBeGreaterThan(0);
    expect(drawn.controls.every((display) => display === "flex" || display === "inline-flex")).toBe(true);
    expect(drawn.hidden).toBe(0); expect(drawn.clipped).toBe(0);
    const pdf = await readPdf(await renderer.renderPdf({ html, width, linkPolicy: "visible-destinations" }));
    const link = BLOCKS.link;
    if (link.kind !== "link") throw new Error("Expected the populated link fixture");
    expect(link.url.length).toBeGreaterThan(0);
    expect(pdf.annotations.some((a) => a.url === link.url)).toBe(true);
    expect(pdf.text).toContain("ithaca-harbour.example");
  });
});

describe.skipIf(!chromePath)("finished PDF disclosure", () => {
  test("custom small pages cannot keep a live annotation after cropping its host", async () => {
    const html = buildHtmlDocument({ content: '<!doctype html><html><head><meta name="brain-render" content="bare"><style>@page{size:80px 80px;margin:0}body{width:600px;font:16px system-ui;margin:8px}</style></head><body><a href="https://ithaca-harbour.example/tides">Safe label</a></body></html>', contentType: "html", linkPolicy: "visible-destinations" });
    await expect(renderer.renderPdf({ html, linkPolicy: "visible-destinations" })).rejects.toThrow("PDF link destination");
  });
  test("print scaling cannot shrink a live destination below the legibility floor", async () => {
    const html = buildHtmlDocument({ content: '<!doctype html><html><head><meta name="brain-render" content="bare"><style>@page{size:A4;margin:0 200px}body{width:720px;font:16px system-ui;margin:8px}</style></head><body><a href="https://ithaca-harbour.example/tides">Safe label</a></body></html>', contentType: "html", linkPolicy: "visible-destinations" });
    await expect(renderer.renderPdf({ html, linkPolicy: "visible-destinations" })).rejects.toThrow("PDF link destination");
  });
  test("host words in author-supplied code cannot stand in for the cropped disclosure", async () => {
    const html = buildHtmlDocument({ content: '<!doctype html><html><head><meta name="brain-render" content="bare"><style>@page{size:320px 300px;margin:0}body{width:2000px;font:32px system-ui;margin:8px}a{display:flex;width:2000px;justify-content:space-between}</style></head><body><a href="https://ithaca-harbour.example/tides"><code>ithaca-harbour.example</code></a></body></html>', contentType: "html", linkPolicy: "visible-destinations" });
    const unchecked = await readPdf(await renderer.renderPdf({ html, width: 4096 }));
    expect(unchecked.text).toContain("ithaca-harbour.example");
    expect(unchecked.annotations.some((a) => a.url === "https://ithaca-harbour.example/tides")).toBe(true);
    expect(unchecked.heights.length).toBeGreaterThan(0);
    expect(Math.min(...unchecked.heights)).toBeGreaterThanOrEqual(8.99);
    await expect(renderer.renderPdf({ html, width: 4096, linkPolicy: "visible-destinations" })).rejects.toThrow("PDF link destination is incomplete");
  });
  test("exact URL words and multiple mail recipients retain useful finished PDF links", async () => {
    const html = buildHtmlDocument({ content: '<p><a href="https://ithaca.example/">https://ithaca.example/</a></p><p><a href="mailto:odysseus@ithaca.example,crew@ithaca.example?subject=Private">Write</a></p>', contentType: "html", linkPolicy: "visible-destinations" });
    const pdf = await readPdf(await renderer.renderPdf({ html, linkPolicy: "visible-destinations" }));
    expect(pdf.annotations.some((a) => a.url === "https://ithaca.example/")).toBe(true);
    expect(pdf.annotations.some((a) => a.unsafeUrl === "mailto:odysseus@ithaca.example,crew@ithaca.example")).toBe(true);
    expect(pdf.text).toContain("odysseus@ithaca.example,crew@ithaca.example");
    expect(pdf.text).not.toContain("Private");
  });
});
