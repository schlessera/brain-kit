/**
 * Order the asynchronous storage/coordinator contract around a real takeover.
 * Native reads, deletion, locks, broadcasts and host receipts still execute.
 * Delaying DELETE creation is deliberate: this does not reproduce a historical
 * unmodified IndexedDB schedule. No build transform or product logging is used.
 */
import type { BrainUiRoot } from "../../src/root";
import type { AnswerStorage } from "../../src/lib/answer-delivery/storage";
import { createBrowserTabCoordinator, type TabCoordinator, type TabMessage } from "../../src/lib/answer-delivery/tabs";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Takeover control acknowledgement timed out")), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

type Barrier = { type: "takeover-barrier" | "takeover-ack"; submissionId: string };

export function answerTakeoverControl(storage: AnswerStorage) {
  const role = new URL(location.href).searchParams.get("takeover");
  if (role !== "a" && role !== "b") return null;
  const native = createBrowserTabCoordinator("odysseus-answers:answers");
  if (!native) throw new Error("Native tab coordination required");
  let root: BrainUiRoot | undefined;
  let armed: { requestId: string; submissionId: string } | undefined;
  let removeEntered = false, removeCommitted = false, loadCaptured = false, granted = false;
  let removed: TabMessage | undefined, removedDelivered = false, error = "";
  let releasing = false, takeoverDone = false, disposed = false;
  let publications = 0, statusQueries = 0, acceptedReceipts = 0;
  const removeGate = gate(), loadGate = gate(), removeDone = gate(), channelDone = gate();
  const listeners = new Set<(message: TabMessage) => void>();
  let takeover: Promise<void> | undefined;
  const nativeCompletions = new Map<string, Promise<unknown>>();
  const watchdogs: Array<{ done: Promise<void>; finish(): void; handle: number }> = [];
  const receiptWaiters: Array<() => void> = [];
  const requestDescriptor = Object.getOwnPropertyDescriptor(navigator.locks, "request");
  let sendOwner: object = WebSocket.prototype;
  while (!Object.getOwnPropertyDescriptor(sendOwner, "send")) {
    const parent: object | null = Object.getPrototypeOf(sendOwner);
    if (!parent) throw new Error("Expected existing socket send method");
    sendOwner = parent;
  }
  const sendDescriptor = Object.getOwnPropertyDescriptor(sendOwner, "send")!;
  const timerDescriptor = Object.getOwnPropertyDescriptor(window, "setTimeout")!;
  const clearDescriptor = Object.getOwnPropertyDescriptor(window, "clearTimeout")!;
  const request = navigator.locks.request.bind(navigator.locks);
  const send = WebSocket.prototype.send;
  const setNativeTimer = window.setTimeout.bind(window);
  const clearNativeTimer = window.clearTimeout.bind(window);
  let safety: number | undefined;
  let statusStack = false;
  let restored = false;
  let restoreReceipt: (() => void) | undefined;
  const deliver = (message: TabMessage) => { for (const listener of listeners) listener(message); };
  const postBarrier = (message: Barrier) => native.post(message as unknown as TabMessage);
  const unsubscribe = native.subscribe((message) => {
    const marker = message as unknown as Barrier;
    if (marker.type === "takeover-barrier" && role === "a") {
      // Same native sender/channel FIFO: all prior B publications completed.
      postBarrier({ type: "takeover-ack", submissionId: marker.submissionId });
      return;
    }
    if (marker.type === "takeover-ack" && role === "b") { channelDone.release(); return; }
    if (role === "b" && armed && message.type === "removed" && message.submissionId === armed.submissionId && !removedDelivered) {
      removed = message;
      return;
    }
    deliver(message);
  });
  const releaseAll = () => {
    clearNativeTimer(safety);
    removeGate.release(); loadGate.release();
    if (removed) { const message = removed; removed = undefined; deliver(message); }
  };
  const restore = (object: object, key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  };
  const dispose = () => {
    if (disposed) return { restored };
    disposed = true;
    releaseAll(); root?.dispose(); unsubscribe(); native.dispose(); listeners.clear();
    for (const timer of watchdogs) { clearNativeTimer(timer.handle); timer.finish(); }
    restore(navigator.locks, "request", requestDescriptor);
    restore(sendOwner, "send", sendDescriptor);
    restoreReceipt?.();
    restore(window, "setTimeout", timerDescriptor);
    restore(window, "clearTimeout", clearDescriptor);
    restored = [[navigator.locks, "request", requestDescriptor], [sendOwner, "send", sendDescriptor],
      [window, "setTimeout", timerDescriptor], [window, "clearTimeout", clearDescriptor]].every(([object, key, expected]) => {
        const actual = Object.getOwnPropertyDescriptor(object as object, key as string);
        return expected === undefined ? actual === undefined : actual !== undefined
          && ["value", "writable", "enumerable", "configurable", "get", "set"].every(field =>
            actual[field as keyof PropertyDescriptor] === (expected as PropertyDescriptor)[field as keyof PropertyDescriptor]);
      });
    window.removeEventListener("pagehide", dispose);
    return { restored };
  };
  // Install cleanup before any asynchronous work or held operation can start.
  window.addEventListener("pagehide", dispose, { once: true });

  // Observe fulfillment of the EXISTING native request, including its holder
  // callback's letGo promise. Never probe release with another lock request.
  Object.defineProperty(navigator.locks, "request", { configurable: true, value: function (...args: Parameters<LockManager["request"]>) {
    const result = Reflect.apply(request, navigator.locks, args) as Promise<unknown>;
    if (role === "b") nativeCompletions.set(args[0], result);
    return result;
  } });
  Object.defineProperty(sendOwner, "send", { ...sendDescriptor, value: function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    const result = send.call(this, data);
    if (releasing && typeof data === "string") {
      const message = JSON.parse(data) as { type: string; submissionId?: string };
      if (message.type === "ask_answer_status" && message.submissionId === armed?.submissionId) {
        statusQueries++; statusStack = true;
        queueMicrotask(() => { statusStack = false; });
      }
    }
    return result;
  } });
  // Observe the actual registered watchdog's completion or cancellation. Fixed
  // takeover returns before registering one; the mutant must drain its orphan.
  Object.defineProperty(window, "setTimeout", { ...timerDescriptor, value: ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (!statusStack || ms !== 5_000 || typeof handler !== "function") return setNativeTimer(handler, ms, ...args);
    const done = gate();
    const handle = setNativeTimer(() => { try { handler(...args); } finally { done.release(); } }, ms);
    watchdogs.push({ done: done.promise, finish: done.release, handle });
    return handle;
  }) as typeof window.setTimeout });
  Object.defineProperty(window, "clearTimeout", { ...clearDescriptor, value: (handle?: number) => {
    clearNativeTimer(handle);
    watchdogs.find((timer) => timer.handle === handle)?.finish();
  } });

  const answerTabs: TabCoordinator = {
    post(message) {
      if (releasing && message.type === "delivery" && message.delivery.submissionId === armed?.submissionId) publications++;
      native.post(message);
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    claim(id, onOwned) {
      return native.claim(id, () => {
        if (role === "b" && id === armed?.submissionId) {
          granted = true;
          // claim's callback permits an async return. The manager preserves
          // its takeover promise so the fixture can join the real continuation.
          takeover = Promise.resolve(onOwned()).then(() => { takeoverDone = true; });
        } else onOwned();
      });
    },
    exclusive: native.exclusive,
    dispose,
  };
  const answerStorage: AnswerStorage = {
    ...storage,
    async remove(id) {
      if (role !== "a" || id !== armed?.submissionId || removeEntered) return storage.remove(id);
      removeEntered = true;
      try {
        await bounded(removeGate.promise);
        await storage.remove(id);
        removeCommitted = true;
      } finally { removeDone.release(); }
    },
    async load() {
      if (role !== "b" || !armed || !granted || loadCaptured) return storage.load();
      const records = await storage.load();
      const item = records[0] as { requestId?: string; submissionId?: string; sent?: boolean } | undefined;
      if (records.length !== 1 || item?.requestId !== armed.requestId || item.submissionId !== armed.submissionId || item.sent !== true)
        error = "Native takeover read must capture exactly the matching sent record";
      loadCaptured = true;
      await bounded(loadGate.promise);
      return records;
    },
  };
  const api = {
    arm(requestId: string, submissionId: string) {
      if (armed) throw new Error("Already armed");
      armed = { requestId, submissionId };
      safety = setNativeTimer(() => { error = "Control hold deadline expired"; releaseAll(); }, 20_000);
    },
    status: () => ({ removeEntered, removeCommitted, loadCaptured, removedCaptured: !!removed, removedDelivered, takeoverDone, error }),
    async deliverRemoved() {
      const nativeCompletion = nativeCompletions.get(`odysseus-answers:answers:${armed?.submissionId}`);
      if (!removed || !loadCaptured || error || !nativeCompletion) throw new Error(`Invalid removed premise: ${error}`);
      const message = removed; removed = undefined; removedDelivered = true;
      deliver(message);
      await bounded(nativeCompletion);
      if (root!.answers.held().length !== 0 || root!.stores.chat.getState().deliveries[armed!.requestId]?.state !== "answered")
        throw new Error("Removed handler must forget the entry and show answered before read release");
    },
    async finishRemove() {
      removeGate.release(); await bounded(removeDone.promise);
      if (!removeCommitted || (await storage.load()).length !== 0) throw new Error("Native deletion must commit empty storage");
    },
    async finishLoad() {
      if (!takeover || !loadCaptured || !removedDelivered || error) throw new Error(`Invalid load premise: ${error}`);
      clearNativeTimer(safety);
      releasing = true;
      loadGate.release();
      await bounded(takeover);
      postBarrier({ type: "takeover-barrier", submissionId: armed!.submissionId });
      await bounded(channelDone.promise);
      // Join any real status receipt after its production handler, then drain
      // all watchdogs registered by the completed continuation. No orphan-only
      // event is required for the green control to finish.
      if (acceptedReceipts < statusQueries) await bounded(new Promise<void>((resolve) => { receiptWaiters.push(resolve); }));
      for (let i = 0; i < watchdogs.length; i++) await bounded(watchdogs[i]!.done);
      return { publications, statusQueries, watchdogs: watchdogs.length, takeoverDone };
    },
    releaseAll,
    dispose,
  };
  return { answerStorage, answerTabs, api, bind(value: BrainUiRoot) {
    root = value;
    const receiptDescriptor = Object.getOwnPropertyDescriptor(root.answers, "receipt");
    const receipt = root.answers.receipt;
    restoreReceipt = () => restore(root!.answers, "receipt", receiptDescriptor);
    root.answers.receipt = (frame) => {
      receipt(frame);
      if (releasing && frame.submissionId === armed?.submissionId && frame.state === "accepted") {
        acceptedReceipts++;
        if (acceptedReceipts >= statusQueries) for (const resolve of receiptWaiters.splice(0)) resolve();
      }
    };
  } };
}

export type TakeoverControl = NonNullable<ReturnType<typeof answerTakeoverControl>>["api"];
