import { createSafetyClient } from "../lib/safety-client.js";
import type { BrainUiClient, WebSocketClose } from "@schlessera/brain-ui-sdk/client";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { REFUSAL_ATTEMPTS } from "../lib/connection-issue.js";
import { createAnswerDelivery } from "../lib/answer-delivery/manager.js";
import { createTrackerClient } from "../lib/tracker-client.js";
import { createDraftClient } from "../lib/draft-client.js";
import { createAttachmentReadClient } from "../lib/attachment-reads.js";

const authLifecycles = new WeakMap<object, { drop(): void; restore(): void }>();
/** @internal Called only after the gate removes protected views. */
export function dropConnectionContext(root: BrainUiServices): void { authLifecycles.get(root.stores)?.drop(); }
/** @internal Called after confirmed same-account work restore. */
export function restoreConnectionContext(root: BrainUiServices): void { authLifecycles.get(root.stores)?.restore(); }
/** Bind a root's drop/restore pair, for the auth gate to call. */
export function registerAuthLifecycle(root: Pick<BrainUiServices, "stores">, lifecycle: { drop(): void; restore(): void }): void {
  authLifecycles.set(root.stores, lifecycle);
}

/**
 * The account-scoped clients that live beside the socket: queued answers
 * (D52 §2), tracked work (D52 §4, #948) and composer drafts (D52 §5, #951).
 * The auth gate drops all three with the account's context and builds them
 * again on a confirmed same-account restore.
 */
export function createAccountServices(
  root: BrainUiServices,
  deps: { send: (message: ClientMessage) => boolean; socket: () => BrainUiClient | null },
) {
  /**
   * The current connection's hello is known (received, or absent because the
   * host predates it), so the answer queue can tell what this host supports.
   */
  let answersReady = false;
  const makeAnswers = () => createAnswerDelivery({
    chat: root.stores.chat,
    storage: root.answerStorage,
    tabs: root.answerTabs,
    transport: {
      send: (message) => deps.send(message),
      ready: () => answersReady && root.stores.connection.getState().wsStatus === "connected",
      supportsReceipts: () => deps.socket()?.supportsAskReceipts ?? false,
      principalKey: () => deps.socket()?.principalKey ?? null,
      checkLiveness: () => deps.socket()?.checkLiveness(),
    },
    onCorruptRecord: () =>
      root.stores.connection
        .getState()
        .reportError("ANSWER_QUEUE_CORRUPT", "A saved answer on this device could not be read and was discarded."),
  });
  const makeDrafts = () => createDraftClient(root, { send: (message) => deps.send(message) });

  const answers = makeAnswers();
  void answers.start();
  const services = {
    answers,
    safety: createSafetyClient(root,message=>deps.send(message)),
    /** Work left running, tracked until seen (D52 §4, #948). Reads only. */
    trackers: createTrackerClient(root),
    /** Every session's own composer draft, kept on the host when it can (D52 §5, #951). */
    drafts: makeDrafts(),
    /** What the agent read of sent composer originals (#3155, #3589). Reads only. */
    attachmentReads: createAttachmentReadClient(root),
    /**
     * The first frame of a connection settles what its host supports: a hello,
     * or anything else from a host too old to send one. Only then can queued
     * answers be revalidated and replayed.
     */
    frameSeen(): void {
      const socket = deps.socket();
      if (answersReady || !socket || socket.hello === "pending") return;
      // A host too old to send a hello has no recovery to offer.
      if (socket.hello === "absent") {
        root.stores.trackers.getState().setRecoverySupported(false);
        // Nor any drafts: the line says so rather than `not saved yet` forever.
        root.stores.drafts.getState().setSupport(false);
      }
      answersReady = true;
      services.answers.connected();
    },
    /** The socket is no longer connected: queued answers wait for the next hello. */
    socketDown(): void {
      services.safety.disconnected();
      if (!answersReady) return;
      answersReady = false;
      services.answers.disconnected();
    },
    dispose(): void {
      services.answers.dispose(); services.trackers.dispose(); services.drafts.dispose(); services.safety.dispose(); services.attachmentReads.dispose();
    },
    restore(): void {
      services.answers = makeAnswers(); void services.answers.start();
      services.safety = createSafetyClient(root,message=>deps.send(message));
      services.trackers = createTrackerClient(root);
      services.drafts = makeDrafts();
      services.attachmentReads = createAttachmentReadClient(root);
    },
  };
  return services;
}

export type AccountServices = ReturnType<typeof createAccountServices>;

/**
 * A socket closed. 1008 is the host closing a revoked or expired principal's
 * sockets: the account locks. Repeated refusals before any open ask the
 * root to recheck its network path.
 */
export function handleSocketClose(
  root: Pick<BrainUiServices, "stores" | "authLock" | "recheckVpn">,
  close: WebSocketClose,
  trackers: { revoked(): void },
): void {
  const connection = root.stores.connection.getState();
  connection.recordWsClose(close.opened, close.code);
  if (close.opened && close.code === 1008) {
    trackers.revoked();
    void root.authLock.expire(close.reason);
  }
  if (
    !close.opened &&
    root.stores.connection.getState().handshakeFailures >= REFUSAL_ATTEMPTS
  ) {
    root.recheckVpn?.();
  }
}
