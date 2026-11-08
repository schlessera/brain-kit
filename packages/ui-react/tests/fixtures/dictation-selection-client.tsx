// #3709: the real chat page, its composer, dictation sheet and Settings pane,
// against a real server with two keyless provider doubles. Both doubles use
// the example adapter, so a take's socket really opens to the fixture's local
// speech server and the server, not this page, says which service it reached.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";
import { ExternalSpeechClient } from "./external-speech-client.js";

// A stable prefix and the browser's storage: acknowledgements and other
// device-local state persist across reloads, as they do for a real install.
const root = createBrainUiRoot({ storagePrefix: "odysseus-dictation", storage: localStorage });
const clients: Array<{ providerId: string; client: ExternalSpeechClient }> = [];
for (const providerId of ["alpha", "beta", "gamma"]) {
  root.asr.register(providerId, (options) => {
    const client = new ExternalSpeechClient(options);
    clients.push({ providerId, client });
    return client;
  });
}
const renderer = createRoot(document.getElementById("app")!);
renderer.render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, {
  __dictation: {
    ready: () => root.stores.connection.getState().wsStatus === "connected",
    openSettings: (tab: "voice") => root.stores.ui.getState().openSettings(tab),
    closeSettings: () => root.stores.ui.getState().setSettingsPanelOpen(false),
    /** One short saved recording in this account's partition, made through the real capture sink. */
    seedRecording: async () => {
      // Recordings live in the account's partition. This page mounts no
      // connection gate, so run the probe it would have run.
      const probe = await (await fetch("/api/vpn-check", { credentials: "include" })).json() as { accountKey?: string };
      root.stores.connection.getState().setVpnStatus("connected", probe.accountKey ?? null);
      await root.localWork!.restoring();
      const sink = root.recordings!.sink();
      // The mounted tray's recovery holds the recording lock for a moment.
      for (let attempt = 0; ; attempt++) {
        try { await sink.begin!({ mimeType: "audio/webm;codecs=opus" }); break; }
        catch (error) { if (attempt > 50 || !String(error).includes("still being checked")) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])]) });
      await sink.end!("user");
    },
    state: () => {
      const voice = root.stores.voice.getState();
      return {
        mode: voice.mode, connecting: voice.connecting, providerId: voice.providerId, reviewText: voice.reviewText,
        gate: voice.dictationGate?.kind ?? null, target: voice.dictationTarget?.id ?? null, notice: voice.dictationNotice,
        // Where Settings writes stand, and whether discovery was read again after them.
        save: { pending: voice.dictationSave.pending !== null, status: voice.dictationSave.status?.kind ?? null, refreshFailed: voice.dictationSave.refreshFailed },
        discovery: voice.discovery ? { at: voice.discovery.at, stale: voice.discovery.stale === true } : null,
        clients: clients.map(({ providerId, client }) => ({ providerId, session: client.options.session.providerId, tracks: client.stream?.getTracks().map((track) => track.readyState) ?? [] })),
      };
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
