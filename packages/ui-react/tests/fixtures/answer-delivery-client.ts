// The public ChatPage on a persistent root (IndexedDB answer queue, Web
// Locks across tabs), for tests/answer-delivery-runtime.test.ts (#910).
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot } from "@schlessera/brain-ui-react";
import { createIndexedDbAnswerStorage } from "../../src/lib/answer-delivery/storage";

// A completed startup read can arrive after the host's hello. Hold only its
// result, not the real IndexedDB read/write or the socket, to order that race.
const holdPrincipalRead = new URL(location.href).searchParams.has("holdPrincipalRead");
const storage = createIndexedDbAnswerStorage("odysseus-answers:answers");
let releasePrincipalRead!: () => void;
const principalReadGate = new Promise<void>((resolve) => { releasePrincipalRead = resolve; });
let principalReadWaiting = false;
let storedPrincipal: string | null | undefined;
const answerStorage = holdPrincipalRead ? {
  ...storage,
  async getPrincipalKey() {
    storedPrincipal = await storage.getPrincipalKey();
    principalReadWaiting = true;
    await principalReadGate;
    return storedPrincipal;
  },
} : storage;

const root = createBrainUiRoot({
  storagePrefix: "odysseus-answers",
  answerStorage,
  config: { appName: "Odysseus’s notebook", assistantName: "Brain" },
});
// Keep only fixture identities/state, never transcript or answer content.
const transitions: Array<Record<string, unknown>> = [];
const unsubscribeDelivery = root.stores.chat.subscribe((state, previous) => {
  if (state.deliveries === previous.deliveries) return;
  transitions.push({ type: "delivery", states: Object.values(state.deliveries).map(({ requestId, submissionId, state, mirror }) =>
    ({ requestId, submissionId, state, mirror })) });
});
const unsubscribeBroadcast = root.answerTabs?.subscribe((message) => {
  transitions.push({ type: "broadcast", message: message.type,
    ...(message.type === "item" ? { requestId: message.item.requestId, submissionId: message.item.submissionId } : {}),
    ...(message.type === "delivery" ? { requestId: message.delivery.requestId, state: message.delivery.state } : {}),
  });
});
const mount = document.getElementById("app");
if (!mount) throw new Error("Answer delivery fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ChatPage) }));
Object.assign(window, {
  __answers: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    deliveries: () => root.stores.chat.getState().deliveries,
    cards: () =>
      Object.values(root.stores.chat.getState().buffers)
        .flatMap((b) => b.messages)
        .flatMap((m) => m.askUserExchanges ?? []).length,
    held: () => root.answers.held(),
    activeSession: () => root.stores.chat.getState().activeSessionId,
    principalReadWaiting: () => principalReadWaiting,
    storedPrincipal: () => storedPrincipal,
    async finishPrincipalRead() {
      releasePrincipalRead();
      await root.answers.start();
    },
    async snapshot() {
      return {
        connected: root.stores.connection.getState().wsStatus === "connected",
        deliveries: Object.values(root.stores.chat.getState().deliveries).map(({ requestId, submissionId, state, mirror }) =>
          ({ requestId, submissionId, state, mirror })),
        held: root.answers.held().map(({ requestId, submissionId, principalKey, owned, sent }) =>
          ({ requestId, submissionId, principalKey, owned, sent })),
        activeSession: root.stores.chat.getState().activeSessionId,
        persisted: (await storage.load()).map((item) => {
          const { requestId, submissionId, principalKey, sent } = item as Record<string, unknown>;
          return { requestId, submissionId, principalKey, sent };
        }),
        storedPrincipal: await storage.getPrincipalKey(),
        locks: await navigator.locks.query(),
        transitions,
      };
    },
  },
});
window.addEventListener("pagehide", () => {
  unsubscribeDelivery();
  unsubscribeBroadcast?.();
  root.dispose();
}, { once: true });
