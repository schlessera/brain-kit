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
export { configureBrainUi, type BrainUiConfig } from "./config.js";

// Top-level surfaces the shell composes.
export { ConnectionGate } from "./components/connectivity/connection-gate.js";
export { AppShell } from "./components/layout/app-shell.js";
export { ChatPage } from "./components/chat/chat-page.js";
// Loaded on first use, with their own Suspense boundary, so a shell that
// renders them keeps working unchanged — see lazy-pages.tsx.
export { GraphPage, ActivityPage } from "./lazy-pages.js";

// Markdown renderer (also useful standalone, e.g. for a dev kitchen sink).
export { BrainMarkdown } from "./components/chat/brain-markdown.js";

// Mermaid: standalone diagram block (streaming-safe) + the fence-to-SVG
// inliner the share pipeline uses before handing markdown to the no-JS renderer.

// Store hooks + selectors the shell reads (service-worker busy check, deep
// links), typed against minimal shell views of each store (#1053).
export {
  useChatStore,
  useFileStore,
  useShareStore,
  useUIStore,
  useVoiceStore,
  type ShellStoreHook,
  type ChatShellState,
  type FileShellState,
  type ShareShellState,
  type UIShellState,
  type VoiceShellState,
} from "./stores/shell-stores.js";
export {
  activeChat,
  anyStreaming,
  type ChatKey,
  type ChatMessage,
  type SessionChat,
  type ToolCall,
  type AskUserExchange,
  type MessageAttachment,
} from "./stores/chat-state.js";
export { type MaskRequest } from "./stores/mask-state.js";
export { type ActiveView } from "./stores/ui-state.js";
export { type GraphMode } from "./stores/graph-state.js";

// A stand-in for the system share sheet, so the share-target path can be
// exercised without reinstalling the PWA. Meant for a dev route — it lists and
// deletes stashed shares — so the shell should gate it behind a DEV check
// rather than linking it from the app.
export { ShareHarness } from "./components/dev/share-harness.js";

// Connectivity probes.
export { useHashRoutes } from "./hooks/use-hash-routes.js";
export {
  useServiceWorkerUpdates,
  hasUnsentText,
  type UseServiceWorkerUpdatesOptions,
} from "./hooks/use-service-worker-updates.js";
export { registerUpdateHold, type UpdateHold } from "./lib/update-holds.js";
export {
  useWebSocket,
} from "./hooks/use-websocket.js";

// Share intake. The shell needs `hasPendingShare` for its service-worker
// reload guard: reloading mid-intake would file a share twice or lose it.
export { hasPendingShare } from "./stores/share-state.js";

// API surface (typed REST client + backend URL helpers).
export { createBrainApi, type BrainApi } from "./lib/api-client.js";
export { apiBase } from "./lib/backend.js";

// Independent UI roots; connection handlers close over the root they belong to.
export { createBrainUiRoot, type BrainUiRoot, type BrainUiRootOptions, type LocalCaptureOptions } from "./root.js";

// Recording on the device without a server voice session (#1012). A root
// offers it only when given `localCapture`; the engine and the support probe
// are exported for the shell's own capture surfaces.
export {
  startLocalCapture,
  detectLocalCaptureSupport,
  LOCAL_CAPTURE_MIME_TYPES,
  type LocalCapture,
  type LocalCaptureChunk,
  type LocalCaptureMimeType,
  type LocalCaptureSink,
  type LocalCaptureStopReason,
  type LocalCaptureSupport,
  type StartLocalCaptureOptions,
  type LocalCaptureEnvironment,
} from "./voice/local-capture.js";
export { BrainUiProvider, useBrainUiRoot, useBrainApi, useBrainConfig } from "./root-context.js";

export { type RecordingStore, type Recording, type RecordingState, type RecordingBudget, type RecordingEvent, type RecordingRecovery } from "./lib/recordings.js";
