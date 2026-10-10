import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import type { GraphMode } from "../../src/stores/graph-state.js";

const modes: GraphMode[] = ["clusters", "discovery", "local", "maintenance"];
const title = "Graph unavailable on this server";
const paragraphs = [
  "This server can't read the graph: the @schlessera/brain package it needs is missing or a version it doesn't support. Your notes are not affected.",
  "If you run this server, install @schlessera/brain at the same version as @schlessera/brain-ui-server, then restart it.",
];
const meta = {
  available: true, schemaVersion: 8, computedAt: "2026-07-12T00:00:00Z", stale: false,
  nodeCount: 2, edgeCount: 1, communities: [], defaultRoot: { path: "projects/return-to-ithaca.md", virtual: false },
};
let react: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement | undefined;
let frame: { width: number; height: number } | undefined, outer: { width: number; height: number } | undefined;
let previousTheme: string | null;
afterEach(async () => {
  if (react) flushSync(() => react!.unmount());
  ui?.dispose(); host?.remove(); styles?.remove();
  if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", previousTheme);
  if (frame) await page.viewport(frame.width, frame.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  react = undefined; ui = undefined; host = undefined; styles = undefined;
});

async function mount(width: number, theme: "light" | "dark", mode: GraphMode, failure: "meta" | "scene" | "unsupported") {
  frame = { width: innerWidth, height: innerHeight };
  outer = await commands.formViewport(width, 760);
  await page.viewport(width, 760);
  previousTheme = document.documentElement.getAttribute("data-theme");
  document.documentElement.dataset.theme = theme;
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;display:flex;width:${width}px;height:760px`;
  document.body.append(host);
  const calls: string[] = [];
  ui = createBrainUiRoot({ storage: null, request: async url => {
    calls.push(url);
    if (failure === "scene" && url.endsWith("/meta")) return Response.json(meta);
    if (failure === "unsupported") return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ error: "graph_unavailable", reason: "core_unavailable" }, { status: 503 });
  } });
  ui.stores.ui.setState({ theme });
  ui.stores.graph.setState({ mode, local: { center: "projects/return-to-ithaca.md", depth: 1, direction: "both" } });
  react = createRoot(host);
  flushSync(() => react!.render(<BrainUiProvider root={ui!}><GraphPage /></BrainUiProvider>));
  return calls;
}

function assertCard(width: number) {
  const heading = host!.querySelector("h2")!;
  expect(heading.textContent).toBe(title);
  const body = heading.nextElementSibling!;
  expect([...body.querySelectorAll("p")].map(p => p.textContent)).toEqual(paragraphs);
  expect(body.textContent).not.toContain("brain sync");
  expect(body.textContent).not.toContain("Local mode");
  const card = heading.parentElement!;
  const bounds = card.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(200);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.bottom).toBeLessThanOrEqual(760);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  for (const code of body.querySelectorAll("code")) {
    expect(getComputedStyle(code).whiteSpace).toBe("nowrap");
    const range = document.createRange(); range.selectNodeContents(code);
    expect(range.getClientRects().length).toBe(1);
    expect(code.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right - 20);
  }
  expect(host!.querySelector('[aria-label="Selected node"]')).toBeNull();
  expect(host!.querySelector("canvas")).toBeNull();
  if (width >= 1280) {
    const column = host!.querySelector('[aria-label="Graph controls"]')!;
    expect([...column.querySelectorAll('[role="tab"]')].map(b => b.textContent)).toEqual(["Clusters", "Discovery", "Local", "Maintenance"]);
    expect(column.querySelectorAll("input, select").length).toBe(0);
    expect(column.textContent).not.toContain("Mark stale");
    expect(column.textContent).not.toContain("Untrusted only");
  }
}

for (const width of [320, 1280, 1440]) for (const theme of ["light", "dark"] as const) {
  for (const mode of modes) for (const failure of ["meta", "scene"] as const) {
    if (width === 1440 && (mode !== "clusters" || failure !== "meta")) continue;
    test(`${width} ${theme} ${mode}: ${failure} core failure shows the approved card`, async () => {
      const calls = await mount(width, theme, mode, failure);
      await expect.poll(() => host?.querySelector("h2")?.textContent).toBe(title);
      assertCard(width);
      expect(calls.filter(url => url.includes("/graph/")).length).toBe(failure === "meta" ? 1 : 2);
      const next = mode === "local" ? "Clusters" : "Local";
      await userEvent.click(page.getByRole(width >= 1280 ? "tab" : "button", { name: next, exact: true }));
      await expect.poll(() => ui!.stores.graph.getState().mode).toBe(next.toLowerCase());
      assertCard(width);
      expect(calls.filter(url => url.includes("/graph/")).length).toBe(failure === "meta" ? 1 : 2);
    });
  }
  test(`${width} ${theme}: Server too old keeps only the enabled modes`, async () => {
    const calls = await mount(width, theme, "clusters", "unsupported");
    await expect.poll(() => host?.querySelector("h2")?.textContent).toBe("Server too old");
    await userEvent.click(page.getByRole(width >= 1280 ? "tab" : "button", { name: "Local", exact: true }));
    await expect.poll(() => ui!.stores.graph.getState().mode).toBe("local");
    expect(host!.querySelector("h2")!.textContent).toBe("Server too old");
    expect(calls).toEqual(["/api/graph/meta"]);
    expect(host!.querySelector('[aria-label="Selected node"]')).toBeNull();
    if (width >= 1280) expect(host!.querySelector('[aria-label="Graph controls"]')!.querySelectorAll("input, select").length).toBe(0);
  });
}
