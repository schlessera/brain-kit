import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "../../src/index.ts";

// Per-session drafts in the real app (#951): the public ChatPage on a real
// root against the real host. Each browser context is one device of the
// same operator. The page can drop ChatPage and mount it again, the way
// Actions and Graph unmount the composer.
const root = createBrainUiRoot({ storagePrefix: "odysseus-drafts", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
let setMounted: ((mounted: boolean) => void) | null = null;
function Page() {
  const [mounted, set] = useState(true);
  setMounted = set;
  return mounted ? createElement(ChatPage) : createElement("div", { "data-away": "" }, "Actions");
}
const mount = document.getElementById("app");
if (!mount) throw new Error("Draft fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(Page) }));

const view = () => {
  const drafts = root.stores.drafts.getState();
  const id = drafts.idFor(root.stores.chat.getState().activeSessionId);
  const d = drafts.drafts[id];
  return { draftId: id, text: d?.text ?? "", images: d?.attachments.length ?? 0, revision: d?.host?.revision ?? null, conflict: Boolean(d?.conflict) };
};

Object.assign(window, {
  __drafts: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    supported: () => root.stores.drafts.getState().supported,
    activeSessionId: () => root.stores.chat.getState().activeSessionId,
    view,
    unbound: () => Object.values(root.stores.drafts.getState().drafts).filter((d) => d.sessionId === null && (d.text || d.attachments.length)).map((d) => d.text),
    sends: () => Object.values(root.stores.drafts.getState().sends).map((s) => ({ requestId: s.requestId, state: s.state, draftRef: s.draftRef })),
    lastAssistant: () => {
      const chat = root.stores.chat.getState();
      const buffer = chat.activeSessionId ? chat.buffers[chat.activeSessionId] : chat.draft;
      return buffer?.messages.filter((m) => m.role === "assistant").at(-1)?.content ?? null;
    },
    /** What the session list's row does (`handleSessionResume`, chat-page.tsx). */
    resume: (sessionId: string) => {
      root.stores.chat.getState().clearMessages();
      root.stores.chat.getState().setActiveSession(sessionId);
      root.connection.send({ type: "session_resume", sessionId });
    },
    /** What every New chat entry point does. */
    newChat: () => root.stores.chat.getState().clearMessages(),
    away: () => setMounted?.(false),
    back: () => setMounted?.(true),
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
