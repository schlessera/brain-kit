import { afterEach, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import Sigma from "sigma";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import GraphCanvas from "../../src/components/graph/graph-canvas.js";
import { discoveryScenes } from "../fixtures/discovery-scenes.js";
let react: Root | undefined,
  ui: BrainUiRoot | undefined,
  host: HTMLDivElement | undefined,
  style: HTMLStyleElement | undefined,
  renderer: Sigma | undefined;
let viewport: { width: number; height: number },
  outer: { width: number; height: number };
afterEach(async () => {
  if (react) flushSync(() => react!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  vi.restoreAllMocks();
  await page.viewport(viewport.width, viewport.height);
  await commands.formViewport(outer.width - 100, outer.height - 120);
  react = undefined;
  ui = undefined;
  host = undefined;
  style = undefined;
  renderer = undefined;
});
for (const width of [320, 1280])
  test(`${width}: actual Discovery canvas sizing changes marks without moving coordinates`, async () => {
    viewport = { width: innerWidth, height: innerHeight };
    outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    host = document.createElement("div");
    host.style.cssText = `position:fixed;inset:0;width:${width}px;height:800px`;
    document.body.append(host);
    style = document.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    document.head.append(style);
    ui = createBrainUiRoot({ storage: null });
    const observe = (value: Sigma) => {
      renderer = value;
    };
    const refresh = Sigma.prototype.refresh;
    vi.spyOn(Sigma.prototype, "refresh").mockImplementation(function (
      this: Sigma,
      options
    ) {
      observe(this);
      return refresh.call(this, options);
    });
    react = createRoot(host);
    const data = discoveryScenes.dense!;
    const render = (sizeBy: "degree" | "pagerank") =>
      flushSync(() =>
        react!.render(
          <BrainUiProvider root={ui!}>
            <GraphCanvas
              data={data}
              layout="radial"
              sizeBy={sizeBy}
              rings={7}
              selectedId={null}
              hoveredId={null}
              matchIds={new Set()}
              nodeColor={() => "#257a70"}
              onSelect={() => {}}
              onHover={() => {}}
            />
          </BrainUiProvider>
        )
      );
    render("degree");
    await expect.poll(() => renderer?.getGraph().order).toBe(data.nodes.length);
    const points = () =>
      Object.fromEntries(
        renderer!.getGraph().mapNodes((id, a) => [id, [a.x, a.y]])
      );
    const sizes = () => renderer!.getGraph().mapNodes((_id, a) => a.size);
    const before = points(),
      degree = sizes();
    render("pagerank");
    expect(points()).toEqual(before);
    expect(sizes()).not.toEqual(degree);
    render("degree");
    expect(points()).toEqual(before);
    expect(sizes()).toEqual(degree);
  });
