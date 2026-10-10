import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";

let renderer: Root | undefined; let ui: BrainUiRoot | undefined; let host: HTMLDivElement | undefined; let style: HTMLStyleElement;
let viewport: { width: number; height: number }; let outer: { width: number; height: number }; let previousTheme: string | undefined;
beforeEach(() => { viewport = { width: window.innerWidth, height: window.innerHeight }; previousTheme = document.documentElement.dataset.theme; });
beforeAll(async () => {
  style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
});
afterAll(() => style.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); ui?.dispose(); host?.remove(); renderer = undefined; ui = undefined; host = undefined;
  document.documentElement.dataset.theme = previousTheme;
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
const hit = { path: "knowledge/scylla.md", title: "Scylla crossing", type: "note", score: 0.75, snippet: "Row past >>>Scylla<<< and avoid >>>six heads<<<. " + "long-evidence".repeat(20) };
for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
  test(`${theme} ${width}: Search uses real kit cards, keyboard selection and complete contained snippets`, async () => {
    outer = await commands.formViewport(width, 800); await page.viewport(width, 800); document.documentElement.dataset.theme = theme;
    ui = createBrainUiRoot({ storage: null, request: async () => Response.json({ results: [hit, { ...hit, path: "people/penelope.md", title: "Penelope", score: undefined }], warnings: ["FTS only"] }) });
    const opened: string[] = []; ui.stores.file.setState({ openFile: async path => { opened.push(path); } });
    host = document.createElement("div"); document.body.append(host); renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={ui}><SearchPanel open onClose={() => {}} /></BrainUiProvider>));
    await page.getByPlaceholder("Search your brain...").fill("Scylla");
    await expect.poll(() => host!.querySelectorAll("[data-search-result-card]").length).toBe(2);
    expect([...host.querySelectorAll("mark")].map(m => m.textContent)).toEqual(["Scylla", "six heads", "Scylla", "six heads"]);
    expect(host.textContent).toContain("0.75"); expect(host.textContent).not.toContain("0.94"); expect(host.textContent).toContain("FTS only");
    expect(host.textContent).toContain("long-evidence".repeat(20));
    for (const card of host.querySelectorAll<HTMLElement>("[data-search-result-card]")) {
      expect(card.scrollWidth, "card contains its complete snippet").toBeLessThanOrEqual(card.clientWidth + 1);
      expect(card.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: `../../.vitest-attachments/search-results/${theme}-${width}.png` });
    // Pointer state can survive earlier files in the browser suite. Start on
    // the first row, then wait for React to paint each keyboard transition.
    await page.getByText("Scylla crossing", { exact: true }).hover();
    await page.getByPlaceholder("Search your brain...").click();
    const cards = [...host.querySelectorAll<HTMLElement>("[data-search-result-card]")];
    await expect.poll(() => cards[0]!.style.background).toBe("var(--bk-color-raised)");
    const selectedBackground = cards[0]!.style.background;
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => cards[1]!.style.background).toBe(selectedBackground);
    await userEvent.keyboard("{Enter}");
    expect(opened).toEqual(["people/penelope.md"]);
  });
  test(`${theme} ${width}: both registered backend outputs render readable cards`, async () => {
    outer = await commands.formViewport(width, 800); await page.viewport(width, 800); document.documentElement.dataset.theme = theme;
    ui = createBrainUiRoot({ storage: null }); registerBuiltinRenderers(ui.renderers);
    host = document.createElement("div"); host.style.width = `${Math.min(width, 720)}px`; document.body.append(host); renderer = createRoot(host);
    const claude = { id: "claude", name: "mcp__brain__brain_search", input: {}, output: JSON.stringify({ results: [hit], warnings: [] }) };
    const pi = { id: "pi", name: "brain_search", input: {}, output: "- knowledge/scylla.md — Scylla crossing [note]\n    Row past >>>Scylla<<< and avoid >>>six heads<<<." };
    const ClaudeOutput = ui.renderers.resolve(claude, "claude")!.Output!;
    const PiOutput = ui.renderers.resolve(pi, "pi")!.Output!;
    flushSync(() => renderer!.render(<BrainUiProvider root={ui}><ClaudeOutput tool={claude} /><PiOutput tool={pi} /></BrainUiProvider>));
    expect(host.querySelectorAll("[data-search-result-card]").length).toBe(2);
    expect(host.querySelectorAll("mark").length).toBe(4);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
  });
}
