/** #689 AC1: one device's real Actions page against the real app's WebSocket. */
import { createRoot } from "react-dom/client";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import "../../../ui-kit/dist/styles.css";
import "../../dist/styles.css";
const url = (window as unknown as { __dispatchUrl: string }).__dispatchUrl;
const ui = createBrainUiRoot({
  storage: null,
  request: async (path) => {
    if (path.includes("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.includes("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
  },
});
const socket = new WebSocket(url.replace("http:", "ws:") + "/ws");
socket.onmessage = (e) => {
  const parsed = parseServerMessage(e.data);
  if (!parsed.ok) throw new Error(parsed.error);
  ui.connection.handleServerMessage(parsed.message);
};
ui.connection.send = (msg) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
};
createRoot(document.getElementById("scene")!).render(
  <BrainUiProvider root={ui}>
    <ActivityPage />
  </BrainUiProvider>
);
