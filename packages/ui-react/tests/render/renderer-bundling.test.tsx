import { registerDom, unregisterDom } from "./dom.js";
import { afterAll, afterEach, expect, test, spyOn } from "bun:test";
import { act } from "react";
import { waitFor } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { registerContentRendererPack } from "../../src/index.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";

registerDom();
afterAll(async () => { await act(async () => {}); await unregisterDom(); });

let restoreWarn: (() => void) | undefined;
let renderer: Root, root: BrainUiRoot, host: HTMLDivElement;
afterEach(async () => { await act(async () => { renderer?.unmount(); root?.dispose(); }); host?.remove(); defaultContentRendererRegistry.reset(); restoreWarn?.(); });
const declaration = { module: "voyage-browser", version: "0.43.1", name: "map", fences: ["voyage"], extensions: [".voyage"] };
async function mount(development = false) {
  root = createBrainUiRoot({ storage: null, config: { devTools: development }, request: async url => {
    expect(url.endsWith("/status")).toBe(true);
    return Response.json({ contentRenderers: [declaration] });
  } });
  host = document.createElement("div"); document.body.append(host); renderer = createRoot(host);
  await act(async () => renderer.render(<BrainUiProvider root={root}><BrainMarkdown content={"```voyage\nThe homecoming relay\n```\n\n```voyage\nTelemachus returns\n```"}/></BrainUiProvider>));
}
test("deployment without the bundled pack uses authenticated bootstrap to retain source and explain the missing renderer", async () => {
  await mount();
  await waitFor(() => expect([...host.querySelectorAll("[role=status]")].map(node => node.textContent)).toEqual(["Renderer not bundled.", "Renderer not bundled."]));
  expect(host.querySelectorAll("pre")).toHaveLength(2);
  expect([...host.querySelectorAll("pre")].map(node => node.textContent?.trim())).toEqual(["The homecoming relay", "Telemachus returns"]);
  await act(async () => { root.stores.connection.getState().setVpnStatus("unauthorized"); });
  await waitFor(() => expect(host.querySelector("[role=status]")).toBeNull());
});
test("deployment registers its trusted UI entry; two fences render and version skew warns once", async () => {
  registerContentRendererPack({ renderers: [{ languages: ["voyage"], extensions: [".voyage"], needsBrowser: false,
    Component: ({ source }) => <figure aria-label="Voyage map">{source}</figure>, toStatic: async () => "" }] }, { name: "voyage-browser", version: "0.43.0" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  restoreWarn = () => warn.mockRestore();
  await mount(true);
  await waitFor(() => expect(host.querySelectorAll("figure")).toHaveLength(2));
  await waitFor(() => expect(warn.mock.calls.filter(call => String(call[0]).includes("Content renderer module voyage-browser"))).toHaveLength(1));
  expect([...host.querySelectorAll("figure")].map(node => node.textContent)).toEqual(["The homecoming relay", "Telemachus returns"]);
  expect(host.querySelector("pre")).toBeNull(); expect(host.querySelector("[role=status]")).toBeNull();
});
