import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import type { ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
import { contentRendererConformance } from "@schlessera/brain-ui-sdk/testing";
import { renderMermaidSvg } from "../../src/lib/mermaid.js";
import { mermaidThemeVariables } from "../../src/lib/mermaid-theme.js";
import { staticMermaidSvg } from "../../src/lib/mermaid-svg.js";
import { preRenderBrowserFences } from "../../src/lib/content-renderer-share.js";
import { Suspense } from "react";
import { mermaidContentPack } from "../../src/content-renderers/mermaid.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { MermaidBlock } from "../../src/components/chat/mermaid-block.js";
import { FileViewer } from "../../src/components/files/file-viewer.js";

const source = "graph LR; Troy-->Ithaca";
let host: HTMLDivElement, renderer: Root, root: BrainUiRoot, styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(async () => {
  await commands.mermaidMedia("screen");
  if (renderer) flushSync(() => renderer.unmount());
  root?.dispose(); host?.remove(); defaultContentRendererRegistry.reset();
  document.documentElement.dataset.theme = originalTheme;
});

test("standalone Mermaid is drawn by the built-in content pack in the actual file viewer", async () => {
  document.documentElement.dataset.theme = "light";
  root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  root.stores.ui.setState({ theme: "light" });
  root.stores.file.setState({ currentPath: "notes/voyage.mmd", currentContent: {
    path: "notes/voyage.mmd", kind: "text", content: source, size: source.length,
    mtime: Date.parse("2026-07-12T00:00:00Z"),
  }, contentLoading: false, viewMode: "preview" });
  host = document.createElement("div"); host.style.width = "640px"; document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={root}><FileViewer /></BrainUiProvider>));
  await expect.poll(() => host.querySelector("svg[id^='brain-mermaid-']"), { timeout: 15000 }).not.toBeNull();
  expect(host.querySelector('[data-content-renderer="mermaid"] svg[id^="brain-mermaid-"]'), "MERMAID_FILE_USES_REGISTERED_CONTENT_PACK").not.toBeNull();
  for (const path of ["notes/voyage.mermaid", "notes/Voyage.MMD", "notes/Voyage.MERMAID"]) {
    flushSync(() => root.stores.file.setState({ currentPath: path, currentContent: {
      path, kind: "text", content: source, size: source.length, mtime: Date.parse("2026-07-12T00:00:00Z"),
    } }));
    await expect.poll(() => host.querySelector(`[data-content-renderer="mermaid"][data-renderer-path="${path}"] svg`), {timeout: 15000}).not.toBeNull();
  }
});

test("the real Mermaid client and static entries meet the renderer theme contract", async () => {
  root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  await contentRendererConformance(mermaidContentPack, {
    cases: [source, 'sequenceDiagram\nOdysseus->>Penelope: Return to Ithaca\nPenelope-->>Odysseus: Keep the plan', 'graph TD\nT["<b>Troy</b><br/>Departure"] --> I["Ithaca"]'].map(source => ({renderer: 0, source})),
    async mount(entry, props: ContentRendererProps) {
      host = document.createElement("div"); host.style.width = "640px"; document.body.append(host);
      renderer = createRoot(host);
      const Component = entry.Component;
      flushSync(() => renderer.render(<BrainUiProvider root={root}><Suspense fallback={null}><Component {...props} /></Suspense></BrainUiProvider>));
      await expect.poll(() => host.querySelector("svg[id^='brain-mermaid-']"), { timeout: 15000 }).not.toBeNull();
      return { element: host.querySelector("svg[id^='brain-mermaid-']")!, dispose() { flushSync(() => renderer.unmount()); host.remove(); } };
    },
  });
}, 60000);


test("static labels retain real measured vector text and reject active or external resources", async () => {
  const markup = await renderMermaidSvg('graph TD\nT["<b>Troy</b><br/>Departure"] --> I["Ithaca"]', "print");
  expect(markup).toBeTruthy();
  const output = staticMermaidSvg(markup!, "print");
  const parsed = new DOMParser().parseFromString(output, "image/svg+xml");
  expect(parsed.querySelector("foreignObject,script,image,iframe"), "STATIC_VECTOR_ONLY").toBeNull();
  for (const label of ["Troy", "Departure", "Ithaca"]) expect([...parsed.querySelectorAll("text")].some(t => t.textContent === label), `STATIC_LABEL_${label}`).toBe(true);
  const labels = [...parsed.querySelectorAll("text")];
  expect(labels.find(t => t.textContent === "Troy")?.style.fontWeight, "STATIC_BOLD_LABEL").toBe("700");
  expect(Number(labels.find(t => t.textContent === "Departure")?.getAttribute("y")), "STATIC_MULTILINE_BASELINE").toBeGreaterThan(Number(labels.find(t => t.textContent === "Troy")?.getAttribute("y")));
  for (const injected of ['<script>alert(1)</script>', '<image href="https://example.invalid/raft.png"/>', '<rect onclick="alert(1)"/>', '<style>@import "https://example.invalid/raft.css";</style>']) {
    expect(() => staticMermaidSvg(markup!.replace("</svg>", `${injected}</svg>`), "print"), "STATIC_RESOURCE_REJECTED").toThrow();
  }
  const share = await preRenderBrowserFences("```mermaid\n" + source + "\n```");
  expect(share, "SHARE_USES_PRINT_PACK").toContain("--bk-mermaid-paper:#ffffff");
  expect(share).not.toContain("foreignObject");
});


test("a dark screen diagram switches to opaque paper under actual browser print media", async () => {
  document.documentElement.dataset.theme = "dark";
  root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  root.stores.ui.setState({theme: "dark"});
  host = document.createElement("div"); host.style.width = "640px"; document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={root}><MermaidBlock source={source}/></BrainUiProvider>));
  await expect.poll(() => host.querySelector("[data-mermaid-print] svg"), {timeout: 15000}).not.toBeNull();
  const paper = host.querySelector("[data-mermaid-print]")!;
  const screen = paper.previousElementSibling!;
  expect(getComputedStyle(paper).display, "PRINT_COPY_HIDDEN_ON_SCREEN").toBe("none");
  expect(getComputedStyle(screen).display).not.toBe("none");
  await commands.mermaidMedia("print");
  expect(getComputedStyle(paper).display, "PRINT_COPY_VISIBLE_ON_PAPER").not.toBe("none");
  expect(getComputedStyle(screen).display, "DARK_SCREEN_HIDDEN_ON_PAPER").toBe("none");
  expect(getComputedStyle(paper.querySelector("svg")!).backgroundColor, "BROWSER_PRINT_WHITE_PAPER").toBe("rgb(255, 255, 255)");
});

test("the production static share produces a real opaque PNG and a vector PDF offline", async () => {
  const html = await preRenderBrowserFences("```mmd\n" + source + "\n```");
  const output = await commands.mermaidOutput(html);
  expect(output.requests, "STATIC_EXPORT_NO_EXTERNAL_RESOURCES").toEqual([]);
  expect(output.pdfBytes, "REAL_PDF_BYTES").toBeGreaterThan(1000);
  const image = new Image(); image.src = "data:image/png;base64," + output.png; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
  expect([...context.getImageData(0, 0, 1, 1).data], "PNG_PAPER_WHITE_OPAQUE").toEqual([255,255,255,255]);
  const pixels = context.getImageData(0,0,canvas.width,canvas.height).data;
  let ink = 0; for(let i=0;i<pixels.length;i+=4) if(pixels[i]!<230 && pixels[i+1]!<230 && pixels[i+2]!<230) ink++;
  expect(ink, "PNG_HAS_ACTUAL_VECTOR_LABELS_AND_EDGES").toBeGreaterThan(100);
});


test("screen pixels retain the unchanged upstream Mermaid configuration in light and dark", async () => {
  const mermaid = (await import("mermaid")).default;
  for (const theme of ["light", "dark"] as const) {
    const actual = await renderMermaidSvg(source, theme);
    expect(actual).toBeTruthy();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      theme: "base", themeVariables: mermaidThemeVariables(theme) });
    const before = await mermaid.render(`brain-mermaid-${theme === "light" ? 900001 : 900002}`, source);
    expect(await commands.mermaidScreenComparison(theme, before.svg, actual!), `UNCHANGED_${theme.toUpperCase()}_PIXELS`).toBe(true);
  }
});

test("adopted shared Mermaid cluster borders and white print groups reach actual SVG paint", async () => {
  host = document.createElement("div"); document.body.append(host);
  const clustered = "graph LR\nsubgraph BRAIN[THE BRAIN]\nI[Inbox]-->F[Note filer]\nend";
  for (const theme of ["dark", "print"] as const) {
    host.innerHTML = (await renderMermaidSvg(clustered, theme))!;
    const rect = host.querySelector<SVGRectElement>(".cluster rect")!;
    expect(rect, "REAL_MERMAID_CLUSTER").not.toBeNull();
    const paint = getComputedStyle(rect);
    expect(paint.stroke, `${theme}: ADOPTED_CLUSTER_BORDER`).toBe(theme === "dark" ? "rgb(107, 104, 115)" : "rgb(132, 124, 111)");
    expect(paint.fill, `${theme}: ADOPTED_CLUSTER_GROUND`).toBe(theme === "dark" ? "rgb(12, 14, 18)" : "rgb(255, 255, 255)");
  }
});

import { DIAGRAM_TOKEN_CSS, DIAGRAM_TYPE, fitDiagramText, typeWidthBudget } from "../../../module-diagrams/src/skin.js";
test("generated diagram CSS prints white over explicit dark themes and fits actual font text", async () => {
  document.documentElement.dataset.theme = "dark";
  host = document.createElement("div"); document.body.append(host);
  host.innerHTML = `<style>${DIAGRAM_TOKEN_CSS}</style><svg class="bk-diagram" data-theme="dark" width="320" height="160"><rect width="320" height="160" fill="var(--bk-diagram-cluster)"/><text x="8" y="24" fill="var(--bk-diagram-text)">Homecoming relay</text></svg>`;
  const svg = host.querySelector("svg")!, rect = host.querySelector("rect")!, text = host.querySelector("text")!;
  const style = DIAGRAM_TYPE.name;
  Object.assign(text.style, { fontFamily: style.family, fontWeight: String(style.weight), fontSize: `${fitDiagramText(text.textContent!, "name", 132)}px` });
  await document.fonts.ready;
  expect((await document.fonts.load('600 12px "Plus Jakarta Sans"')).length, "PINNED_KIT_FONT_LOADED").toBeGreaterThan(0);
  for (const label of ["Homecoming relay", "mmmmmmmm", "wwwwwwww", "WWWWWWWW", "iiiillll", "旅程ホーム"]) {
    text.textContent = label;
    text.style.fontSize = `${fitDiagramText(label, "name", 132)}px`;
    await document.fonts.ready;
    expect(text.getBBox().width, `ACTUAL_FONT_WITHIN_SHARED_CHARACTER_BUDGET: ${label}`).toBeLessThanOrEqual(132);
    expect(text.getBBox().width, `ACTUAL_FONT_BELOW_CHARACTER_BUDGET: ${label}`).toBeLessThanOrEqual(typeWidthBudget(label, "name", Number.parseFloat(text.style.fontSize)) + 0.01);
  }
  expect(Number.parseFloat(getComputedStyle(text).fontSize), "REAL_TEXT_FLOOR").toBeGreaterThanOrEqual(9);
  expect(getComputedStyle(rect).fill, "GENERATED_DARK_GROUP").toBe("rgb(12, 14, 18)");
  svg.setAttribute("data-theme", "light");
  expect(getComputedStyle(rect).fill, "EXPLICIT_LIGHT_BEATS_DARK_ANCESTOR").toBe("rgb(236, 231, 220)");
  document.documentElement.dataset.theme = "light";
  svg.setAttribute("data-theme", "dark");
  expect(getComputedStyle(rect).fill, "EXPLICIT_DARK_BEATS_LIGHT_ANCESTOR").toBe("rgb(12, 14, 18)");
  await commands.mermaidMedia("print");
  expect(getComputedStyle(rect).fill, "GENERATED_PRINT_OUTRANKS_EXPLICIT_DARK").toBe("rgb(255, 255, 255)");
  expect(getComputedStyle(text).fill).toBe("rgb(35, 31, 26)");
  expect(getComputedStyle(svg).colorScheme).toBe("light");
});
