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
// Fixture-only DOM/input/frame receipt. The shipped control and connection
// handlers are unchanged; only real trusted input counts as a confirmation.
const trace: Array<{ event: string; approval: boolean; trusted?: boolean; target?: boolean }> = [];
(window as unknown as { __dispatchTrace: typeof trace }).__dispatchTrace = trace;
const approvalSelector = '[role="button"][aria-label="Approve: write_file notes/ithaca-loom.md"]';
const hasApproval = () => document.querySelector(approvalSelector) !== null;
const record = (event: string, trusted?: boolean) => trace.push({ event, approval: hasApproval(), ...(trusted === undefined ? {} : { trusted }) });
for (const event of ["pointerdown", "pointerup", "click"]) {
  document.addEventListener(event, e => {
    record(`input:${event}`, e.isTrusted);
    trace[trace.length - 1]!.target = e.target instanceof Element && e.target.closest(approvalSelector) !== null;
  }, true);
}
let paintedApproval = false;
new MutationObserver(() => {
  const present = hasApproval();
  if (present === paintedApproval) return;
  paintedApproval = present;
  record(present ? "dom:approval-added" : "dom:approval-removed");
  requestAnimationFrame(() => record("frame:after-approval-change"));
}).observe(document.getElementById("scene")!, { childList: true, subtree: true });
const socket = new WebSocket(url.replace("http:", "ws:") + "/ws");
socket.onmessage = (e) => {
  const parsed = parseServerMessage(e.data);
  if (!parsed.ok) throw new Error(parsed.error);
  record(`inbound:${parsed.message.type}`);
  ui.connection.handleServerMessage(parsed.message);
};
ui.connection.send = (msg) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  record(`outbound:${msg.type}`);
  socket.send(JSON.stringify(msg));
  return true;
};
createRoot(document.getElementById("scene")!).render(
  <BrainUiProvider root={ui}>
    <ActivityPage />
  </BrainUiProvider>
);
