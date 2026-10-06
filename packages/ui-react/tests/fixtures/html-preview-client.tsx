import React from "react";
import { createRoot } from "react-dom/client";
import { FileViewer } from "../../src/components/files/file-viewer.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";

// The real FileViewer, opened on one brain file, for the interactive HTML
// preview runtime proof (#1084). The app page writes a localStorage canary so
// the test can show the probe would have seen one at the app's origin.
const params = new URLSearchParams(location.search);
const path = params.get("file");
const mount = document.getElementById("app");
if (!mount || !path) throw new Error("HTML preview fixture needs ?file=");
localStorage.setItem("bk_canary", "ithaca");
document.title = "Odysseus file viewer";
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const root = createBrainUiRoot({ storage: null });
createRoot(mount).render(
  <BrainUiProvider root={root}>
    <main>
      <section aria-label="File viewer"><FileViewer /></section>
    </main>
  </BrainUiProvider>,
);
await root.stores.file.getState().openFile(path);
Object.assign(window, { __htmlPreviewFixture: {
  state: () => {
    const state = root.stores.file.getState();
    return { path: state.currentPath, loading: state.contentLoading, error: state.contentError, kind: state.currentContent?.kind };
  },
} });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
