import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "../../src/index.ts";
import { trackerViews } from "../../src/stores/tracker-state.ts";

// A stable storage prefix, so a reload is the same root coming back with its
// trackers (#948).
const root = createBrainUiRoot({ storagePrefix: "odysseus-trackers", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const mount = document.getElementById("app");
if (!mount) throw new Error("Tracker fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, {
  __trackers: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    activeSessionId: () => root.stores.chat.getState().activeSessionId,
    views: () => trackerViews(root.stores.trackers.getState(), root.stores.chat.getState().queueNotes),
    records: () => root.stores.trackers.getState().records,
    lastTurnId: () => {
      const chat = root.stores.chat.getState();
      return chat.activeSessionId ? chat.buffers[chat.activeSessionId]?.messages.at(-1)?.turnId ?? null : null;
    },
    debug: () => {
      const t = root.stores.trackers.getState();
      const ui = root.stores.ui.getState();
      const el = document.querySelector("[data-reading-column]")?.parentElement;
      return { reading: t.reading, evidence: t.evidence, records: t.records, view: ui.activeView, panels: [ui.sessionPanelOpen, ui.filePanelOpen, ui.settingsPanelOpen, ui.syncPanelOpen, ui.whatsupPanelOpen, ui.searchPanelOpen, ui.addPanelOpen, ui.subagentStack.length], vis: document.visibilityState, scroll: el ? [el.scrollHeight, el.scrollTop, el.clientHeight] : null, last: root.stores.chat.getState().buffers[root.stores.chat.getState().activeSessionId ?? ""]?.messages.at(-1)?.turnId };
    },
    setSessionPanel: (open: boolean) => root.stores.ui.getState().setSessionPanelOpen(open),
    /** At ≥1280 Sessions is a pane, not a panel: Files covers Chat there. */
    setFilePanel: (open: boolean) => root.stores.ui.getState().setFilePanelOpen(open),
    announced: () => document.querySelector("[data-working-live]")?.textContent ?? "",
    /** What the session list's row does (`handleSessionResume`, chat-page.tsx). */
    resume: (sessionId: string) => {
      root.stores.chat.getState().clearMessages();
      root.stores.chat.getState().setActiveSession(sessionId);
      root.connection.send({ type: "session_resume", sessionId });
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
