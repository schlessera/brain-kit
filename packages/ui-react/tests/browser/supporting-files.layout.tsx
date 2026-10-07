import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { renderBlockHtml } from "../../src/components/chat/share-document.js";
import type { Block } from "@schlessera/brain-ui-sdk/client";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, themeBefore: string | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; themeBefore = document.documentElement.dataset.theme; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  document.documentElement.dataset.theme = themeBefore; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
const block: Block = { kind: "files", items: [
  { path: "knowledge/scylla.md" },
  { path: "people/circe.md", reason: "Gives the directions for the crossing. " + "Scylla".repeat(30) },
] };
for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
  test(`${theme} ${width}: both backend supporting lists fit, have 44px targets and open their exact local file`, async () => {
    outer = await commands.formViewport(width, 800); await page.viewport(width, 800); document.documentElement.dataset.theme = theme;
    const requested: string[] = [];
    root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" }, request: async url => {
      requested.push(String(url)); const path = new URL(String(url)).searchParams.get("path");
      return String(url).includes("/files/content") ? Response.json({ path, kind: "markdown", content: "# Circe" }) : Response.json({ error: "File not found" }, { status: 404 });
    } });
    registerBuiltinRenderers(root.renderers);
    host = document.createElement("div"); host.style.cssText = `width:${Math.min(width, 720)}px;overflow-wrap:normal`; document.body.append(host); renderer = createRoot(host);
    const pi = { id: "pi-files", name: "show_block", input: { block }, output: JSON.stringify({ block }) };
    const claude = { id: "claude-files", name: "mcp__brain-ui__show_block", input: { block }, output: JSON.stringify({ block }) };
    const PiOutput = root.renderers.resolve(pi, "pi")!.Output!, ClaudeOutput = root.renderers.resolve(claude, "claude")!.Output!;
    flushSync(() => renderer!.render(<BrainUiProvider root={root}><PiOutput tool={pi} /><ClaudeOutput tool={claude} /></BrainUiProvider>));
    const rows = [...host.querySelectorAll<HTMLElement>('.bk-row[role="button"]')];
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.getBoundingClientRect().height, "supporting row target").toBeGreaterThanOrEqual(44);
    for (const row of rows) expect(row.scrollWidth, "complete supporting reason is contained").toBeLessThanOrEqual(row.clientWidth + 1);
    expect(host.textContent).toContain("Scylla".repeat(30)); expect(host.textContent).not.toContain("4,812"); expect(host.textContent).not.toContain("0.98");
    expect(requested).toEqual([]);
    rows[1]!.focus(); await userEvent.keyboard("{Enter}");
    await expect.poll(() => root!.stores.file.getState().currentContent?.path).toBe("people/circe.md");
    expect(requested).toHaveLength(2);
    expect(requested.every(url => new URL(url).origin === "https://alpha.example" && new URL(url).searchParams.get("path") === "people/circe.md")).toBe(true);
    await page.screenshot({ path: `../../.vitest-attachments/supporting-files/${theme}-${width}.png` });
  });
  test(`${theme} ${width}: actual export HTML retains reasons as a static list`, async () => {
    outer = await commands.formViewport(width, 800); await page.viewport(width, 800); document.documentElement.dataset.theme = theme;
    host = document.createElement("div"); host.style.cssText = `width:${Math.min(width, 720)}px;overflow-wrap:normal`; document.body.append(host);
    host.innerHTML = await renderBlockHtml(block);
    expect(host.textContent).toContain("Scylla".repeat(30)); expect(host.textContent).toContain("knowledge/scylla.md");
    expect(host.querySelectorAll('[role="button"],button,a')).toHaveLength(0);
    expect(host.scrollWidth, "static reasons fit the exported measure").toBeLessThanOrEqual(host.clientWidth + 1);
  });
}
