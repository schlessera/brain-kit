import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../../../src/root-context.js";
import { createBrainUiRoot } from "../../../../src/root.js";
import { ConnectionGate } from "../../../../src/components/connectivity/connection-gate.js";
import { AUDIO_FIXTURES, generateWav } from "../audio-fixtures.js";
import { watchMicrophone } from "../fake-microphone.js";
import { failIndexedDbWrites, type QuotaFaultHandle } from "../indexeddb-faults.js";
import { defineScene } from "../define-scene.js";

let recoveryWaiting = false;
let releaseRecovery!: () => void;
const recoveryBarrier = new Promise<void>(resolve => { releaseRecovery = resolve; });
if (localStorage.getItem("odysseus-startup-gap")) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = async (algorithm, data) => { recoveryWaiting = true; await recoveryBarrier; return digest(algorithm, data); };
}
let restoreWaiting = false;
let releaseRestore!: () => void;
let restoration: Promise<boolean> | undefined;
const requests: string[] = [];
const microphone = watchMicrophone();
let quota: QuotaFaultHandle | undefined;
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
async function seedGap() {
  const wav = new Blob([Uint8Array.from(generateWav(AUDIO_FIXTURES.note10s)).buffer], { type: "audio/wav" });
  await ui.partitions!.open("unassigned").write([
    { put: "recording:index:sirens-gap", value: { id: "sirens-gap", state: "saved", mime: "audio/wav", durationMs: 3000, savedThroughMs: 3000, bytes: wav.size + 17, contentHash: "odysseus-gap", chunkCount: 3 } },
    { put: "recording:chunk:sirens-gap:00000000", value: { index: 0, startMs: 0, endMs: 1000, data: wav } },
    { put: "recording:chunk:sirens-gap:00000002", value: { index: 2, startMs: 2000, endMs: 3000, data: new Blob([new Uint8Array(17)]) } },
  ]);
  return wav.size;
}
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
  async startupGap() { const bytes = await seedGap(); localStorage.setItem("odysseus-startup-gap", "1"); return bytes; },
  recoveryWaiting() { return recoveryWaiting; },
  releaseRecovery() { localStorage.removeItem("odysseus-startup-gap"); releaseRecovery(); },
  beginRestore() {
    const resume = ui.localWork!.resume.bind(ui.localWork);
    const barrier = new Promise<void>(resolve => { releaseRestore = resolve; });
    ui.localWork!.resume = async () => { restoreWaiting = true; await barrier; return resume(); };
    restoration = ui.authLock.signedIn("odysseus-ithaca");
  },
  restoreWaiting() { return restoreWaiting; },
  async finishRestore() { releaseRestore(); return restoration; },
  async gap() {
    const bytes = await seedGap();
    quota = failIndexedDbWrites({ afterBytes: 0 });
    const recovered = await ui.unassignedRecordings!.recover("unassigned");
    // A deletion of an absent recording publishes the inventory change without
    // requiring a put on the full origin. No production test-only hooks.
    await ui.unassignedRecordings!.discard("unassigned", "odysseus-inventory-refresh");
    return { bytes, failures: quota.failures, row: recovered.recordings[0] };
  },
  restoreQuota() { quota?.restore(); },
  dispose() { ui.dispose(); },
  microphoneLive() { return microphone.streams.some(stream => stream.getTracks().some(track => track.readyState === "live")); },
  async image() {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) throw new Error("API image requires worker control");
    const image = new Image();
    image.src = "/api/files/content?raw=1&path=voyage/beacon.png";
    document.body.append(image);
    await image.decode();
    return { complete: image.complete, width: image.naturalWidth };
  },
  async offlineImage() {
    try { await fetch("/api/files/content?raw=1&path=voyage/beacon.png"); return true; } catch { return false; }
  },
  async inventory() { return ui.recordings!.list("unassigned"); },
  async expire() { await ui.authLock.expire(); },
  phase() { return ui.stores.voice.getState().local; },
  requests() { return requests; },
});
