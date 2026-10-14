import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import Sigma from "sigma";
import type { GraphMetaResponse } from "@schlessera/brain-ui-sdk/protocol";
import metaSnapshot from "../fixtures/discovery-odyssey-meta.json";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { discoveryScenes } from "../fixtures/discovery-scenes.js";
import {
  discoveryLayout,
  DISCOVERY_PACKING,
} from "../../src/lib/discovery-layout.js";
import { DISCOVERY_CAPTION } from "../../src/components/graph/discovery-explanation.js";

let react: Root | undefined,
  ui: BrainUiRoot | undefined,
  host: HTMLDivElement | undefined;
let styles: HTMLStyleElement | undefined, renderer: Sigma | undefined;
let frame: { width: number; height: number },
  outer: { width: number; height: number };
let previousTheme: string | null, observer: MutationObserver | undefined;
afterEach(async () => {
  observer?.disconnect();
  if (react) flushSync(() => react!.unmount());
  ui?.dispose();
  host?.remove();
  styles?.remove();
  vi.restoreAllMocks();
  if (previousTheme === null)
    document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", previousTheme);
  await page.viewport(frame.width, frame.height);
  await commands.formViewport(outer.width - 100, outer.height - 120);
  await commands.dictationMotion("reduce");
  react = undefined;
  ui = undefined;
  host = undefined;
  styles = undefined;
  renderer = undefined;
  observer = undefined;
});
const meta = metaSnapshot as GraphMetaResponse;
function coordinates() {
  const out: Record<string, [number, number]> = {};
  renderer!.getGraph().forEachNode((id, a) => {
    out[id] = [a.x as number, a.y as number];
  });
  return out;
}
async function paint() {
  await new Promise<void>((resolve) => {
    renderer!.once("afterRender", resolve);
    renderer!.refresh();
  });
}
function visibleNotice() {
  return [...host!.querySelectorAll<HTMLElement>("div,p")].find(
    (el) =>
      el.children.length === 0 &&
      el.textContent?.includes("Layout updated") &&
      el.getBoundingClientRect().height > 1
  );
}
for (const fixture of Object.keys(discoveryScenes))
  for (const width of [320, 1280, 1440])
    for (const theme of ["dark", "light"] as const)
      for (const motion of ["reduce", "no-preference"] as const) {
        test(`${fixture} ${width} ${theme} ${motion}: Discovery capture and real selection`, async () => {
          let data = discoveryScenes[fixture]!;
          const baseline =
            fixture === "dense" && motion === "reduce" && width !== 1440;
          frame = { width: innerWidth, height: innerHeight };
          outer = await commands.formViewport(width, 800);
          await page.viewport(width, 800);
          await commands.dictationMotion(motion);
          expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
            motion === "reduce"
          );
          previousTheme = document.documentElement.getAttribute("data-theme");
          document.documentElement.dataset.theme = theme;
          styles = document.createElement("style");
          styles.textContent = await commands.formConsumerStyles();
          document.head.append(styles);
          host = document.createElement("div");
          host.style.cssText = `position:fixed;inset:0;display:flex;width:${width}px;height:800px`;
          document.body.append(host);
          ui = createBrainUiRoot({
            storage: null,
            request: async (url) =>
              Response.json(url.endsWith("/meta") ? meta : data),
          });
          ui.stores.ui.setState({ theme });
          ui.stores.graph.setState({ mode: "discovery" });
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
          flushSync(() =>
            react!.render(
              <BrainUiProvider root={ui!}>
                <GraphPage />
              </BrainUiProvider>
            )
          );
          await expect
            .poll(() => renderer?.getGraph().order)
            .toBe(data.nodes.length);
          await paint();
          const expected = discoveryLayout(data.nodes, data.edges),
            original = coordinates();
          for (const [id, p] of expected.positions)
            expect(original[String(id)]).toEqual([p.x, p.y]);
          if (fixture === "dense" || fixture === "mixed") {
            const cross = data.edges.find((e) => {
              const a = expected.positions.get(e.source)!,
                b = expected.positions.get(e.target)!;
              return (
                a.radius > 0 &&
                b.radius > 0 &&
                a.branch !== null &&
                b.branch !== null &&
                a.branch !== b.branch
              );
            });
            expect(cross).toBeDefined();
            expect(
              renderer!
                .getGraph()
                .hasDirectedEdge(String(cross!.source), String(cross!.target))
            ).toBe(true);
          }
          expect(host.scrollWidth).toBeLessThanOrEqual(width);
          if (width < 900) {
            const options = page
              .getByRole("button", { name: "Graph options", exact: true })
              .element();
            const r = options.getBoundingClientRect();
            expect(
              document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest("button")
            ).toBe(options);
          }
          // Save the unmodified real fixture, before selection or changed-data sync.
          await page.screenshot({
            element: host,
            path: `../../../ui-kit/.vitest-attachments/discovery-captures/${fixture}-${theme}-${width}-${motion}.png`,
          });
          if (baseline)
            await expect(page.elementLocator(host)).toMatchScreenshot(
              `discovery-canvas-${theme}-${width}`
            );

          const list = page.getByRole("button", {
            name: "Node list",
            exact: true,
          });
          let tabs = 0;
          while (document.activeElement !== list.element() && tabs++ < 50)
            await userEvent.keyboard("{Tab}");
          expect(document.activeElement).toBe(list.element());
          await userEvent.keyboard("{Enter}");
          await expect
            .element(page.getByRole("navigation", { name: "Graph nodes" }))
            .toBeVisible();
          const nav = host.querySelector('[aria-label="Graph nodes"]')!;
          expect(nav.textContent).toContain("Hop 1");
          const rows = [
            ...nav.querySelectorAll<HTMLButtonElement>("button.bk-row"),
          ];
          expect(rows.length).toBe(data.nodes.length);
          expect(
            rows.every((row) => row.getBoundingClientRect().height >= 44)
          ).toBe(true);
          const explanation = page.elementLocator(
            [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(
              (el) =>
                el.textContent?.includes("How placement works") &&
                el.getBoundingClientRect().height > 0
            )!
          );
          await userEvent.click(explanation);
          expect(document.activeElement).toBe(explanation.element());
          await expect
            .element(
              page.getByText(
                "Adjacent wedges do not necessarily share a link.",
                { exact: false }
              )
            )
            .toBeVisible();
          expect(host.textContent).toContain(DISCOVERY_CAPTION);
          expect(
            explanation.element().getBoundingClientRect().height
          ).toBeGreaterThanOrEqual(width < 900 ? 44 : 24);
          if (baseline)
            await expect(
              page.elementLocator(
                width < 900
                  ? nav
                  : explanation.element().parentElement!.parentElement!
              )
            ).toMatchScreenshot(`discovery-explanation-${theme}-${width}`);
          await userEvent.keyboard("{Enter}");
          expect(document.activeElement).toBe(explanation.element());
          const selected = data.nodes.find((n) => n.distance === 1)!;
          const row = rows.find((row) =>
            row.textContent?.includes(selected.path)
          )!;
          row.focus();
          await userEvent.keyboard("{Enter}");
          expect(ui.stores.graph.getState().selectedId).toBe(selected.id);
          expect(host.textContent).toContain(selected.title);
          expect(
            host.querySelector('[aria-label="Graph nodes"]') !== null
          ).toBe(width >= 1440);
          if (width >= 1440) await userEvent.keyboard("{Escape}");
          else {
            await userEvent.keyboard("{Enter}");
            await expect
              .element(page.getByRole("navigation", { name: "Graph nodes" }))
              .toBeVisible();
            await userEvent.keyboard("{Escape}");
          }
          expect(host.querySelector('[aria-label="Graph nodes"]')).toBeNull();
          expect(document.activeElement).toBe(list.element());
          expect(coordinates()).toEqual(original);

          flushSync(() =>
            ui!.stores.graph.getState().setDiscoveryColorBy("topic")
          );
          ui.stores.ui.setState({ theme: theme === "dark" ? "light" : "dark" });
          expect(coordinates()).toEqual(original);
          ui.stores.ui.setState({ theme });
          const oldWidth = renderer!.getDimensions().width;
          host.style.width = `${width + 20}px`;
          await page.viewport(width + 20, 800);
          await expect
            .poll(() => renderer?.getDimensions().width)
            .toBe(oldWidth + 20);
          expect(coordinates()).toEqual(original);
          host.style.width = `${width}px`;
          await page.viewport(width, 800);
          await expect
            .poll(() => renderer?.getDimensions().width)
            .toBe(oldWidth);
          flushSync(() =>
            ui!.stores.graph.getState().setDiscoveryColorBy("distance")
          );
          renderer!.getCamera().setState({ ratio: 0.6 });
          await paint();
          expect(coordinates()).toEqual(original);
          const focused = document.activeElement;
          ui.stores.graph.clearSceneCache();
          await ui.stores.graph.getState().fetchScene();
          expect(renderer!.getCamera().ratio).toBe(0.6);
          expect(ui.stores.graph.getState().layoutNotice).toBeNull();
          expect(document.activeElement).toBe(focused);

          const status = host.querySelector('[role="status"]')!;
          let announcements = 0;
          observer = new MutationObserver((records) => {
            for (const record of records)
              for (const node of record.addedNodes)
                if (node.textContent === "Layout updated") announcements++;
          });
          observer.observe(status, { childList: true, subtree: true });
          data = {
            ...data,
            nodes: data.nodes.map((n) =>
              n.id === selected.id ? { ...n, community: 99 } : n
            ),
          };
          ui.stores.graph.clearSceneCache();
          await ui.stores.graph.getState().fetchScene();
          await expect
            .element(
              page.getByRole("status").filter({ hasText: "Layout updated" })
            )
            .toHaveTextContent("Layout updated");
          await expect.poll(() => announcements).toBe(1);
          observer.disconnect();
          observer = undefined;
          expect(ui.stores.graph.getState().selectedId).toBe(selected.id);
          expect(document.activeElement).toBe(focused);
          expect(renderer!.getCamera().ratio).toBe(0.6);
          if (baseline) {
            await expect.poll(() => !!visibleNotice()).toBe(true);
            expect(visibleNotice()!.textContent).toContain("Layout updated");
            await expect(
              page.elementLocator(visibleNotice()!)
            ).toMatchScreenshot(`discovery-notice-${theme}-${width}`);
            flushSync(() => ui!.stores.graph.getState().select(null));
            renderer!.getCamera().setState({ ratio: 1 });
            await paint();
            await userEvent.click(list);
            await expect(
              page.getByRole("navigation", { name: "Graph nodes" })
            ).toMatchScreenshot(`discovery-list-${theme}-${width}`);
            await userEvent.keyboard("{Escape}");
          }
          if (fixture === "sparse") {
            flushSync(() => ui!.stores.graph.getState().select(null));
            const root = data.nodes.find((n) => n.distance === 0)!;
            renderer!.getCamera().setState({ ratio: 0.3 });
            await paint();
            const p = renderer!.getGraph().getNodeAttributes(String(root.id));
            const point = renderer!.graphToViewport({
              x: p.x as number,
              y: p.y as number,
            });
            const bounds = renderer!.getContainer().getBoundingClientRect();
            await commands.overlayMouse({
              x: point.x + bounds.x,
              y: point.y + bounds.y,
            });
            await expect
              .poll(() => ui?.stores.graph.getState().selectedId)
              .toBe(root.id);
          }
          console.info(
            "DISCOVERY_CAPTURE",
            JSON.stringify({
              fixture,
              width,
              theme,
              motion,
              nodes: data.nodes.length,
              edges: data.edges.length,
              counts: Object.fromEntries(expected.counts),
              lanes: Object.fromEntries(expected.lanes),
              K: expected.scale,
              constants: DISCOVERY_PACKING,
              caption: DISCOVERY_CAPTION,
            })
          );
          if (baseline) {
            flushSync(() =>
              ui!.stores.graph.setState({ meta: { ...meta, stale: true } })
            );
            await expect
              .element(
                page.getByText("Graph predates the latest index run", {
                  exact: false,
                })
              )
              .toBeVisible();
            data = { ...data, nodes: [], edges: [] };
            ui.stores.graph.clearSceneCache();
            await ui.stores.graph.getState().fetchScene();
            await expect
              .element(page.getByRole("heading", { name: "Nothing to show" }))
              .toBeVisible();
            expect(host.querySelector("canvas")).toBeNull();
          }
        }, 30000);
      }
