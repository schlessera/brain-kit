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
for (const providerId of ["alpha", "beta"]) {
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
    state: () => {
      const voice = root.stores.voice.getState();
      return {
        mode: voice.mode, connecting: voice.connecting, providerId: voice.providerId, reviewText: voice.reviewText,
        gate: voice.dictationGate?.kind ?? null, target: voice.dictationTarget?.id ?? null, notice: voice.dictationNotice,
        clients: clients.map(({ providerId, client }) => ({ providerId, session: client.options.session.providerId, tracks: client.stream?.getTracks().map((track) => track.readyState) ?? [] })),
      };
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
