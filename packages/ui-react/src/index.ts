/**
 * @schlessera/brain-ui-react — the chat UI as a component library.
 *
 * The deployment shell owns the document: index.html, the mount point, the
 * Vite/PWA build, the service worker, and the theme entry (import ./theme.css
 * into a Tailwind v4 build together with an @source pointing at this package's
 * src, or use the precompiled ./styles.css export). The shell composes the
 * pieces below and calls configureBrainUi() before mounting.
 */

// Branding / copy configuration (module singleton, set once at boot).
export { configureBrainUi, uiConfig, type BrainUiConfig } from "./config.js";

// Top-level surfaces the shell composes.
export { ConnectionGate } from "./components/connectivity/connection-gate.js";
export { AppShell } from "./components/layout/app-shell.js";
export { ChatPage } from "./components/chat/chat-page.js";

// Markdown renderer (also useful standalone, e.g. for a dev kitchen sink).
export { BrainMarkdown } from "./components/chat/brain-markdown.js";

// Stores + selectors the shell reads (service-worker busy check, deep links).
export {
  useChatStore,
  activeChat,
  anyStreaming,
  type ChatKey,
  type ChatMessage,
  type SessionChat,
  type ToolCall,
  type AskUserExchange,
  type MessageAttachment,
} from "./stores/chat-store.js";
export { useFileStore } from "./stores/file-store.js";
export { useUIStore } from "./stores/ui-store.js";
export { useConnectionStore } from "./stores/connection-store.js";
export { useProviderStore } from "./stores/provider-store.js";
export { useVoiceStore } from "./voice/voice-store.js";

// Connectivity probes.
export { useVpnStatus } from "./hooks/use-vpn-status.js";
export { useWebSocket, handleServerMessage, runStateForFrame } from "./hooks/use-websocket.js";

// API surface (typed REST client + backend URL helpers).
export { api } from "./lib/api-client.js";
export { API_BASE, getWsUrl, getBackendUrl } from "./lib/backend.js";
