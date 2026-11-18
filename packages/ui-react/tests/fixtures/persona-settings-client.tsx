// #3617: the real chat page and its Settings pane against a real server with a
// keyless live-conversation double. Start goes through the shipped
// conversation client, so the server, not this page, says which persona opened.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

const root = createBrainUiRoot({ storagePrefix: "odysseus-personas", storage: localStorage });
const renderer = createRoot(document.getElementById("app")!);
renderer.render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
const conversation = root.connection.conversation;
Object.assign(window, {
  __personas: {
    ready: () => root.stores.connection.getState().wsStatus === "connected" && conversation.state.getState().available,
    openSettings: () => root.stores.ui.getState().openSettings("voice"),
    closeSettings: () => root.stores.ui.getState().setSettingsPanelOpen(false),
    livePersona: () => conversation.state.getState().livePersona,
    /** Enter live conversation and press Start, as the Start card does. */
    start: () => { conversation.enter(); conversation.start(); },
    leave: () => conversation.leave(),
    notice: () => conversation.state.getState().notice,
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
