// #3397: a rendered diagram is one framed content block. Its title and the
// open/share actions share a header row inside the frame, the drawing keeps its
// native width (so a 320px column still fits the authored 320px layout), and
// print strips the frame back to the paper figure.
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { DiagramContent } from "../../../module-diagrams/src/ui.js";
import { BrainUiProvider, createBrainUiRoot, type BrainUiRoot } from "@schlessera/brain-ui-react";
import { CONTROL_RING, ring } from "../../../ui-kit/stories/_stage.js";

let host: HTMLDivElement, render: Root, root: BrainUiRoot, styles: HTMLStyleElement, viewport: { width: number; height: number }, frameViewport: { width: number; height: number };
const originalTheme = document.documentElement.dataset.theme;
const LONG = "Odysseus relays each harbour, muster and ledger to Ithaca"; // the spec's 60-character title maximum
beforeAll(async () => {
  frameViewport = { width: innerWidth, height: innerHeight };
  viewport = await commands.formViewport(1400, 1700); await page.viewport(1340, 1600);
  styles = document.createElement("style"); styles.dataset.diagramCaptureConsumer = ""; styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
});
afterAll(async () => { styles?.remove(); await page.viewport(frameViewport.width, frameViewport.height); await commands.formViewport(viewport.width - 100, viewport.height - 120); });
afterEach(async () => { await commands.mermaidMedia("screen"); if (render) flushSync(() => render.unmount()); root?.dispose(); host?.remove(); document.documentElement.dataset.theme = originalTheme; });

function mount(width: number, theme: "light" | "dark", source: string) {
  document.documentElement.dataset.theme = theme;
  root = createBrainUiRoot({ storage: null, request: async () => Response.json({ renderers: [], enabled: [] }) });
  host = document.createElement("div"); host.style.width = `${width}px`; document.body.append(host); render = createRoot(host);
  flushSync(() => render.render(<BrainUiProvider root={root}><DiagramContent source={source} theme={theme} mode="chat" /></BrainUiProvider>));
}
const parts = () => {
  const figure = host.querySelector<HTMLElement>('figure[data-content-renderer="diagram"]')!;
  const head = figure.querySelector<HTMLElement>(":scope > figcaption.bk-diagram-head")!;
  return {
    figure, head,
    title: head.querySelector<HTMLElement>("[data-diagram-title]")!,
    open: head.querySelector<HTMLButtonElement>('button[aria-label="Open diagram"]')!,
    share: head.querySelector<HTMLButtonElement>('button[aria-label="Share diagram"]')!,
    svg: figure.querySelector<SVGSVGElement>(":scope > svg.bk-diagram"),
  };
};

/** One frame, title left and actions right in the header, nothing overflowing. */
function assertFrame(width: number) {
  const { figure, head, title, open, share, svg } = parts();
  const frame = figure.getBoundingClientRect(), header = head.getBoundingClientRect();
  const style = getComputedStyle(figure);
  expect(style.outlineStyle, "FRAME_EDGE").toBe("solid");
  expect(style.borderTopLeftRadius, "FRAME_RADIUS").toBe("12px");
  expect(figure.querySelectorAll("figure,[data-kit-code-block]"), "NO_NESTED_FRAME").toHaveLength(0);
  if (svg) expect(getComputedStyle(svg.querySelector(".bk-diagram-screen-frame")!).display, "NO_DOUBLED_INNER_BORDER").toBe("none");
  expect(head, "HEADER_IS_FIRST_ROW").toBe(figure.querySelector("figcaption"));
  expect(getComputedStyle(head).borderBottomStyle, "HEADER_RULE").toBe("solid");
  expect(figure.getAttribute("aria-labelledby"), "FIGURE_NAMED_BY_TITLE_ONLY").toBe(title.id);
  const t = title.getBoundingClientRect(), o = open.getBoundingClientRect(), s = share.getBoundingClientRect();
  expect(t.left, "TITLE_LEFT").toBeLessThan(o.left);
  expect(t.right, "TITLE_CLEARS_ACTIONS").toBeLessThanOrEqual(o.left);
  expect(o.right, "OPEN_BEFORE_SHARE").toBeLessThanOrEqual(s.left);
  for (const [name, r] of [["open", o], ["share", s]] as const) {
    expect(r.right, `ACTION_INSIDE_FRAME ${name}`).toBeLessThanOrEqual(frame.right);
    expect(r.top, `ACTION_IN_HEADER ${name}`).toBeGreaterThanOrEqual(header.top);
    expect(r.bottom, `ACTION_IN_HEADER ${name}`).toBeLessThanOrEqual(header.bottom);
    expect(r.height, `ACTION_TARGET ${name}`).toBeGreaterThanOrEqual(matchMedia("(any-pointer: coarse)").matches ? 44 : 28);
  }
  expect(frame.right - s.right, "ACTIONS_HUG_RIGHT").toBeLessThanOrEqual(8);
  expect(host.scrollWidth, "NO_HORIZONTAL_OVERFLOW").toBeLessThanOrEqual(width);
  expect(figure.scrollWidth, "FRAME_NO_OVERFLOW").toBeLessThanOrEqual(figure.clientWidth);
  expect(head.scrollWidth, "HEADER_NO_OVERFLOW").toBeLessThanOrEqual(head.clientWidth);
}

for (const width of [320, 1280]) for (const theme of ["light", "dark"] as const) {
  test(`framed diagram at ${width}px ${theme}: one frame, header title and actions, native drawing`, async () => {
    mount(width, theme, await commands.diagramFixture());
    await expect.poll(() => parts().svg).not.toBeNull(); await document.fonts.ready;
    const { svg, figure } = parts();
    expect(svg!.getAttribute("width"), "NATIVE_LAYOUT_STILL_FITS").toBe(width === 320 ? "320" : "716");
    expect(svg!.getBoundingClientRect().width).toBeLessThanOrEqual(figure.getBoundingClientRect().width);
    assertFrame(width);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/diagram-frame/${theme}-${width}.png` });

    const spec = JSON.parse(await commands.diagramFixture()); spec.title = LONG;
    flushSync(() => render.render(<BrainUiProvider root={root}><DiagramContent source={JSON.stringify(spec)} theme={theme} mode="chat" /></BrainUiProvider>));
    await expect.poll(() => parts().title.textContent).toBe(LONG);
    assertFrame(width);
    if (width === 320) expect(parts().title.getBoundingClientRect().height, "LONG_TITLE_WRAPS").toBeGreaterThan(30);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/diagram-frame/${theme}-${width}-long-title.png` });
  });
}

test("the semantic fallback keeps the same frame and header at 320px", async () => {
  const spec = JSON.parse(await commands.diagramFixture()); delete spec.layouts;
  mount(320, "dark", JSON.stringify(spec));
  await expect.poll(() => host.querySelector("[data-diagram-summary]")).not.toBeNull();
  expect(parts().svg).toBeNull();
  assertFrame(320);
  const summary = host.querySelector<HTMLElement>("[data-diagram-summary]")!, range = document.createRange(); range.selectNodeContents(summary);
  expect(range.getBoundingClientRect().left - parts().figure.getBoundingClientRect().left, "SUMMARY_TEXT_INSET").toBeGreaterThanOrEqual(12);
  await page.screenshot({ element: host, path: "../../.vitest-attachments/diagram-frame/dark-320-fallback.png" });
});

test("header actions are keyboard reachable with visible focus, and open and share behave as before", async () => {
  mount(1280, "light", await commands.diagramFixture());
  await expect.poll(() => parts().svg).not.toBeNull();
  const before = document.createElement("button"); before.textContent = "Before"; host.prepend(before); before.focus();
  await userEvent.keyboard("{Tab}");
  const { open, share } = parts();
  expect(document.activeElement, "TAB_REACHES_OPEN").toBe(open);
  expect(ring(open), "OPEN_FOCUS_RING").toEqual(CONTROL_RING);
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement, "TAB_REACHES_SHARE").toBe(share);
  expect(ring(share), "SHARE_FOCUS_RING").toEqual(CONTROL_RING);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => [...host.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Image (PNG)", "PDF", "Vector (SVG)"]);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => host.querySelector('[role="menu"]')).toBeNull();
  open.focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelector('[aria-label="Diagram viewer"] svg.bk-diagram')).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[aria-label="Diagram viewer"]')).toBeNull();
});

test("print strips the frame and header actions and shows only the paper drawing", async () => {
  mount(1280, "dark", await commands.diagramFixture());
  await expect.poll(() => parts().svg).not.toBeNull();
  await commands.mermaidMedia("print");
  const { figure, head, title, svg } = parts();
  expect(getComputedStyle(figure).outlineStyle, "PRINT_NO_FRAME").toBe("none");
  expect(getComputedStyle(head).borderBottomStyle, "PRINT_NO_HEADER_RULE").toBe("none");
  expect(getComputedStyle(head.querySelector(".bk-diagram-controls")!).display, "PRINT_HIDES_ACTIONS").toBe("none");
  expect(getComputedStyle(title).display, "PRINT_KEEPS_TITLE").not.toBe("none");
  expect(getComputedStyle(svg!).display, "PRINT_HIDES_SCREEN_DRAWING").toBe("none");
  expect(getComputedStyle(figure.querySelector(".bk-diagram-print")!).display, "PRINT_SHOWS_PAPER_DRAWING").toBe("block");
  expect(getComputedStyle(figure.querySelector(".bk-diagram-print svg")!).backgroundColor).toBe("rgb(255, 255, 255)");
});
