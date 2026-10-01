import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

const root = createBrainUiRoot({ storagePrefix: "odysseus-capture", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const mount = document.getElementById("app");
if (!mount) throw new Error("Runtime capture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
// Observation only: the automation sends through the mounted composer and card.
Object.assign(window, { __captureFixture: { connected: () => root.stores.connection.getState().wsStatus === "connected" } });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
