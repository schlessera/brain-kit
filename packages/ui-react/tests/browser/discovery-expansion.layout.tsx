import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import Sigma from "sigma";
import type { GraphMetaResponse, GraphSubgraphResponse } from "@schlessera/brain-ui-sdk/protocol";
import snapshot from "../fixtures/discovery-odyssey.json";
import metaSnapshot from "../fixtures/discovery-odyssey-meta.json";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { discoveryLayout } from "../../src/lib/discovery-layout.js";

const full = snapshot as GraphSubgraphResponse;
const originalMeta = metaSnapshot as GraphMetaResponse;
let react: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement | undefined, renderer: Sigma | undefined;
let frame: { width: number; height: number }, outer: { width: number; height: number }, previousTheme: string | null;
let observer: MutationObserver | undefined;
afterEach(async () => {
  observer?.disconnect();
  if (react) flushSync(() => react!.unmount());
  ui?.dispose(); host?.remove(); styles?.remove(); vi.restoreAllMocks();
  if (previousTheme === null) document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", previousTheme);
  await page.viewport(frame.width, frame.height); await commands.formViewport(outer.width - 100, outer.height - 120); await commands.dictationMotion("reduce");
  react = undefined; ui = undefined; host = undefined; styles = undefined; renderer = undefined; observer = undefined;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function atDepth(depth: number, truncated = false): GraphSubgraphResponse {
  const nodes = full.nodes.filter(n => n.distance! <= depth);
  const ids = new Set(nodes.map(n => n.id));
  return { ...full, nodes, edges: full.edges.filter(e => ids.has(e.source) && ids.has(e.target)), truncated };
}
function positions() {
  const out: Record<string, [number, number]> = {};
  renderer!.getGraph().forEachNode((key, n) => { out[key] = [n.x as number, n.y as number]; });
  return out;
}
async function settled() {
  await expect.poll(() => {
    if (!renderer || !ui?.stores.graph.getState().subgraph) return false;
    const expected = discoveryLayout(ui.stores.graph.getState().subgraph!.nodes, ui.stores.graph.getState().subgraph!.edges).positions;
    return renderer.getGraph().order === expected.size && [...expected].every(([id, p]) => {
      const attrs = renderer!.getGraph().getNodeAttributes(String(id));
      return attrs.x === p.x && attrs.y === p.y && attrs.expansionOpacity === 1;
    });
  }).toBe(true);
}
async function mountView(width: number, theme: "dark" | "light", motion: "reduce" | "no-preference", request: (url: URL) => Promise<Response> | Response) {
  frame = { width: innerWidth, height: innerHeight }; outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800); await commands.dictationMotion(motion);
  previousTheme = document.documentElement.getAttribute("data-theme"); document.documentElement.dataset.theme = theme;
  styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
  host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;display:flex;width:${width}px;height:800px`; document.body.append(host);
  ui = createBrainUiRoot({ storage: null, request: url => Promise.resolve(request(new URL(url, "http://localhost"))) });
  ui.stores.ui.setState({ theme });
  ui.stores.graph.setState({ mode: "discovery", discovery: { root: originalMeta.defaultRoot!.path, maxDepth: 1 } });
  const observe = (value: Sigma) => { renderer = value; };
  const refresh = Sigma.prototype.refresh;
  vi.spyOn(Sigma.prototype, "refresh").mockImplementation(function (this: Sigma, options) { observe(this); return refresh.call(this, options); });
  react = createRoot(host);
  flushSync(() => react!.render(<BrainUiProvider root={ui!}><GraphPage /></BrainUiProvider>));
  await settled();
  await document.fonts.ready;
}
async function choose(path: string, width: number) {
  const list = page.getByRole("button", { name: "Node list", exact: true });
  // The established phone card overlaps the pointer trigger (#1919); use its real keyboard path.
  (list.element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}");
  const row = [...host!.querySelectorAll<HTMLButtonElement>('[aria-label="Graph nodes"] button.bk-row')].find(el => el.textContent?.includes(path))!;
  expect(row).toBeDefined(); row.focus(); await userEvent.keyboard("{Enter}");
  if (width >= 900) await userEvent.keyboard("{Escape}");
}
function ownerAt(depth: number, visible: ReadonlySet<number>) {
  return full.nodes.filter(n => n.distance === depth && !n.virtual).map(node => ({ node,
    targets: new Set(full.edges.filter(e => e.source === node.id && !visible.has(e.target) && full.nodes.some(n => n.id === e.target && n.distance! <= depth + 1)).map(e => e.target)),
  })).sort((a, b) => b.targets.size - a.targets.size || a.node.id - b.node.id)[0]!;
}

test("DISCOVERY_MOTION_200MS_GPU: real renderer interpolates, fades pixels and cancels on reset", async () => {
  await mountView(1440, "dark", "no-preference", url => Response.json(url.pathname.endsWith("/meta") ? originalMeta : atDepth(Number(url.searchParams.get("maxDepth")))));
  const base = atDepth(1);
  const owner = ownerAt(1, new Set(base.nodes.map(n => n.id)));
  await choose(owner.node.path, 1440);
  const original = positions();
  const raf = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame")!;
  const cancel = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame")!;
  const now = Object.getOwnPropertyDescriptor(performance, "now");
  const realCancel = cancel.value as typeof cancelAnimationFrame;
  let clock = performance.now(), next = 1_000_000;
  const start = clock;
  const frames = new Map<number, FrameRequestCallback>();
  Object.defineProperty(window, "requestAnimationFrame", { ...raf, value: (callback: FrameRequestCallback) => { const id = ++next; frames.set(id, callback); return id; } });
  Object.defineProperty(window, "cancelAnimationFrame", { ...cancel, value: (id: number) => { if (!frames.delete(id)) realCancel.call(window, id); } });
  Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
  const advance = (elapsed: number) => { clock = start + elapsed; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(clock); };
  const alphaSum = (id: number) => {
    renderer!.refresh();
    const canvas = renderer!.getCanvases().nodes!;
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
    const attrs = renderer!.getGraph().getNodeAttributes(String(id));
    const point = renderer!.graphToViewport({ x: attrs.x as number, y: attrs.y as number });
    const scale = canvas.width / renderer!.getDimensions().width;
    const radius = Math.ceil((attrs.size as number) * scale + 2);
    const side = radius * 2 + 1, pixels = new Uint8Array(side * side * 4);
    gl.readPixels(Math.round(point.x * scale) - radius, canvas.height - Math.round(point.y * scale) - radius, side, side, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels.reduce((sum, value, index) => index % 4 === 3 ? sum + value : sum, 0);
  };
  try {
    await ui!.stores.graph.getState().expandNode(owner.node.path);
    flushSync(() => {});
    await expect.poll(() => renderer!.getGraph().order).toBe(base.nodes.length + owner.targets.size);
    const added = [...owner.targets][0]!;
    expect(alphaSum(added), "new fill and outline start transparent in the actual WebGL buffer").toBe(0);
    advance(100);
    expect(renderer!.getGraph().getNodeAttribute(String(added), "expansionOpacity")).toBeCloseTo(0.5, 6);
    const middle = alphaSum(added);
    expect(middle).toBeGreaterThan(0);
    const target = discoveryLayout(ui!.stores.graph.getState().subgraph!.nodes, ui!.stores.graph.getState().subgraph!.edges).positions;
    const changed = [...target].find(([id, p]) => original[String(id)] && (original[String(id)]![0] !== p.x || original[String(id)]![1] !== p.y))!;
    expect(changed).toBeDefined();
    const midpoint = renderer!.getGraph().getNodeAttributes(String(changed[0]));
    expect(midpoint.x).not.toBe(original[String(changed[0])]![0]);
    advance(200);
    expect(renderer!.getGraph().getNodeAttribute(String(added), "expansionOpacity")).toBe(1);
    expect(alphaSum(added)).toBeGreaterThan(middle);
    for (const [id, point] of target) expect(positions()[String(id)]).toEqual([point.x, point.y]);
    await ui!.stores.graph.getState().resetDiscoveryExpanded(); flushSync(() => {});
    advance(400);
    expect(positions()).toEqual(original);
    expect(ui!.stores.graph.getState().discoveryExpansion.notice).toBeNull();
  } finally {
    frames.clear();
    Object.defineProperty(window, "requestAnimationFrame", raf); Object.defineProperty(window, "cancelAnimationFrame", cancel);
    if (now) Object.defineProperty(performance, "now", now); else delete (performance as Partial<Performance>).now;
  }
});

for (const width of [320, 1440]) for (const theme of ["dark", "light"] as const) {
  test(`${width} ${theme}: sync failure retains the real scene, retry cuts, and late expansion stays discarded`, async () => {
    let meta = originalMeta;
    let failure = false;
    let hold: ReturnType<typeof deferred<GraphSubgraphResponse>> | undefined;
    await mountView(width, theme, "no-preference", async url => {
      if (url.pathname.endsWith("/meta")) return Response.json(meta);
      if (failure) return Response.json({ error: "fixture refresh failed" }, { status: 500 });
      const depth = Number(url.searchParams.get("maxDepth"));
      return Response.json(hold && depth > 2 ? await hold.promise : atDepth(depth));
    });
    const first = ownerAt(1, new Set(atDepth(1).nodes.map(n => n.id)));
    await choose(first.node.path, width);
    await page.getByRole("button", { name: `Expand ${first.node.title || first.node.path}`, exact: true }).click(); await settled();
    const scene = ui!.stores.graph.getState().subgraph!;
    const candidate = scene.nodes.filter(n => n.distance === 2).map(node => ({ node, count: full.edges.filter(e => e.source === node.id && !scene.nodes.some(n => n.id === e.target)).length })).sort((a, b) => b.count - a.count)[0]!;
    expect(candidate.count).toBeGreaterThan(0);
    await choose(candidate.node.path, width);
    hold = deferred<GraphSubgraphResponse>();
    const expand = page.getByRole("button", { name: `Expand ${candidate.node.title || candidate.node.path}`, exact: true });
    (expand.element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}");
    await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.loading.length).toBe(1);
    const previous = ui!.stores.graph.getState().subgraph;
    meta = { ...originalMeta, computedAt: "2026-07-12T05:00:00Z" }; failure = true;
    await ui!.stores.graph.getState().fetchMeta(true); await ui!.stores.graph.getState().fetchScene();
    expect(ui!.stores.graph.getState().subgraph).toBe(previous);
    await expect.element(page.getByText("Could not refresh the graph. Previous graph retained.", { exact: true })).toBeVisible();
    expect(host!.querySelector('[data-discovery-node-details]')).not.toBeNull();
    expect(ui!.stores.graph.getState().discoveryExpansion.intents.length).toBe(2);
    hold.resolve(atDepth(3)); hold = undefined; failure = false;
    await page.getByRole("button", { name: "Refresh and retry", exact: true }).click();
    await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.stale).toBe(false);
    await settled();
    expect(ui!.stores.graph.getState().discoveryExpansion.transition).toBeNull();
    expect(ui!.stores.graph.getState().discoveryExpansion.notice).toBeNull();
    expect(ui!.stores.graph.getState().discoveryExpansion.intents.length).toBe(2);
    expect(ui!.stores.graph.getState().discoveryExpansion.stale).toBe(false);
    expect([...renderer!.getGraph().nodes()].every(id => renderer!.getGraph().getNodeAttribute(id, "expansionOpacity") === 1)).toBe(true);
    await expect(page.elementLocator(host!.querySelector('[data-discovery-expansion-summary]')!)).toMatchScreenshot(`expansion-sync-header-${theme}-${width}`);
    const selected = ui!.stores.graph.getState().selectedId!;
    expect(selected).toBe(candidate.node.id);
    await page.getByRole("button", { name: "Reset expanded, 2 notes expanded", exact: true }).click(); await settled();
    expect(ui!.stores.graph.getState().selectedId).toBeNull();
    expect(document.activeElement).toBe(page.getByRole("button", { name: "Node list", exact: true }).element());
  });
}
for (const width of [320, 1440]) for (const theme of ["dark", "light"] as const) {
  test(`${width} ${theme}: neutral integrity recovery and zero additions use distinct native states`, async () => {
    let kind: "normal" | "integrity" | "zero" = "normal";
    const base = atDepth(1), owner = ownerAt(1, new Set(base.nodes.map(n => n.id)));
    // Independently recompute outgoing BFS after removing this note's links.
    const edges = full.edges.filter(e => e.source !== owner.node.id);
    const root = full.nodes.find(n => n.distance === 0)!;
    const hops = new Map([[root.id, 0]]), queue = [root.id];
    for (const source of queue) for (const e of edges) if (e.source === source && !hops.has(e.target)) { hops.set(e.target, hops.get(source)! + 1); queue.push(e.target); }
    await mountView(width, theme, "reduce", url => {
      if (url.pathname.endsWith("/meta")) return Response.json(originalMeta);
      const depth = Number(url.searchParams.get("maxDepth")), data = atDepth(depth);
      if (kind === "integrity" && depth > 1) return Response.json({ ...data, nodes: data.nodes.filter(n => n.id !== owner.node.id) });
      if (kind === "zero" && depth > 1) {
        const nodes = full.nodes.filter(n => hops.has(n.id) && hops.get(n.id)! <= depth).map(n => ({ ...n, distance: hops.get(n.id)! }));
        const ids = new Set(nodes.map(n => n.id));
        return Response.json({ ...full, nodes, edges: edges.filter(e => ids.has(e.source) && ids.has(e.target)), truncated: false });
      }
      return Response.json(data);
    });
    await choose(owner.node.path, width);
    kind = "integrity";
    const expand = page.getByRole("button", { name: `Expand ${owner.node.title || owner.node.path}`, exact: true });
    await expand.click();
    await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.errors[owner.node.path]?.needsRefresh).toBe(true);
    await expect.element(page.getByText("Could not apply expansion to the current graph; refresh and retry.", { exact: false })).toBeVisible();
    expect(ui!.stores.graph.getState().subgraph!.nodes).toEqual(base.nodes);
    expect(ui!.stores.graph.getState().discoveryExpansion.notice).toBeNull();
    expect(expand.element().getAttribute("aria-disabled")).toBe("true");
    kind = "normal";
    await page.getByRole("button", { name: `Refresh graph before expanding ${owner.node.title || owner.node.path}`, exact: true }).click();
    await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.stale).toBe(false);
    await expect.poll(() => Object.keys(ui!.stores.graph.getState().discoveryExpansion.errors).length).toBe(0);
    await settled();
    expect(ui!.stores.graph.getState().discoveryExpansion.notice).toBeNull();
    await page.getByRole("button", { name: "Reset expanded, 1 note expanded", exact: true }).click(); await settled();
    kind = "zero";
    // Changed response fixtures represent a new sync, not a cache bypass.
    await ui!.stores.graph.getState().fetchMeta(true); await ui!.stores.graph.getState().fetchScene(); await settled();
    await expand.click();
    await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.notice?.text).toBe("No new notes added");
    await settled();
    expect(ui!.stores.graph.getState().subgraph!.nodes.map(n => n.id).sort((a,b) => a-b)).toEqual(base.nodes.map(n => n.id).sort((a,b) => a-b));
    await expect.element(page.getByRole("status")).toHaveTextContent("No new notes added");
    expect(expand.element().getAttribute("aria-disabled")).toBe("true");
    await expect(page.elementLocator(host!.querySelector('[data-discovery-node-details]')!)).toMatchScreenshot(`expansion-zero-${theme}-${width}`);
  });
}

for (const width of [320, 1440]) test(`${width}: depth-eight native action reveals same-hop targets without requesting nine`, async () => {
  const notes = full.nodes.filter(n => !n.virtual).slice(0, 18).map((n, index) => ({ ...n, id: index + 1 }));
  const edges = [ ...Array.from({ length: 8 }, (_, i) => ({ source: i + 1, target: i + 2 })),
    { source: 1, target: 10 }, ...Array.from({ length: 7 }, (_, i) => ({ source: i + 10, target: i + 11 })),
    { source: 9, target: 16 }, { source: 9, target: 17 }, { source: 9, target: 18 } ];
  const hops = new Map([[1, 0]]), queue = [1];
  for (const source of queue) for (const e of edges) if (e.source === source && !hops.has(e.target)) { hops.set(e.target, hops.get(source)! + 1); queue.push(e.target); }
  const requests: number[] = [];
  const read = (depth: number) => {
    const nodes = notes.filter(n => hops.get(n.id)! <= depth).map(n => ({ ...n, distance: hops.get(n.id)! }));
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, edges: edges.filter(e => ids.has(e.source) && ids.has(e.target)), truncated: false };
  };
  await mountView(width, "dark", "reduce", url => {
    if (url.pathname.endsWith("/meta")) return Response.json({ ...originalMeta, defaultRoot: { path: notes[0]!.path, virtual: false } });
    const depth = Number(url.searchParams.get("maxDepth")); requests.push(depth); return Response.json(read(depth));
  });
  ui!.stores.graph.getState().setDiscoveryParams({ root: notes[0]!.path, maxDepth: 7 }); await ui!.stores.graph.getState().fetchScene(); await settled();
  await choose(notes[7]!.path, width);
  await page.getByRole("button", { name: `Expand ${notes[7]!.title || notes[7]!.path}`, exact: true }).click(); await settled();
  await choose(notes[8]!.path, width);
  const expand = page.getByRole("button", { name: `Expand ${notes[8]!.title || notes[8]!.path}, 1 note not shown`, exact: true });
  await expand.click();
  await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.notice?.text).toBe("1 note added · Layout updated"); await settled();
  expect(ui!.stores.graph.getState().subgraph!.nodes.find(n => n.id === 17)?.distance).toBe(8);
  expect(ui!.stores.graph.getState().subgraph!.nodes.some(n => n.id === 18)).toBe(false);
  expect(requests.every(depth => depth <= 8)).toBe(true);
  await expect.element(page.getByText("No more notes within 8 hops of the root", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset expanded, 2 notes expanded", exact: true }).click(); await settled();
  expect(ui!.stores.graph.getState().selectedId).toBeNull();
  expect(document.activeElement).toBe(page.getByRole("button", { name: "Node list", exact: true }).element());
});

for (const fixture of ["sparse", "dense", "truncated", "stale"] as const)
  for (const width of [320, 1440]) for (const theme of ["dark", "light"] as const) for (const motion of ["reduce", "no-preference"] as const) {
    test(`${fixture} ${width} ${theme} ${motion}: native expansion, retry, reset and root invalidation`, async () => {
      frame = { width: innerWidth, height: innerHeight }; outer = await commands.formViewport(width, 800);
      await page.viewport(width, 800); await commands.dictationMotion(motion);
      previousTheme = document.documentElement.getAttribute("data-theme"); document.documentElement.dataset.theme = theme;
      styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
      host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;display:flex;width:${width}px;height:800px`; document.body.append(host);
      const depth = fixture === "dense" ? 4 : 1;
      const base = atDepth(depth, fixture === "truncated");
      const visible = new Set(base.nodes.map(n => n.id));
      const owner = base.nodes.filter(n => n.distance === depth && !n.virtual).map(node => ({ node,
        targets: new Set(full.edges.filter(e => e.source === node.id && !visible.has(e.target) && full.nodes.some(n => n.id === e.target && n.distance! <= depth + 1)).map(e => e.target)),
      })).sort((a, b) => b.targets.size - a.targets.size || a.node.id - b.node.id)[0]!;
      expect(owner.targets.size).toBeGreaterThan(0);
      let pending = deferred<GraphSubgraphResponse>();
      let mode: "hold" | "normal" | "error" = "hold";
      const requests: number[] = [];
      const meta = { ...originalMeta, stale: fixture === "stale" };
      ui = createBrainUiRoot({ storage: null, request: async url => {
        const query = new URL(url, "http://localhost");
        if (query.pathname.endsWith("/meta")) return Response.json(meta);
        const requested = Number(query.searchParams.get("maxDepth")); requests.push(requested);
        if (requested > depth && mode === "error") return Response.json({ error: "fixture request refused" }, { status: 500 });
        return Response.json(requested > depth && mode === "hold" ? await pending.promise : atDepth(requested, fixture === "truncated"));
      } });
      ui.stores.ui.setState({ theme });
      ui.stores.graph.setState({ mode: "discovery", discovery: { root: meta.defaultRoot!.path, maxDepth: depth } });
      const samples: { time: number; coordinates: Record<string, [number, number]>; opacity: number[] }[] = [];
      const observe = (value: Sigma) => { renderer = value; };
      const refresh = Sigma.prototype.refresh;
      vi.spyOn(Sigma.prototype, "refresh").mockImplementation(function (this: Sigma, options) {
        observe(this);
        const result = refresh.call(this, options);
        if (ui?.stores.graph.getState().discoveryExpansion.transition !== null && [...owner.targets].every(id => this.getGraph().hasNode(String(id)))) {
          samples.push({ time: performance.now(), coordinates: positions(), opacity: [...owner.targets].map(id => this.getGraph().getNodeAttribute(String(id), "expansionOpacity") as number) });
        }
        return result;
      });
      react = createRoot(host);
      flushSync(() => react!.render(<BrainUiProvider root={ui!}><GraphPage /></BrainUiProvider>));
      await settled();
      const original = positions();
      const list = page.getByRole("button", { name: "Node list", exact: true });
      await list.click();
      const row = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Graph nodes"] button.bk-row')].find(el => el.textContent?.includes(owner.node.path))!;
      row.focus(); await userEvent.keyboard("{Enter}");
      if (width >= 900) await userEvent.keyboard("{Escape}");
      const expand = page.getByRole("button", { name: `Expand ${owner.node.title || owner.node.path}`, exact: true });
      const expandElement = expand.element() as HTMLElement;
      expect(expandElement.getBoundingClientRect().height).toBeGreaterThanOrEqual(width < 900 ? 44 : 24);
      expect(ui.stores.graph.getState().discoveryExpansionFor(owner.node).count).toBeUndefined();
      const status = host.querySelector('[role="status"]')!;
      const announcements: string[] = [];
      observer = new MutationObserver(records => { for (const record of records) if (record.target === status) for (const node of record.addedNodes) if (node.textContent) announcements.push(node.textContent); });
      observer.observe(status, { childList: true });
      expandElement.focus(); await userEvent.keyboard("{Enter}");
      await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.loading.includes(owner.node.path)).toBe(true);
      expect(document.activeElement).toBe(expandElement);
      expect(expandElement.getAttribute("aria-disabled")).toBe("true");
      expect(host.querySelector(".bk-action-spinner")).not.toBeNull();
      await userEvent.keyboard(" ");
      expect(requests.filter(d => d > depth).length).toBe(1);
      const baseline = fixture === "sparse" && motion === "reduce";
      if (baseline) await expect(page.elementLocator(host.querySelector('[data-discovery-node-details]')!)).toMatchScreenshot(`expansion-card-loading-${theme}-${width}`);
      mode = "normal"; pending.resolve(atDepth(depth + 1, fixture === "truncated"));
      const addedText = `${owner.targets.size} note${owner.targets.size === 1 ? "" : "s"} added · Layout updated`;
      await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.notice?.text).toBe(addedText);
      await settled();
      expect(document.activeElement).toBe(expandElement);
      expect(ui.stores.graph.getState().selectedId).toBe(owner.node.id);
      expect(ui.stores.graph.getState().subgraph!.nodes.length).toBe(base.nodes.length + owner.targets.size);
      expect(announcements).toEqual([addedText]);
      if (motion === "reduce") {
        expect(samples.every(s => s.opacity.every(alpha => alpha === 1)), "reduced motion cuts the new marks").toBe(true);
      } else {
        expect(samples.some(s => s.opacity.every(alpha => alpha === 0)), "the new marks start faded").toBe(true);
        // Intermediate times and WebGL pixels are asserted deterministically by
        // DISCOVERY_MOTION_200MS_GPU; an overloaded native frame may skip them.
        const final = positions();
        const moved = Object.entries(original).some(([key, start]) => final[key] && (final[key]![0] !== start[0] || final[key]![1] !== start[1]));
        if (moved) expect(samples.some(s => Object.entries(original).some(([key, start]) => {
          const point = s.coordinates[key];
          return point && point[0] === start[0] && point[1] === start[1];
        })), "survivors begin at their previous coordinates").toBe(true);
      }
      const reasonId = expandElement.getAttribute("aria-describedby")!;
      expect(reasonId).toBeTruthy();
      const reason = document.getElementById(reasonId)!.textContent!;
      expect(reason).toContain(fixture === "stale" ? "not recomputed" : fixture === "truncated" ? "scene limited" : "already shown");
      if (fixture === "truncated" || fixture === "stale") expect(reason).not.toContain("already shown");
      expect(host.scrollWidth).toBeLessThanOrEqual(width);
      if (baseline) {
        await expect(page.elementLocator(host.querySelector('[data-discovery-node-details]')!)).toMatchScreenshot(`expansion-card-result-${theme}-${width}`);
        await expect(page.elementLocator(host.querySelector('[data-discovery-expansion-summary]')!)).toMatchScreenshot(`expansion-header-${theme}-${width}`);
        const notice = [...host.querySelectorAll<HTMLElement>("div,p")].find(el => el.children.length === 0 && el.textContent?.includes(addedText) && el.getBoundingClientRect().width > 10)!;
        await expect(page.elementLocator(notice)).toMatchScreenshot(`expansion-notice-${theme}-${width}`);
        await page.screenshot({ element: host, path: `../../../ui-kit/.vitest-attachments/discovery-expansion/${fixture}-${theme}-${width}-${motion}.png` });
      }
      const reset = page.getByRole("button", { name: "Reset expanded, 1 note expanded", exact: true });
      expect(reset.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(width < 900 ? 44 : 24);
      await reset.click(); await settled();
      expect(ui.stores.graph.getState().discoveryExpansion.intents).toEqual([]);
      expect(ui.stores.graph.getState().discoveryExpansion.transition).toBeNull();
      expect(document.activeElement).toBe(list.element());
      expect(positions()).toEqual(original);
      await expect.poll(() => announcements.at(-1)).toBe("Layout updated");
      const afterResetAnnouncements = announcements.length;
      ui.stores.graph.clearSceneCache(); mode = "error";
      expandElement.focus(); await userEvent.keyboard("{Enter}");
      await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.errors[owner.node.path]?.message).toBe("Couldn't load more links.");
      expect(announcements.length).toBe(afterResetAnnouncements);
      expect(positions()).toEqual(original);
      if (baseline) await expect(page.elementLocator(host.querySelector('[data-discovery-node-details]')!)).toMatchScreenshot(`expansion-card-error-${theme}-${width}`);
      mode = "normal";
      await page.getByRole("button", { name: `Retry expanding ${owner.node.title || owner.node.path}`, exact: true }).click();
      await settled();
      expect(document.activeElement).toBe(expandElement);
      await expect.poll(() => announcements.filter(text => text.includes("notes added") || text.includes("note added")).length).toBe(2);
      await page.getByRole("button", { name: "Reset expanded, 1 note expanded", exact: true }).click();
      await settled();
      ui.stores.graph.clearSceneCache(); pending = deferred<GraphSubgraphResponse>(); mode = "hold";
      expandElement.focus(); await userEvent.keyboard("{Enter}");
      await expect.poll(() => ui!.stores.graph.getState().discoveryExpansion.loading.length).toBe(1);
      if (width < 900) await page.getByRole("button", { name: "Graph options", exact: true }).click();
      await page.getByRole("button", { name: "Reset to default root", exact: true }).click();
      pending.resolve(atDepth(depth + 1, fixture === "truncated")); mode = "normal";
      await expect.poll(() => ui!.stores.graph.getState().dataState).toBe("done");
      expect(ui.stores.graph.getState().discoveryExpansion.intents).toEqual([]);
      expect(ui.stores.graph.getState().discoveryExpansion.notice).toBeNull();
      expect(ui.stores.graph.getState().subgraph!.nodes.length).toBe(base.nodes.length);
      expect(announcements.filter(text => text.includes("notes added") || text.includes("note added")).length).toBe(2);
    });
  }
