// #3698: the real chat page and its Start card against a real server with
// two keyless live-service doubles. The server, not this page, records which
// double a Start opened; the page records only what it sent.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

const root = createBrainUiRoot({ storagePrefix: "odysseus-start-card", storage: localStorage });
const renderer = createRoot(document.getElementById("app")!);
renderer.render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
const conversation = root.connection.conversation;
Object.assign(window, {
  __start: {
    ready: () => root.stores.connection.getState().wsStatus === "connected" && conversation.state.getState().available,
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    enter: () => conversation.enter(),
    leave: () => conversation.leave(),
    state: () => {
      const s = conversation.state.getState();
      return { active: s.active, disclosureOpen: s.disclosureOpen, disclosed: s.conversationProfile?.providerId ?? null,
        opened: s.profile?.providerId ?? null, source: s.profile?.providerSource ?? null, capture: s.capture, micOn: s.micOn,
        persona: s.livePersona?.selected ?? null, personaChoice: s.personaChoice };
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
