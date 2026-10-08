import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context";
import { createBrainUiRoot } from "../../src/root";
import { Composer } from "../../src/components/chat/composer";
import type { ClientChatMessage } from "@schlessera/brain-ui-sdk/protocol";

const providers = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
];
const root = createBrainUiRoot({ storagePrefix: "haiku-fixture", request: async () => Response.json({ providers }) });
await root.stores.provider.getState().loadProviders();
root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
const sent: ClientChatMessage[] = [];
Object.assign(window, { __haikuFixture: { sent, selected: () => root.stores.provider.getState().selectedId } });
createRoot(document.getElementById("app")!).render(<BrainUiProvider root={root}><Composer send={msg => { if (msg.type === "chat_message") sent.push(msg); return true; }} /></BrainUiProvider>);
