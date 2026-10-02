import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

const root = createBrainUiRoot({ storage: null, config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const mount = document.getElementById("app");
if (!mount) throw new Error("Chat focus fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, { __focusFixture: { connected: () => root.stores.connection.getState().wsStatus === "connected" } });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
