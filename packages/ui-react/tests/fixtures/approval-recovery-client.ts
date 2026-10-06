import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

// A stable storage prefix, so a reload is the same root coming back with
// the session it had selected (#964).
const root = createBrainUiRoot({ storagePrefix: "odysseus-recovery", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const mount = document.getElementById("app");
if (!mount) throw new Error("Approval recovery fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, {
  __recoveryFixture: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    activeSessionId: () => root.stores.chat.getState().activeSessionId,
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
