/**
 * The store hooks a deployment shell imports (#1053). Each one is typed
 * against a minimal published view of its store, covering what a shell reads
 * and calls: the service-worker reload guard (`anyStreaming`, voice activity,
 * `hasPendingShare`), the active view and the file deep link. The full zustand
 * state shapes stay internal; the package's own modules use the hooks in the
 * `*-store.ts` files, which carry them.
 *
 * Like those hooks, the selector form reads the nearest `BrainUiProvider`'s
 * root, and the `getState`/`subscribe` statics address the default
 * application root only.
 */
import type { StoredShare } from "@schlessera/brain-ui-sdk/share-target";
import type { VoiceMode } from "@schlessera/brain-ui-sdk/protocol";
import type { ExtractState } from "zustand/vanilla";
import { defaultRoot } from "../default-root.js";
import { useRootStore } from "../root-context.js";
import type { SessionChat } from "./chat-state.js";
import type { BrainStores } from "./create-stores.js";
import type { ActiveView } from "./ui-state.js";

/** A store hook as a shell uses it: a selector, plus the default root's read and subscription. */
export interface ShellStoreHook<S> {
  <T>(selector: (state: S) => T): T;
  getState(): S;
  subscribe(listener: (state: S, previous: S) => void): () => void;
}

/** What a shell reads of the chat store: enough for `activeChat` and `anyStreaming`. */
export interface ChatShellState {
  /** Per-session transcript buffers, keyed by server sessionId. */
  readonly buffers: Readonly<Record<string, SessionChat>>;
  /** The unbound new-conversation buffer, if one is in progress. */
  readonly draft: SessionChat | null;
  /** The session in view; null = the draft / new-chat view. */
  readonly activeSessionId: string | null;
}

/** What a shell reads of the voice store to tell whether capture or review is in progress. */
export interface VoiceShellState {
  readonly mode: VoiceMode;
  /** Session fetch or microphone open in progress. */
  readonly connecting: boolean;
  /** Final transcript flush in progress after Done. */
  readonly draining: boolean;
  /** Text waiting in the review card. */
  readonly reviewText: string;
}

/** What a shell reads of share intake: enough for `hasPendingShare`. */
export interface ShareShellState {
  /** Claimed shares, oldest first. */
  readonly queue: readonly StoredShare[];
  /** An upload or send is in flight. */
  readonly busy: boolean;
}

/** What a shell reads and calls of the UI store: the active view and the file panel. */
export interface UIShellState {
  readonly activeView: ActiveView;
  setActiveView(view: ActiveView): void;
  setFilePanelOpen(open: boolean): void;
}

/** What a shell calls of the file store: open a deep-linked file or directory. */
export interface FileShellState {
  openFile(path: string): Promise<void>;
  openDir(path: string): Promise<void>;
}

function shellHook<K extends keyof BrainStores, S>(
  key: K,
  view: (state: ExtractState<BrainStores[K]>) => S,
): ShellStoreHook<S> {
  const store = defaultRoot.stores[key] as unknown as {
    getState(): ExtractState<BrainStores[K]>;
    subscribe(listener: (state: ExtractState<BrainStores[K]>, previous: ExtractState<BrainStores[K]>) => void): () => void;
  };
  return Object.assign(
    function useShellStore<T>(selector: (state: S) => T): T {
      return useRootStore(key, (state) => selector(view(state)));
    },
    {
      getState: () => view(store.getState()),
      subscribe: (listener: (state: S, previous: S) => void) =>
        store.subscribe((state, previous) => listener(view(state), view(previous))),
    },
  );
}

/**
 * The full state already satisfies each view, so the view is the identity:
 * the function only proves the assignment, and a renamed field fails here.
 */
const chatView = (state: ChatShellState): ChatShellState => state;
const voiceView = (state: VoiceShellState): VoiceShellState => state;
const shareView = (state: ShareShellState): ShareShellState => state;
const uiView = (state: UIShellState): UIShellState => state;
const fileView = (state: FileShellState): FileShellState => state;

export const useChatStore: ShellStoreHook<ChatShellState> = shellHook("chat", chatView);
export const useVoiceStore: ShellStoreHook<VoiceShellState> = shellHook("voice", voiceView);
export const useShareStore: ShellStoreHook<ShareShellState> = shellHook("share", shareView);
export const useUIStore: ShellStoreHook<UIShellState> = shellHook("ui", uiView);
export const useFileStore: ShellStoreHook<FileShellState> = shellHook("file", fileView);
