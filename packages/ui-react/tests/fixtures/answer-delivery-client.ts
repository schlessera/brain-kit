// The public ChatPage on a persistent root (IndexedDB answer queue, Web
// Locks across tabs), for tests/answer-delivery-runtime.test.ts (#910).
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";

const root = createBrainUiRoot({
  storagePrefix: "odysseus-answers",
  config: { appName: "Odysseus’s notebook", assistantName: "Brain" },
});
const mount = document.getElementById("app");
if (!mount) throw new Error("Answer delivery fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, {
  __answers: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    deliveries: () => root.stores.chat.getState().deliveries,
    cards: () =>
      Object.values(root.stores.chat.getState().buffers)
        .flatMap((b) => b.messages)
        .flatMap((m) => m.askUserExchanges ?? []).length,
    held: () => root.answers.held(),
    activeSession: () => root.stores.chat.getState().activeSessionId,
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
