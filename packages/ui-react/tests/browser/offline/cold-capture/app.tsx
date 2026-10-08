import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../../../src/root-context.js";
import { createBrainUiRoot } from "../../../../src/root.js";
import { ConnectionGate } from "../../../../src/components/connectivity/connection-gate.js";
import { AUDIO_FIXTURES, generateWav } from "../audio-fixtures.js";
import { defineScene } from "../define-scene.js";

const requests: string[] = [];
const ui = createBrainUiRoot({ storagePrefix: "odysseus-cold-capture", localCapture: true, request: async (url, init) => {
  requests.push(new URL(url, location.href).pathname);
  return fetch(url, init);
} });
function Protected() {
  useEffect(() => { void ui.api.sessions(); void ui.request("/api/files/content?raw=1"); }, []);
  return <section data-protected="">Odysseus's protected voyage history</section>;
}
createRoot(document.getElementById("app")!).render(<BrainUiProvider root={ui}><ConnectionGate><Protected /></ConnectionGate></BrainUiProvider>);
void navigator.serviceWorker.register("/worker.js");
defineScene({
  async seed() {
    const key = ui.stores.connection.getState().accountKey;
    if (!key) throw new Error("The online seed needs authenticated account authority");
    const wav = new Blob([Uint8Array.from(generateWav(AUDIO_FIXTURES.note10s)).buffer], { type: "audio/wav" });
    await ui.partitions!.open(`account:${key}`).write([
      { put: "recording:index:ithaca-secret", value: { id: "ithaca-secret", state: "saved", createdAt: Date.parse("2026-07-12T12:00:00Z"), mime: "audio/wav", durationMs: 10_000, savedThroughMs: 10_000, bytes: wav.size, contentHash: "odysseus-audio", chunkCount: 1, transcript: "Secret plan for the Sirens" } },
      { put: "recording:chunk:ithaca-secret:00000000", value: { index: 0, startMs: 0, endMs: 10_000, data: wav } },
    ]);
  },
  async inventory() { return ui.recordings!.list("unassigned"); },
  async expire() { await ui.authLock.expire(); },
  phase() { return ui.stores.voice.getState().local; },
  requests() { return requests; },
});
