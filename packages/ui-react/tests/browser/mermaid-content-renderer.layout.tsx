import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { FileViewer } from "../../src/components/files/file-viewer.js";

const source = "graph LR; Troy-->Ithaca";
let host: HTMLDivElement, renderer: Root, root: BrainUiRoot, styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(() => {
  if (renderer) flushSync(() => renderer.unmount());
  root?.dispose(); host?.remove(); defaultContentRendererRegistry.reset();
  document.documentElement.dataset.theme = originalTheme;
});

test("standalone Mermaid is drawn by the built-in content pack in the actual file viewer", async () => {
  document.documentElement.dataset.theme = "light";
  root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  root.stores.ui.setState({ theme: "light" });
  root.stores.file.setState({ currentPath: "notes/voyage.mmd", currentContent: {
    path: "notes/voyage.mmd", kind: "text", content: source, size: source.length,
    mtime: Date.parse("2026-07-12T00:00:00Z"),
  }, contentLoading: false, viewMode: "preview" });
  host = document.createElement("div"); host.style.width = "640px"; document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={root}><FileViewer /></BrainUiProvider>));
  await expect.poll(() => host.querySelector("svg[id^='brain-mermaid-']"), { timeout: 15000 }).not.toBeNull();
  expect(host.querySelector('[data-content-renderer="mermaid"] svg[id^="brain-mermaid-"]'), "MERMAID_FILE_USES_REGISTERED_CONTENT_PACK").not.toBeNull();
});
