import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { FilePanel } from "../../src/components/files/file-panel.js";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { hasFileEntry } from "../../src/lib/file-entry-focus.js";
import { MobileTabBar } from "../../src/components/layout/mobile-tab-bar.js";
import { SideRail } from "../../src/components/layout/side-rail.js";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const root = createBrainUiRoot({ storage: null });
const initial = params.get("path") ?? ".brain/scratch/raft/overview.pdf";
let rewrite: (path: string) => void = () => {};

function Scene() {
  const [path, setPath] = useState(initial);
  rewrite = setPath;
  const open = useUIStore(s => s.filePanelOpen);
  const close = useUIStore(s => s.setFilePanelOpen);
  return <ConnectionGate><main>
    <SideRail />
    <MobileTabBar />
    <h1 data-chat-heading="" tabIndex={-1}>The voyage</h1>
    <article aria-label={params.has("replay") ? "Retained conversation" : "Conversation"}>
      <BrainMarkdown content={`The crossing at Scylla is recorded in [the raft overview](${path}).`} fileLinks />
    </article>
    <textarea data-composer="" aria-label="Message" defaultValue="Ask Penelope about the shroud." />
    <FilePanel open={open} onClose={() => close(false)} />
  </main></ConnectionGate>;
}

createRoot(document.getElementById("app")!).render(<StrictMode><BrainUiProvider root={root}><Scene /></BrainUiProvider></StrictMode>);
Object.assign(window, { __artifactFixture: {
  state: () => ({ path: root.stores.file.getState().currentPath, kind: root.stores.file.getState().currentContent?.kind,
    failure: root.stores.file.getState().contentFailure?.kind, expired: root.stores.file.getState().contentExpired,
    loading: root.stores.file.getState().contentLoading, open: root.stores.ui.getState().filePanelOpen,
    reference: root.stores.file.getState().scratchFiles[initial] ?? null,
    auth: root.authLock.state.getState().phase, entry: hasFileEntry(root), account: root.stores.connection.getState().accountKey }),
  open: (path: string) => { root.stores.ui.getState().setFilePanelOpen(true); return root.stores.file.getState().openFile(path); },
  close: () => root.stores.ui.getState().setFilePanelOpen(false),
  rewrite: (path: string) => rewrite(path),
} });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
