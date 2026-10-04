import React from "react";
import { createRoot } from "react-dom/client";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { FileViewer } from "../../src/components/files/file-viewer.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";

const params = new URLSearchParams(location.search);
const files = await fetch("/scratch-fixture.json").then((response) => response.json()) as Record<string, string>;
const path = files[params.get("format") ?? "pdf"]!;
const mode = params.get("mode");
const content = mode === "code" ? `Preview: \`${path}\``
  : mode === "markdown" ? `[Preview](${path})` : `Preview: ${path}`;
const root = createBrainUiRoot({ storage: null });
const mount = document.getElementById("app");
if (!mount || !path) throw new Error("Scratch link fixture is empty");
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
createRoot(mount).render(
  <BrainUiProvider root={root}>
    <main>
      <section aria-label="Chat answer"><BrainMarkdown content={content} fileLinks /></section>
      <section aria-label="File viewer"><FileViewer /></section>
    </main>
  </BrainUiProvider>,
);
Object.assign(window, { __scratchFixture: {
  state: () => {
    const state = root.stores.file.getState();
    return { path: state.currentPath, loading: state.contentLoading, error: state.contentError,
      kind: state.currentContent?.kind, mime: state.currentContent?.mime };
  },
} });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
