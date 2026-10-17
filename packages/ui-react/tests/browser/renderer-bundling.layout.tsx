import { afterEach, expect, test, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { registerContentRendererPack } from "../../src/index.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";

let renderer: Root, root: BrainUiRoot, host: HTMLDivElement;
afterEach(() => { if (renderer) flushSync(() => renderer.unmount()); root?.dispose(); host?.remove(); defaultContentRendererRegistry.reset(); vi.restoreAllMocks(); });
const declaration = { module: "voyage-browser", version: "0.43.1", name: "map", fences: ["voyage"], extensions: [".voyage"] };
function mount(development = false) {
  root = createBrainUiRoot({ storage: null, config: { devTools: development }, request: async url => {
    expect(url.endsWith("/status")).toBe(true);
    return Response.json({ contentRenderers: [declaration] });
  } });
  host = document.createElement("div"); document.body.append(host); renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={root}><BrainMarkdown content={"```voyage\nThe homecoming relay\n```\n\n```voyage\nTelemachus returns\n```"}/></BrainUiProvider>));
}
test("deployment without the bundled pack uses authenticated bootstrap to retain source and explain the missing renderer", async () => {
  mount();
  await expect.poll(() => [...host.querySelectorAll("[role=status]")].map(node => node.textContent)).toEqual(["Renderer not bundled.", "Renderer not bundled."]);
  expect(host.querySelectorAll("pre")).toHaveLength(2); expect(host.textContent).toContain("The homecoming relay");
  root.stores.connection.getState().setVpnStatus("unauthorized");
  await expect.poll(() => host.querySelector("[role=status]")).toBeNull();
});
test("deployment imports and registers its trusted UI entry; two fences render and version skew warns once", async () => {
  registerContentRendererPack({ renderers: [{ languages: ["voyage"], extensions: [".voyage"], needsBrowser: false,
    Component: ({ source }) => <figure aria-label="Voyage map">{source}</figure>, toStatic: async () => "" }] }, { name: "voyage-browser", version: "0.43.0" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mount(true);
  await expect.poll(() => host.querySelectorAll("figure").length).toBe(2);
  await expect.poll(() => warn.mock.calls.filter(call => String(call[0]).includes("Content renderer module voyage-browser")).length).toBe(1);
  expect(host.querySelector("pre")).toBeNull(); expect(host.querySelector("[role=status]")).toBeNull();
});
