import React from "react";
import { createRoot } from "react-dom/client";
import { FilePanel } from "../../src/components/files/file-panel.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";

// #2673: the real Files panel (drawer below 900px, panes from there) against a real server.
const params = new URLSearchParams(location.search);
const root = createBrainUiRoot({ storage: null });
const mount = document.getElementById("app");
if (!mount) throw new Error("Untrusted marks fixture has no mount");
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
createRoot(mount).render(
  <BrainUiProvider root={root}>
    <FilePanel open onClose={() => {}} />
  </BrainUiProvider>,
);
Object.assign(window, { __marks: {
  open: (path: string) => root.stores.file.getState().openFile(path),
  state: () => {
    const state = root.stores.file.getState();
    return { path: state.currentPath, loading: state.contentLoading, error: state.contentError };
  },
  expandTree: () => root.stores.file.getState().setTreeExpanded(true),
  collapseTree: () => root.stores.file.getState().setTreeExpanded(false),
} });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
