import { expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ViewerToolbar } from "../../src/components/files/file-viewer-frame.js";
import { FilePanel } from "../../src/components/files/file-panel.js";
import { ControlsBody, GraphControls } from "../../src/components/graph/graph-controls.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { MaintenanceBody } from "../../src/components/graph/graph-maintenance.js";
import { DiscoveryStart, SceneBody } from "../../src/components/graph/graph-scene.js";
import { ThemeToggle } from "../../src/components/layout/theme.js";
import { SlidePanel } from "../../src/components/layout/slide-panel.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import { DictationSheet } from "../../src/components/voice/dictation-sheet.js";
import { ReviewCard } from "../../src/components/voice/review-card.js";

const noop = () => {};
const galleryNames = ["Reveal in tree", "Copy path", "Discard", "Edit", "Append more voice", "Send", "Clear search", "Reset to default root", "Return to Ithaca voyage/return.md"];
async function mount(ctx: TestContext, width: number, theme: string) {
  const viewport = { width: innerWidth, height: innerHeight };
  const beforeTheme = document.documentElement.dataset.theme;
  const beforeUrl = location.href;
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  document.documentElement.dataset.theme = theme;
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles();
  style.textContent += "\n*,*::before,*::after{animation:none!important;transition:none!important}";
  document.head.append(style);
  const host = document.createElement("div"); host.style.cssText = "width:100%;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({ results: [{ path: "voyage/return.md", title: "Return to Ithaca" }], warnings: [] }) });
  ui.stores.graph.setState({ mode: "discovery", sceneQuery: "Ithaca", discovery: { root: "voyage/return.md", maxDepth: 4 }, meta: { available: true, schemaVersion: 8, computedAt: "2026-07-12", stale: false, nodeCount: 1, edgeCount: 0, communities: [], defaultRoot: { path: "AGENTS.md", virtual: true } } });
  const react = createRoot(host);
  const draw = (children: ReactNode) => flushSync(() => react.render(<BrainUiProvider root={ui}>{children}</BrainUiProvider>));
  ctx.onTestFinished(async () => {
    flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
    history.replaceState(null, "", beforeUrl);
    if (beforeTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = beforeTheme;
    await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  const find = (name: string) => page.getByRole("button", { name, exact: true });
  const actions = { reveal: vi.fn(), copy: vi.fn(), discard: vi.fn(), edit: vi.fn(), append: vi.fn(), send: vi.fn(), close: vi.fn() };
  const review = <ReviewCard text="Odysseus reviews the return to Ithaca." onDiscard={actions.discard} onEdit={actions.edit} onAppend={actions.append} onSend={actions.send} />;
  const gallery = async () => {
    draw(<>
      <ViewerToolbar fileName="return.md" fullPath="voyage/return.md" mode="preview" previewAvailable={false} copied={false} share={null} onMode={noop} onCopyPath={actions.copy} onReveal={actions.reveal} />
      {review}<ControlsBody /><ThemeToggle /><div style={{ position: "relative" }}><DiscoveryStart /></div>
    </>);
    await expect.poll(() => host.textContent?.includes("Return to Ithaca")).toBe(true);
  };
  return { host, ui, draw, find, actions, review, gallery };
}
async function ring(el: HTMLElement) {
  el.scrollIntoView({ block: "center" }); el.focus();
  await userEvent.keyboard("{ArrowRight}");
  const css = getComputedStyle(el);
  return document.activeElement === el && css.outlineStyle === "solid" && css.outlineWidth === "2px" && css.outlineColor !== "rgba(0, 0, 0, 0)";
}
function target(el: HTMLElement, pointer: string) {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const floor = el.matches('.bk-icon-btn[data-size="sm"]') && pointer === "fine" ? 28 : 44;
  const hit = [r.left + 2, r.right - 2].every(x => el.contains(document.elementFromPoint(x, r.top + r.height / 2)));
  return r.height >= floor && r.width > 0 && (!el.classList.contains("bk-icon-btn") || r.width >= floor) && hit;
}
/** Runs against the real consumer CSS under each native pointer and both themes. */
export function remainingButtonCases(pointer: () => "fine" | "coarse" | "mixed") {
  for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
    const prefix = `batch5 ${width} ${theme}`;
    test(`${prefix} names`, async ctx => {
      pointer(); const s = await mount(ctx, width, theme); await s.gallery();
      expect(galleryNames.map(name => s.find(name).query() !== null), "batch5 stable accessible names").toEqual(Array(9).fill(true));
    });
    test(`${prefix} target reach`, async ctx => {
      const mode = pointer(); const s = await mount(ctx, width, theme); await s.gallery();
      expect(galleryNames.map(name => target(s.find(name).element() as HTMLElement, mode)), "batch5 controls meet pointer target and side reach").toEqual(Array(9).fill(true));
    });
    test(`${prefix} focus rings`, async ctx => {
      pointer(); const s = await mount(ctx, width, theme); await s.gallery();
      const rings = [];
      for (const name of galleryNames) rings.push(await ring(s.find(name).element() as HTMLElement));
      // Include the raw selection controls, whose row focus interaction is new.
      for (const el of page.getByRole("radio").elements()) rings.push(await ring(el as HTMLElement));
      expect(rings, "batch5 controls and raw selections have visible keyboard rings").toEqual(Array(12).fill(true));
    });
    test(`${prefix} review decision bar fits and activates`, async ctx => {
      pointer(); const s = await mount(ctx, width, theme); s.draw(s.review);
      const names = galleryNames.slice(2, 6);
      const buttons = names.map(name => s.find(name).element() as HTMLElement);
      const boxes = buttons.map(el => el.getBoundingClientRect());
      const fit = buttons.map((el, i) => boxes[i]!.left >= 0 && boxes[i]!.right <= width && boxes[i]!.height >= 44 && el.scrollWidth <= el.clientWidth);
      const send = boxes[3]!;
      const reference = buttons[3]!.cloneNode(true) as HTMLElement;
      reference.style.cssText += ";position:fixed;visibility:hidden;width:max-content";
      document.body.append(reference);
      fit.push(send.width === reference.getBoundingClientRect().width);
      reference.remove();
      fit.push(boxes.slice(0, 3).every(r => r.right <= send.left));
      fit.push(width !== 320 || boxes[2]!.top > boxes[0]!.top);
      expect(fit, "review quiet actions wrap before Send shrinks and remain contained").toEqual(Array(7).fill(true));
      for (const el of buttons) { el.focus(); await userEvent.keyboard("{Enter}"); await userEvent.keyboard(" "); }
      expect([s.actions.discard, s.actions.edit, s.actions.append, s.actions.send].map(fn => fn.mock.calls.length), "review Enter and Space each activate once").toEqual([2, 2, 2, 2]);
      if (width === 320) await page.screenshot({ element: s.host, path: `../../.vitest-attachments/batch5/review-${theme}-${pointer()}.png` });
    });
    test(`${prefix} gallery actions`, async ctx => {
      pointer(); const s = await mount(ctx, width, theme); await s.gallery();
      for (const name of ["Reveal in tree", "Copy path"]) {
        const el = s.find(name).element() as HTMLElement; el.focus();
        await userEvent.keyboard("{Enter}"); await userEvent.keyboard(" ");
      }
      expect([s.actions.reveal.mock.calls.length, s.actions.copy.mock.calls.length], "toolbar native Enter and Space activate once each").toEqual([2, 2]);
      await s.find("Clear search").click();
      expect(s.ui.stores.graph.getState().sceneQuery, "graph clear empties the query").toBe("");
      const roots = [];
      for (const key of ["{Enter}", " "]) {
        s.ui.stores.graph.setState({ discovery: { root: null, maxDepth: 4 } });
        (s.find(galleryNames.at(-1)!).element() as HTMLElement).focus(); await userEvent.keyboard(key);
        roots.push(s.ui.stores.graph.getState().discovery.root);
      }
      expect(roots, "candidate ListRow selects a root with Enter and Space").toEqual(["voyage/return.md", "voyage/return.md"]);
    });
    test(`${prefix} overlay close slots`, async ctx => {
      const mode = pointer(); const s = await mount(ctx, width, theme);
      const targets: boolean[] = [], rings: boolean[] = [], native: boolean[] = [];
      const inspect = async (name: string) => {
        const close = s.find(name);
        expect(close.query(), "overlay close slot accessible name").not.toBeNull();
        const el = close.element() as HTMLElement;
        targets.push(target(el, mode)); rings.push(await ring(el));
        native.push(el.tagName === "BUTTON" && el.dataset.size === "md" && el.dataset.tone === "mute");
        await userEvent.keyboard("{Enter}");
      };
      s.draw(<SlidePanel open title="Voyage" onClose={s.actions.close}><p>Odysseus reviews the mast.</p></SlidePanel>);
      await inspect("Close Voyage");
      s.ui.stores.file.setState({ dirCache: { "": [] }, currentPath: null });
      // Files uses its kit close slot below the panes breakpoint.
      if (width < 900) { s.draw(<FilePanel open onClose={s.actions.close} />); await inspect("Close Files"); }
      s.draw(<ZoomViewer onClose={s.actions.close}><div style={{ width: 240, height: 160 }}>Raft plan</div></ZoomViewer>);
      await inspect("Close");
      s.draw(<div style={{ position: "fixed", bottom: 20, width: Math.min(width, 720) }}><DictationSheet open onCancel={s.actions.close} onStop={noop} /></div>);
      await inspect("Cancel dictation");
      const count = width < 900 ? 4 : 3;
      expect(targets, "overlay close slots retain 44px targets and reach").toEqual(Array(count).fill(true));
      expect(rings, "overlay close slots show keyboard focus rings").toEqual(Array(count).fill(true));
      expect(native, "overlay close slots are native md mute IconButtons").toEqual(Array(count).fill(true));
      expect(s.actions.close.mock.calls.length, "each close slot activates the owner").toBe(count);
    });
    test(`${prefix} search and viewer controls`, async ctx => {
      const mode = pointer(); const s = await mount(ctx, width, theme);
      s.draw(<SearchPanel open onClose={s.actions.close} />);
      await page.getByRole("textbox").fill("Ithaca");
      const clear = s.find("Clear search").element() as HTMLElement;
      const targets = [target(clear, mode)]; const rings = [await ring(clear)];
      await s.find("Clear search").click();
      const input = page.getByRole("textbox").element() as HTMLInputElement;
      expect([input.value, document.activeElement === input], "search clear empties and refocuses input").toEqual(["", true]);
      const close = s.find("Close").element() as HTMLElement;
      targets.push(target(close, mode)); rings.push(await ring(close));
      await s.find("Close").click();
      s.draw(<ZoomViewer onClose={s.actions.close}><div style={{ width: 400, height: 300 }}>Raft plan</div></ZoomViewer>);
      for (const name of ["Zoom out", "Zoom in", "Fit to screen"]) {
        const el = s.find(name).element() as HTMLElement;
        targets.push(target(el, mode)); rings.push(await ring(el));
      }
      expect(targets, "search and viewer controls retain pointer targets").toEqual(Array(5).fill(true));
      expect(rings, "search and viewer controls have visible rings").toEqual(Array(5).fill(true));
    });
  }
  for (const theme of ["dark", "light"]) test(`batch5 320 ${theme} file strip and picker`, async ctx => {
    const mode = pointer(); const s = await mount(ctx, 320, theme);
    s.ui.stores.file.setState({ dirCache: { "": [] }, currentPath: "voyage/return.md", treeExpanded: false });
    s.draw(<FilePanel open onClose={noop} />);
    const show = s.find("Show tree").element() as HTMLElement;
    const close = s.find("Close file").element() as HTMLElement;
    expect([target(show, mode), target(close, mode), await ring(show), await ring(close)], "file strip actions have 44px targets and focus rings").toEqual([true, true, true, true]);
    await s.find("Show tree").click();
    expect([s.ui.stores.file.getState().treeExpanded, s.find("Hide tree").element().getAttribute("aria-expanded")], "file tree toggle publishes its expanded state").toEqual([true, "true"]);
    await s.find("Close file").click();
    expect(s.ui.stores.file.getState().currentPath, "close file clears the open file").toBeNull();
    s.ui.stores.graph.setState({ discovery: { root: "voyage/other.md", maxDepth: 4 } });
    s.draw(<ControlsBody />);
    const picker = page.getByRole("textbox").elements()[1] as HTMLInputElement;
    await userEvent.click(picker); await userEvent.fill(picker, "Ithaca");
    const result = s.find("Return to Ithaca voyage/return.md");
    await expect.element(result).toBeVisible();
    expect(await ring(result.element() as HTMLElement), "raw picker row has an inset focus ring").toBe(true);
    // A keyboard focus proof blurs the combobox and deliberately closes its
    // results after 150ms. Use a fresh interaction for the pointer proof.
    s.draw(<ControlsBody key="pointer" />);
    const pointerPicker = page.getByRole("textbox").elements()[1] as HTMLInputElement;
    await userEvent.click(pointerPicker); await userEvent.fill(pointerPicker, "Ithaca");
    await expect.element(result).toBeVisible();
    await userEvent.click(result);
    expect([s.ui.stores.graph.getState().discovery.root, document.activeElement === pointerPicker], "picker pointer selection chooses the note and keeps field focus").toEqual(["voyage/return.md", true]);
  });
  for (const theme of ["dark", "light"]) test(`batch5 320 ${theme} graph row interaction`, async ctx => {
    const mode = pointer(); const s = await mount(ctx, 320, theme);
    const node = { id: 1, path: "voyage/return.md", title: "Return to Ithaca", type: "note", inDegree: 1, outDegree: 0, community: 0, x: 0, y: 0 };
    s.ui.stores.graph.setState({ mode: "clusters", clusters: { community: 0, isolates: false }, subgraph: { nodes: [node], edges: [], truncated: false },
      meta: { available: true, schemaVersion: 8, computedAt: "2026-07-12", stale: false, nodeCount: 4, edgeCount: 1, communities: [{ community: 0, size: 4, label: "Fleet", topTerms: ["Fleet"] }], defaultRoot: null } });
    s.draw(<div style={{ position: "relative", height: 500 }}><SceneBody /></div>);
    const topic = page.getByRole("button", { name: "Fleet 4", exact: true });
    const rows = [await ring(s.find("Topics").element() as HTMLElement), await ring(topic.element() as HTMLElement)];
    const filter = s.find("Clear topic filter").element() as HTMLElement;
    const actions = [target(filter, mode), await ring(filter)];
    await s.find("Node list").click();
    const close = s.find("Close list").element() as HTMLElement;
    actions.push(target(close, mode), await ring(close));
    rows.push(await ring(page.getByRole("button", { name: "Return to Ithaca 1 link · voyage/return.md", exact: true }).element() as HTMLElement));
    s.ui.stores.graph.setState({ findings: { orphans: [node], unreachable: [], brokenLinks: [], stale: [], staleDays: 180 }, dataState: "done" });
    s.draw(<MaintenanceBody />);
    rows.push(await ring(page.getByRole("button", { name: "Return to Ithaca voyage/return.md", exact: true }).element() as HTMLElement));
    s.ui.stores.graph.setState({ fetchMeta: async () => {}, fetchScene: async () => {}, mode: "clusters", metaState: "done" });
    s.draw(<GraphPage />);
    rows.push(await ring(s.find("Clusters").element() as HTMLElement));
    expect(rows, "graph composite rows and mode segments have inset focus rings").toEqual(Array(5).fill(true));
    expect(actions, "graph filter and list close have targets and focus rings").toEqual(Array(4).fill(true));
  });
  for (const theme of ["dark", "light"]) test(`batch5 320 ${theme} graph sheet and dictation focus`, async ctx => {
    pointer(); const s = await mount(ctx, 320, theme);
    s.draw(<div style={{ position: "relative", height: 500 }}><GraphControls /></div>);
    await s.find("Graph options").click();
    const close = s.find("Close graph options").element() as HTMLElement;
    expect([target(close, pointer()), await ring(close), close.tagName === "BUTTON"], "graph close slot target, ring and native semantics").toEqual([true, true, true]);
    await s.find("Close graph options").click();
    expect(page.getByRole("dialog").query(), "graph close dismisses the sheet").toBeNull();
    s.draw(<DictationSheet open onStop={noop} onCancel={noop} />);
    const done = s.find("Done").element();
    expect(document.activeElement, "phone dictation initial-focus slot opens on Done").toBe(done);
  });
}
