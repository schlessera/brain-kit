import { createRoot } from "react-dom/client";
import { createBrainUiRoot } from "../../../../src/root.js";
import { BrainUiProvider } from "../../../../src/root-context.js";
import { RecordingsTray } from "../../../../src/components/voice/recordings-tray.js";
import { defineScene } from "../define-scene.ts";
import { installFaultNetwork } from "../fault-network.ts";
import type { ProgressRequestInit } from "../../../../src/lib/upload-request.js";

let queries = 0;
const net = installFaultNetwork({ routes: async (url, raw) => {
  const init = raw as ProgressRequestInit;
  if (url.pathname.endsWith("/voice/capabilities")) return Response.json({ providerId: "deepgram", capabilities: { savedAudio: true } });
  if (url.pathname.endsWith("/transcription")) {
    if (init.method === "PUT") {
      localStorage.setItem("t9:uploads", String(Number(localStorage.getItem("t9:uploads")) + 1));
      localStorage.setItem("t9:receipt", JSON.stringify({ recordingId: url.pathname.split("/").at(-2), sha256: new Headers(init.headers).get("content-sha256"), providerId: "deepgram", status: "transcribing", attemptId: "held-attempt", retryCount: 0, failures: [] }));
      init.onUploadProgress?.(100);
      return await new Promise<Response>(() => {});
    }
    queries++;
    const receipt = localStorage.getItem("t9:receipt");
    return receipt ? new Response(receipt, { headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });
  }
  return Response.json({ sessions: [] });
} });
const root = createBrainUiRoot({ storagePrefix: "odysseus-t9-scene", localCapture: true, request: net.request });
root.stores.connection.getState().setVpnStatus("connected", "odysseus");
root.stores.connection.getState().setWsStatus("connected");
createRoot(document.getElementById("scene")!).render(<BrainUiProvider root={root}><RecordingsTray /></BrainUiProvider>);
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function waitButton(label: string) {
  for (let n = 0; n < 200; n++) {
    const found = [...document.querySelectorAll<HTMLElement>('button,[role="button"]')].find(el => el.getClientRects().length && el.textContent === label);
    if (found) return found;
    await wait();
  }
  throw new Error(`Missing button: ${label}`);
}
defineScene({
  async seed() {
    await root.localWork!.restoring(); await root.localWork!.snapshotNow();
    await navigator.locks.request("brain-ui:recording", async () => {});
    const sink = root.recordings!.sink(); await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
    await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])]) }); await sink.end!("user");
    return (await root.recordings!.list("account:odysseus"))[0]!.id;
  },
  async prepare(_id: string) {
    for (let n = 0; n < 200 && !document.querySelector("[data-recordings-tray] button"); n++) await wait();
    const tray = document.querySelector<HTMLButtonElement>("[data-recordings-tray] button");
    if (tray?.getAttribute("aria-expanded") !== "true") tray?.click();
    (await waitButton("Transcribe")).click();
  },
  async upload() {
    (await waitButton("Upload and transcribe")).click();
    await wait(100);
  },
  uploads: () => Number(localStorage.getItem("t9:uploads")),
  statusQueries: () => queries,
});
