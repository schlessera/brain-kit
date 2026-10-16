import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, createBrainUiRoot, ConnectionGate } from "../../src/index.js";
import { TurnJournal } from "../../src/components/chat/turn-journal.js";
import { useChatStore } from "../../src/stores/chat-store.js";
import type { ServerMessage, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";

const root = createBrainUiRoot({ storage: null });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const seed = (params.has("memory") ? (window as any).__memorySeed : params.has("conflict") ? (window as any).__conflictSeed : (window as any).__journalSeed) as { turnId: string; summary: TurnJournalSummary };
function Scene() {
  const message = useChatStore(state => state.buffers["ithaca"]?.messages.at(-1));
  useEffect(() => {
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");
    chat.setMessages("ithaca", [{ id: "voyage", role: "assistant", content: "Athena recorded the return.", parts: [{ kind: "text", text: "Athena recorded the return." }], toolCalls: [], timestamp: 1, isStreaming: false, turnId: seed.turnId, ...(params.has("replay") ? { journal: seed.summary } : {}) }]);
    if (!params.has("replay")) root.connection.handleServerMessage({ type: "turn_journal", sessionId: "ithaca", turnId: seed.turnId, journal: seed.summary });
  }, []);
  return <main><h1>The voyage</h1><p>Athena recorded the return.</p><textarea aria-label="Message" defaultValue="Ask Penelope about the shroud." />
    <TurnJournal turnId={message?.turnId} summary={message?.journal} live={message?.journalLive} /></main>;
}
createRoot(document.getElementById("app")!).render(<BrainUiProvider root={root}><ConnectionGate><Scene /></ConnectionGate></BrainUiProvider>);
Object.assign(window, { __journalFixture: {
  frame: (message: ServerMessage) => root.connection.handleServerMessage(message),
  state: () => ({ session: root.stores.chat.getState().activeSessionId, streaming: root.stores.chat.getState().buffers["ithaca"]?.isStreaming, runState: root.stores.chat.getState().runStates["ithaca"] ?? "idle", summary: root.stores.chat.getState().buffers["ithaca"]?.messages.at(-1)?.journal }),
  switchSession: () => root.stores.chat.getState().setActiveSession("other"),
} });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
