import { afterEach, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import Sigma from "sigma";
import type { GraphNodePayload, GraphSubgraphResponse } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import GraphCanvas from "../../src/components/graph/graph-canvas.js";

// Low-ranked neighbors must become painted labels when focus replaces the
// overview, even when unrelated anchors would consume its entire quota.
const makeNode = (id: number, title: string, x: number, y: number, pagerank: number): GraphNodePayload => ({
  id, title, path: `notes/odyssey-${id}.md`, type: "note", inDegree: 0, outDegree: 0, x, y, pagerank,
  distance: id === 1 ? 0 : id < 10 ? 1 : 2,
});
const data: GraphSubgraphResponse = {
  nodes: [
    makeNode(1, "Return to Ithaca", 4, 4, 0.0001),
    makeNode(2, "Athena", 3.3, 3.8, 0.00001),
    makeNode(3, "Circe", 4.7, 4.2, 0.00001),
    ...Array.from({ length: 81 }, (_, i) => makeNode(i + 10, `Day ${i + 1} — the voyage log`, i % 9, Math.floor(i / 9), 0.01)),
  ],
  edges: [{ source: 1, target: 2 }, { source: 3, target: 1 }],
  truncated: false,
};

let react: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement | undefined, scene: Sigma | undefined;
let frame: { width: number; height: number } | undefined, outer: { width: number; height: number } | undefined;
let previousTheme: string | null;

afterEach(async () => {
  if (react) flushSync(() => react!.unmount());
  ui?.dispose();
  host?.remove();
  styles?.remove();
  vi.restoreAllMocks();
  if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", previousTheme);
  if (frame) await page.viewport(frame.width, frame.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  react = undefined; ui = undefined; host = undefined; styles = undefined; scene = undefined;
});

for (const width of [390, 900]) for (const theme of ["light", "dark"] as const) {
  test(`${theme} ${width}: focus paints new neighbor labels and excludes unrelated notes`, async () => {
    frame = { width: innerWidth, height: innerHeight };
    outer = await commands.formViewport(width, 700);
    await page.viewport(width, 700);
    previousTheme = document.documentElement.getAttribute("data-theme");
    document.documentElement.dataset.theme = theme;
    styles = document.createElement("style");
    styles.textContent = await commands.formConsumerStyles();
    document.head.append(styles);
    host = document.createElement("div");
    host.style.cssText = `position:fixed;inset:0;width:${width}px;height:700px`;
    document.body.append(host);
    ui = createBrainUiRoot({ storage: null });
    ui.stores.ui.setState({ theme });
    const refresh = Sigma.prototype.refresh;
    const observe = (renderer: Sigma) => { scene = renderer; };
    vi.spyOn(Sigma.prototype, "refresh").mockImplementation(function (this: Sigma, options) {
      observe(this);
      return refresh.call(this, options);
    });
    react = createRoot(host);
    const render = (selectedId: number | null, hoveredId: number | null) => flushSync(() => react!.render(
      <BrainUiProvider root={ui!}>
        <GraphCanvas data={data} layout="radial" selectedId={selectedId} hoveredId={hoveredId}
          matchIds={new Set()} nodeColor={() => "#257a70"} onSelect={() => {}} onHover={() => {}} />
      </BrainUiProvider>,
    ));
    render(null, null);
    await expect.poll(() => scene?.getGraph().order).toBe(data.nodes.length);
    await expect.poll(() => scene?.getCamera().ratio).toBe(1);

    const painted = new Set<string>();
    const context = scene!.getCanvases().labels!.getContext("2d")!;
    const stroke = vi.spyOn(context, "strokeText");
    const draw = scene!.getSetting("defaultDrawNodeLabel");
    scene!.on("beforeRender", () => painted.clear());
    scene!.setSetting("defaultDrawNodeLabel", (context, node, settings) => {
      const before = stroke.mock.calls.length;
      draw(context, node, settings);
      if (stroke.mock.calls.length > before) painted.add(node.key);
    });
    await expect.poll(() => painted.size).toBeGreaterThan(4);
    expect(painted.has("2")).toBe(false);
    expect(painted.has("3")).toBe(false);

    render(1, null);
    await expect.poll(() => [...painted].sort()).toEqual(["1", "2", "3"]);
    // Hover overrides an unrelated clicked note, including its hover-layer
    // highlight; otherwise its label survives the normal-label suppression.
    render(10, 1);
    await expect.poll(() => [...painted].sort()).toEqual(["1", "2", "3"]);
    expect(scene!.getNodeDisplayData("10")!.highlighted).toBe(false);
    expect(scene!.getNodeDisplayData("10")!.label).toBeFalsy();

    render(null, null);
    await expect.poll(() => painted.size).toBeGreaterThan(4);
    expect(painted.has("2")).toBe(false);
    expect(painted.has("3")).toBe(false);
  });
}
