import { createRoot } from "react-dom/client";
import { ActivityPage, AppShell, BrainUiProvider, ChatPage, GraphPage, createBrainUiRoot, useServiceWorkerUpdates, useUIStore } from "../../src/index.ts";
import { trackerViews } from "../../src/stores/tracker-state.ts";
import { anyStagedTracks } from "../../src/lib/draft-tracks.ts";

// The whole app, as a hosting shell composes it (#953): AppShell with Chat,
// Actions and Graph, on one root with a stable storage prefix, so a reload
// is the same root coming back. The test drives it only through what is on
// screen; this probe reads state and never changes it.
const root = createBrainUiRoot({ storagePrefix: "odysseus-parallel", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });

/** `?update`: the hosting shell's service-worker hook too, against the worker the test stands in for (#1150). */
const withUpdates = new URLSearchParams(location.search).has("update");

function UpdateGuard() {
  useServiceWorkerUpdates({ isBusy: false });
  return null;
}

function Shell() {
  const view = useUIStore((s) => s.activeView);
  return <AppShell>{withUpdates && <UpdateGuard />}{view === "activity" ? <ActivityPage /> : view === "graph" ? <GraphPage /> : <ChatPage />}</AppShell>;
}

const mount = document.getElementById("app");
if (!mount) throw new Error("Parallel-sessions fixture mount is missing");
createRoot(mount).render(<BrainUiProvider root={root}><Shell /></BrainUiProvider>);

/**
 * Every announcement the Working group's live region has spoken, in order:
 * each node added to the region (`aria-relevant="additions"`), and each text
 * rewritten inside one, recorded as it happens and never deduplicated, so a
 * repeat shows up as a second entry.
 */
const spoken: string[] = [];
const inRegion = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest("[data-working-live]") ?? null;
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === "characterData") {
      if (inRegion(record.target) && record.target.textContent) spoken.push(record.target.textContent);
      continue;
    }
    for (const node of record.addedNodes) {
      // A region mounted with its children is a mount, not an addition to it.
      if (node instanceof Element && node.matches("[data-working-live]")) continue;
      if (inRegion(record.target) && node.textContent) spoken.push(node.textContent);
    }
  }
}).observe(document.body, { childList: true, subtree: true, characterData: true });

Object.assign(window, {
  __parallel: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    draftsSupported: () => root.stores.drafts.getState().supported,
    activeSessionId: () => root.stores.chat.getState().activeSessionId,
    view: () => root.stores.ui.getState().activeView,
    views: () => trackerViews(root.stores.trackers.getState(), root.stores.chat.getState().queueNotes)
      .map((v) => ({ sessionId: v.sessionId, state: v.state, pendingKind: v.pendingKind, cleared: v.cleared, turnId: v.turnId, settled: v.settled })),
    records: () => root.stores.trackers.getState().records,
    spoken: () => [...spoken],
    draft: () => {
      const drafts = root.stores.drafts.getState();
      const d = drafts.drafts[drafts.idFor(root.stores.chat.getState().activeSessionId)];
      return { text: d?.text ?? "", images: d?.attachments.length ?? 0, sessionId: d?.sessionId ?? null };
    },
    unbound: () => Object.values(root.stores.drafts.getState().drafts).filter((d) => d.sessionId === null && (d.text || d.attachments.length)).map((d) => d.text),
    /** The messages of a session's buffer, as roles and text. */
    transcript: (sessionId: string | null) => {
      const chat = root.stores.chat.getState();
      const buffer = sessionId ? chat.buffers[sessionId] : chat.draft;
      return (buffer?.messages ?? []).map((m) => `${m.role}: ${m.content}`);
    },
    streaming: (sessionId: string) => Boolean(root.stores.chat.getState().buffers[sessionId]?.isStreaming),
    /** Any view of this root holds a staged track. */
    staged: () => anyStagedTracks(root),
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
