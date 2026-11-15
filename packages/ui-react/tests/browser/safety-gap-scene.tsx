/** #3812: the real Chat page against the real app's WebSocket and routes, split topology. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import "../../../ui-kit/dist/styles.css";
import "../../dist/styles.css";

const url = (window as unknown as { __safetyGapUrl: string }).__safetyGapUrl;
const ui = createBrainUiRoot({ storage: null, config: { backendUrl: url, appName: "Odysseus’s notebook", assistantName: "Brain" } });

function Scene() {
  useEffect(() => ui.connection.connect(), []);
  return <ChatPage />;
}

createRoot(document.getElementById("scene")!).render(<BrainUiProvider root={ui}><Scene /></BrainUiProvider>);
