import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";
import { ExternalSpeechClient } from "./external-speech-client.js";

const root = createBrainUiRoot({ storage: null });
const clients: ExternalSpeechClient[] = [];
root.asr.register("fixture-speech", (options) => {
  const client = new ExternalSpeechClient(options);
  clients.push(client);
  return client;
});
const renderer = createRoot(document.getElementById("app")!);
renderer.render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, {
  __speechFixture: {
    ready: () => root.stores.connection.getState().wsStatus === "connected",
    turnIdle: () => {
      const state = root.stores.chat.getState();
      return state.activeSessionId === "speech-fixture-session" && state.buffers["speech-fixture-session"]?.isStreaming === false;
    },
    state: () => ({ ...root.stores.voice.getState(), clients: clients.map((client) => ({ session: client.options.session, tracks: client.stream?.getTracks().map((track) => track.readyState) ?? [] })) }),
    unmount: () => renderer.unmount(),
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
