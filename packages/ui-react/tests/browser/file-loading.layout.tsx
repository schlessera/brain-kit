import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { FilePanel } from "../../src/components/files/file-panel.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined, style: HTMLStyleElement | undefined;
let viewport: { width: number; height: number } | undefined;
let outer: { width: number; height: number } | undefined;
const themeBefore = document.documentElement.dataset.theme;
const urlBefore = location.href;
const pending: Array<() => void> = [];

afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose();
  for (const finish of pending.splice(0)) finish();
  host?.remove(); style?.remove();
  renderer = undefined; root = undefined; host = undefined; style = undefined;
  if (themeBefore === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = themeBefore;
  history.replaceState(null, "", urlBefore);
  if (viewport) await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});

for (const theme of ["light", "dark"] as const) for (const width of [320, 1280]) {
  test(`${theme} ${width}: file panel loading names are accessible with one live status and static ghosts`, async () => {
    viewport = { width: innerWidth, height: innerHeight };
    outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    style = document.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    document.head.append(style);
    host = document.createElement("div");
    document.body.append(host);
    // Hold the actual tree request at the root transport boundary so both
    // loading consumers remain mounted throughout the accessibility scan.
    root = createBrainUiRoot({ storage: null, request: () => new Promise<Response>(resolve => {
      pending.push(() => resolve(Response.json({ path: "", entries: [] })));
    }) });
    root.stores.ui.setState({ theme });
    root.stores.file.setState({ currentPath: "voyage/raft.md", contentLoading: true, treeExpanded: true });
    renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><FilePanel open onClose={() => {}} /></BrainUiProvider>));
    await expect.poll(() => document.querySelector('[aria-label="Loading file"]')).not.toBeNull();
    await expect.poll(() => document.querySelector('[aria-label="Loading files"]')).not.toBeNull();
    const result = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    await expect.element(page.getByRole("group", { name: "Loading file", exact: true })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Loading files", exact: true })).toBeVisible();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("File status: Loading file");
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const ghosts = [...document.querySelectorAll(".bk-ghost")];
    expect(ghosts.length).toBeGreaterThan(0);
    for (const ghost of ghosts) expect(getComputedStyle(ghost).animationName).toBe("none");
    await page.screenshot({ path: `../../.vitest-attachments/file-loading/${theme}-${width}.png` });
  });
}
