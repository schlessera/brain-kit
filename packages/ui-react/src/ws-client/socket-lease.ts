import { BrainUiClient, type BrainUiClientOptions, type ConnectionStatus, type WebSocketClose } from "@schlessera/brain-ui-sdk/client";
import type { ClientMessage, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

export interface SocketLeaseOptions {
  url: () => string;
  disposed: () => boolean;
  /** The account is unlocked: only then may a frame reach the page. */
  active: () => boolean;
  /** Counted before each new socket is opened. */
  noteSocketOpen: () => void;
  onMessage: (message: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  onClose: (close: WebSocketClose) => void;
  onProtocolError: NonNullable<BrainUiClientOptions["onProtocolError"]>;
  /** Injected in tests; production opens a `BrainUiClient`. */
  createClient?: (options: BrainUiClientOptions) => BrainUiClient;
}

/**
 * One socket shared by every consumer of a root, opened by the first lease
 * and closed with the last. Each opened socket is a generation: callbacks
 * from an older one are ignored, so a replaced or closed socket can never
 * write into the page.
 */
export function createSocketLease(options: SocketLeaseOptions) {
  let generation = 0;
  let owners = 0;
  let socket: BrainUiClient | null = null;
  let removeListeners: (() => void) | undefined;
  const createClient = options.createClient ?? ((clientOptions) => new BrainUiClient(clientOptions));

  function open(): void {
    const connectedGeneration = ++generation;
    const current = () => !options.disposed() && connectedGeneration === generation;
    options.noteSocketOpen();
    const client = createClient({
      url: options.url(),
      handlers: { onAny: (message) => { if (current() && options.active()) options.onMessage(message); } },
      onStatusChange: (status) => { if (current()) options.onStatusChange(status); },
      onClose: (close) => { if (current()) options.onClose(close); },
      onProtocolError: (err) => { if (current()) options.onProtocolError(err); },
    });
    socket = client;
    client.connect();
    // Liveness B (#910): back in view, resumed, shown again or online means
    // check now. A socket that reads OPEN after the page was hidden or
    // frozen may be half-open; checkLiveness probes it, and reconnects one
    // that is plainly gone. Periodic probes run only in the foreground.
    const check = () => { if (current()) client.checkLiveness(); };
    const foreground = () => typeof document === "undefined" || document.visibilityState === "visible";
    const onVisibility = () => {
      if (!current()) return;
      client.setForeground(foreground());
      if (foreground()) client.checkLiveness();
    };
    const onFreeze = () => { if (current()) client.setForeground(false); };
    client.setForeground(foreground());
    if (typeof window !== "undefined") {
      window.addEventListener("online", check);
      window.addEventListener("pageshow", check);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      document.addEventListener("resume", onVisibility);
      document.addEventListener("freeze", onFreeze);
    }
    removeListeners = () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", check);
        window.removeEventListener("pageshow", check);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        document.removeEventListener("resume", onVisibility);
        document.removeEventListener("freeze", onFreeze);
      }
    };
  }

  /** Acquire a lease; `onLastRelease` runs when the final lease is returned. */
  function acquire(onLastRelease: () => void): () => void {
    if (options.disposed()) throw new Error("Cannot connect a disposed UI root");
    owners++;
    if (!socket) open();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--owners === 0) onLastRelease();
    };
  }

  /** Close the current socket; its callbacks stop reaching the page at once. */
  function close(): void {
    generation++;
    removeListeners?.();
    removeListeners = undefined;
    const client = socket;
    socket = null;
    client?.close();
  }

  /**
   * A reply channel pinned to the socket current now: a reply sent after it
   * closed, or after another socket replaced it, is dropped.
   */
  function pinned(stillCurrent: () => boolean): (message: ClientMessage) => void {
    const client = socket;
    const pinnedGeneration = generation;
    return (message) => {
      if (!options.disposed() && pinnedGeneration === generation && stillCurrent() && client === socket) client?.send(message);
    };
  }

  return {
    acquire,
    close,
    pinned,
    client: (): BrainUiClient | null => socket,
    owners: (): number => owners,
  };
}

export type SocketLease = ReturnType<typeof createSocketLease>;
