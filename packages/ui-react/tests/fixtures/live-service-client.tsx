// #3616: the real chat page, its live-conversation disclosure and Settings ›
// Voice, against a real server with two keyless live-service doubles. The
// server, not this page, records which double a Start opened.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

const root = createBrainUiRoot({ storagePrefix: "odysseus-live-service", storage: localStorage });
const renderer = createRoot(document.getElementById("app")!);
renderer.render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
const conversation = root.connection.conversation;
Object.assign(window, {
  __live: {
    ready: () => root.stores.connection.getState().wsStatus === "connected" && conversation.state.getState().available,
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    openSettings: () => root.stores.ui.getState().openSettings("voice"),
    closeSettings: () => root.stores.ui.getState().setSettingsPanelOpen(false),
    enter: () => conversation.enter(),
    leave: () => conversation.leave(),
    state: () => {
      const s = conversation.state.getState();
      return { active: s.active, available: s.available, disclosureOpen: s.disclosureOpen, disclosed: s.conversationProfile?.providerId ?? null,
        opened: s.profile?.providerId ?? null, source: s.profile?.providerSource ?? null, choice: s.serviceChoice, liveDefault: s.liveDefault,
        services: s.conversationProfiles.map((p) => p.providerId) };
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
