import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { discoveryScenes } from "../fixtures/discovery-scenes.js";
import meta from "../fixtures/discovery-odyssey-meta.json";
let react: Root | undefined,
  ui: BrainUiRoot | undefined,
  host: HTMLDivElement | undefined,
  styles: HTMLStyleElement | undefined;
let frame: { width: number; height: number },
  outer: { width: number; height: number },
  previousTheme: string | null;
let releaseMeta: (() => void) | undefined;
afterEach(async () => {
  releaseMeta?.();
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
  react = undefined;
  ui = undefined;
  host = undefined;
  styles = undefined;
  releaseMeta = undefined;
});
for (const width of [320, 1440])
  test(`DISCOVERY_METADATA_REFRESH_RETAINS_FOCUS ${width}: a selected list row survives metadata refresh and returns focus when removed`, async () => {
    frame = { width: innerWidth, height: innerHeight };
    outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    previousTheme = document.documentElement.getAttribute("data-theme");
    document.documentElement.dataset.theme = "dark";
    styles = document.createElement("style");
    styles.textContent = await commands.formConsumerStyles();
    document.head.append(styles);
    host = document.createElement("div");
    host.style.cssText = `position:fixed;inset:0;display:flex;width:${width}px;height:800px`;
    document.body.append(host);
    let data = discoveryScenes.sparse!,
      gate: Promise<void> | undefined;
    ui = createBrainUiRoot({
      storage: null,
      request: async (url) => {
        if (url.endsWith("/meta")) {
          await gate;
          return Response.json(meta);
        }
        return Response.json(data);
      },
    });
    ui.stores.ui.setState({ theme: "dark" });
    ui.stores.graph.setState({
      mode: "discovery",
      discovery: { root: null, maxDepth: 1 },
    });
    react = createRoot(host);
    flushSync(() =>
      react!.render(
        <BrainUiProvider root={ui!}>
          <GraphPage />
        </BrainUiProvider>
      )
    );
    const list = page.getByRole("button", { name: "Node list", exact: true });
    await expect.element(list).toBeVisible();
    await userEvent.click(list);
    const selected = data.nodes.find((n) => n.distance === 1)!;
    let row = [
      ...host.querySelectorAll<HTMLButtonElement>("button.bk-row"),
    ].find((row) => row.textContent?.includes(selected.path))!;
    row.focus();
    await userEvent.keyboard("{Enter}");
    if (width < 1440) await userEvent.keyboard("{Enter}");
    row = [...host.querySelectorAll<HTMLButtonElement>("button.bk-row")].find(
      (row) => row.textContent?.includes(selected.path)
    )!;
    row.focus();
    gate = new Promise<void>((resolve) => {
      releaseMeta = resolve;
    });
    const pending = ui.stores.graph.getState().fetchMeta(true);
    await page.screenshot({
      element: host,
      path: `../../../ui-kit/.vitest-attachments/discovery-captures/refresh-pending-${width}.png`,
    });
    expect(ui.stores.graph.getState().metaState).toBe("loading");
    expect(host.querySelector('[title="Node list"]')).not.toBeNull();
    expect(document.activeElement).toBe(row);
    releaseMeta!();
    releaseMeta = undefined;
    await pending;
    ui.stores.graph.clearSceneCache();
    await ui.stores.graph.getState().fetchScene();
    expect(ui.stores.graph.getState().selectedId).toBe(selected.id);
    expect(ui.stores.graph.getState().layoutNotice).toBeNull();
    expect(document.activeElement).toBe(row);
    data = {
      ...data,
      nodes: data.nodes.filter((n) => n.id !== selected.id),
      edges: data.edges.filter(
        (e) => e.source !== selected.id && e.target !== selected.id
      ),
      truncated: true,
    };
    ui.stores.graph.clearSceneCache();
    await ui.stores.graph.getState().fetchScene();
    await expect
      .poll(() => document.activeElement === list.element())
      .toBe(true);
    expect(ui.stores.graph.getState().selectedId).toBeNull();
    expect(ui.stores.graph.getState().layoutNotice).toBeNull();
  });
