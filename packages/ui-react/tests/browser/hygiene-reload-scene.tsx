/** Independent page used for native reload/reconnect/two-device C5 proof. */
import { createRoot } from "react-dom/client";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import "../../../ui-kit/dist/styles.css";
import "../../dist/styles.css";
const url = (window as unknown as { __c5Url: string }).__c5Url;
const ui = createBrainUiRoot({
  storage: null,
  request: async (path, init) => {
    if (path.includes("/hygiene/")) return fetch(path, init);
    if (path.includes("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.includes("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
  },
});
let socket: WebSocket;
function connect() {
  socket = new WebSocket(url.replace("http:", "ws:") + "/ws");
  const current = socket;
  socket.onmessage = (e) => {
    const parsed = parseServerMessage(e.data);
    if (!parsed.ok) throw new Error(parsed.error);
    ui.connection.handleServerMessage(parsed.message);
  };
  socket.onclose = () => {
    if (socket === current) ui.stores.inbox.getState().connectionLost();
  };
}
ui.connection.send = (msg) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
};
connect();
Object.assign(window, {
  __c5Reconnect() {
    socket.close();
    connect();
  },
});
const host = document.getElementById("scene")!;
createRoot(host).render(
  <BrainUiProvider root={ui}>
    <ActivityPage />
  </BrainUiProvider>
);
