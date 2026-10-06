/**
 * The answer queue (#910): every submitted ask answer goes through here, from
 * Submit to the host's receipt.
 *
 * The rule it exists to keep is the one the old code broke: a card says an
 * answer was answered only when the host says so. Local `send()` success is
 * "awaiting", and a socket that is gone is "queued". Everything in between is
 * the approved state machine (docs/decisions/answer-delivery.md):
 *
 *   Submit ─► saving ─┬─► queued ──(host back, status: pending)──► awaiting
 *                     ├─► awaiting ──(receipt: accepted)──► answered
 *                     ├─► full / notSaved (nothing admitted; card stays editable)
 *                     └─► update (a peer cannot do receipts)
 *   awaiting ──(5 s, no receipt)──► ask again, same submission
 *   queued/awaiting ──(receipt: closed)──► closed;  (24 h)──► expired
 *   queued ──(Cancel sending)──► cancelled;  principal change ──► signedOut
 *
 * Only an explicitly submitted answer is ever queued, and it is replayed only
 * for its original principal, session, turn and request. A replay always asks
 * the host for the request's status first; the answer goes out again only
 * while the host says the request is still waiting.
 */
import type { ClientMessage, ServerAskAnswerReceipt } from "@schlessera/brain-ui-sdk/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { ChatState } from "../../stores/chat-state.js";
import { parseQueuedAnswer, type AnswerStorage } from "./storage.js";
import type { TabCoordinator, TabMessage } from "./tabs.js";
import {
  answerFrame,
  MAX_QUEUED_ANSWERS,
  MAX_QUEUED_BYTES,
  MAX_REPLAY_AGE_MS,
  queuedBytes,
  RECEIPT_WATCHDOG_MS,
  type AnswerDelivery,
  type AnswerPayload,
  type QueuedAnswer,
} from "./types.js";

/** What the queue needs from the connection. */
export interface DeliveryTransport {
  /** Send on the open socket; false when there is none. */
  send(message: ClientMessage): boolean;
  /** Connected, and the host's hello (or its absence) is known. */
  ready(): boolean;
  /** The host advertised `askReceipts`. */
  supportsReceipts(): boolean;
  /** This connection's `server_hello.principalKey`. */
  principalKey(): string | null;
  /** Probe the socket; replace it if it does not answer. */
  checkLiveness(): void;
}

export interface SubmitAnswer {
  requestId: string;
  sessionId: string | null;
  turnId?: string;
  payload: AnswerPayload;
  /** Move focus to the card's status (design §6). Off for a composer answer. */
  focus?: boolean;
}

export interface AnswerDeliveryOptions {
  chat: StoreApi<ChatState>;
  /** null: this page cannot store answers, so it cannot queue them either. */
  storage: AnswerStorage | null;
  /** null: a single tab, which owns everything it knows. */
  tabs: TabCoordinator | null;
  transport: DeliveryTransport;
  /** A stored record failed validation and was dropped. */
  onCorruptRecord?: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  newId?: () => string;
}

interface Entry {
  item: QueuedAnswer;
  owned: boolean;
  letGo?: () => void;
  watchdog?: unknown;
  expiry?: unknown;
  /** Waiting for a status reply before (re)sending. */
  checking?: boolean;
  /** Cancel sending is removing it: nothing more may go out. */
  cancelling?: boolean;
}

export type AnswerDeliveryQueue = ReturnType<typeof createAnswerDelivery>;

export function createAnswerDelivery(options: AnswerDeliveryOptions) {
  const { chat, transport } = options;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const newId = options.newId ?? (() => crypto.randomUUID());
  let storage = options.storage;
  const tabs = options.tabs;

  const entries = new Map<string, Entry>();
  const byRequest = new Map<string, string>();
  /** Cancelled submissions still owed a status reply (Cancel sending). */
  const cancelled = new Map<string, QueuedAnswer>();
  /** Answers refused admission, kept so `Try again` can resubmit them. */
  const refused = new Map<string, SubmitAnswer>();
  /** Requests with a Submit in flight, so a second tap is not a second answer. */
  const saving = new Set<string>();
  let principal: string | null = null;
  let disposed = false;
  let started: Promise<void> | null = null;
  /** start() has finished, so a Submit need not wait for it. */
  let loaded = false;
  /** Bumped by logout; an admission or restore that started before it is void. */
  let epoch = 0;
  /** The last restore could not read storage; try again on reconnect. */
  let restoreFailed = false;

  // ---------------------------------------------------------------- views

  function show(delivery: AnswerDelivery, broadcast: boolean): void {
    chat.getState().setDelivery(delivery.requestId, delivery);
    if (broadcast) tabs?.post({ type: "delivery", delivery: { ...delivery, focus: false, mirror: false } });
  }

  function viewOf(entry: Entry, patch: Partial<AnswerDelivery> = {}): AnswerDelivery {
    const { item } = entry;
    const current = chat.getState().deliveries[item.requestId];
    return {
      requestId: item.requestId,
      submissionId: item.submissionId,
      sessionId: item.sessionId,
      state: item.sent ? "awaiting" : "queued",
      payload: item.payload,
      submittedAt: item.submittedAt,
      ...(entry.owned ? {} : { mirror: true }),
      ...(current?.submissionId === item.submissionId && current.focus ? { focus: true } : {}),
      ...patch,
    };
  }

  /** Put the submitted answer into the transcript's exchange, read-only. */
  function applyToExchange(item: QueuedAnswer): void {
    const state = chat.getState();
    const key = item.sessionId;
    const p = item.payload;
    switch (p.kind) {
      case "ask_user":
        state.submitAskUserAnswers(key, item.requestId, p.answers, p.annotations, p.typed);
        break;
      case "ask_user_list":
        state.submitAskUserListAnswers(key, item.requestId, p.answers, p.notes);
        break;
      case "ask_user_rank":
        state.submitAskUserRankOrder(key, item.requestId, p.order, p.unchanged);
        break;
      case "ask_user_form":
        state.submitAskUserFormAnswers(key, item.requestId, p.answers, p.visibleNodes);
        break;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  function track(item: QueuedAnswer, owned: boolean): Entry {
    const entry: Entry = { item, owned };
    entries.set(item.submissionId, entry);
    byRequest.set(item.requestId, item.submissionId);
    const remaining = item.submittedAt + MAX_REPLAY_AGE_MS - now();
    entry.expiry = setTimer(() => expire(item.submissionId), Math.max(0, remaining));
    return entry;
  }

  function claim(entry: Entry): void {
    if (!tabs) {
      entry.owned = true;
      return;
    }
    const id = entry.item.submissionId;
    entry.letGo = tabs.claim(id, () => void takeOver(id));
  }

  /** This tab now owns a submission another tab may have been driving. */
  async function takeOver(submissionId: string): Promise<void> {
    const entry = entries.get(submissionId);
    if (!entry || disposed) {
      entry?.letGo?.();
      return;
    }
    if (tabs && storage) {
      // The previous owner may have settled it just before letting go.
      let fresh: QueuedAnswer | null = null;
      try {
        for (const raw of await storage.load()) {
          const parsed = parseQueuedAnswer(raw);
          if (parsed?.submissionId === submissionId) fresh = parsed;
        }
      } catch {
        fresh = entry.item;
      }
      if (!fresh) {
        forget(entry);
        return;
      }
      entry.item = fresh;
    }
    entry.owned = true;
    if (overdue(entry)) return;
    show(viewOf(entry, { mirror: undefined }), true);
    replay(entry);
  }

  function forget(entry: Entry): void {
    clearTimer(entry.watchdog);
    clearTimer(entry.expiry);
    entries.delete(entry.item.submissionId);
    if (byRequest.get(entry.item.requestId) === entry.item.submissionId) byRequest.delete(entry.item.requestId);
    entry.letGo?.();
  }

  /** The submission's journey is over: remove it everywhere and show the outcome. */
  function settle(entry: Entry, patch: Partial<AnswerDelivery>): void {
    forget(entry);
    void storage?.remove(entry.item.submissionId).catch(() => {});
    const delivery = viewOf(entry, { settledAt: now(), ...patch, mirror: undefined });
    show(delivery, false);
    tabs?.post({
      type: "removed",
      submissionId: entry.item.submissionId,
      requestId: entry.item.requestId,
      delivery: { ...delivery, focus: false },
    });
  }

  function expire(submissionId: string): void {
    const entry = entries.get(submissionId);
    if (!entry || !entry.owned) return;
    settle(entry, { state: "expired" });
  }

  // ---------------------------------------------------------------- sending

  function armWatchdog(entry: Entry): void {
    clearTimer(entry.watchdog);
    entry.watchdog = setTimer(() => {
      if (!entries.has(entry.item.submissionId) || !entry.owned) return;
      // No receipt in 5 s: prove the socket, then ask where it stands. The
      // same submission, never a new one, and never assumed rejected.
      transport.checkLiveness();
      if (transport.ready()) askStatus(entry);
      else armWatchdog(entry);
    }, RECEIPT_WATCHDOG_MS);
  }

  function askStatus(entry: Entry): void {
    if (entry.cancelling || overdue(entry)) return;
    const { item } = entry;
    entry.checking = true;
    const sent = transport.send({
      type: "ask_answer_status",
      requestId: item.requestId,
      submissionId: item.submissionId,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    });
    if (sent) armWatchdog(entry);
  }

  /**
   * Past the 24-hour replay bound? Checked wherever an answer could leave, not
   * only by the expiry timer: a page that was frozen past the deadline runs
   * its reconnect before the overdue timer fires.
   */
  function overdue(entry: Entry): boolean {
    if (now() - entry.item.submittedAt < MAX_REPLAY_AGE_MS) return false;
    if (entry.owned) settle(entry, { state: "expired" });
    return true;
  }

  /** Can this tab talk to the host about receipts at all? Shows why not. */
  function usable(entry: Entry): boolean {
    if (entry.cancelling) return false;
    if (overdue(entry)) return false;
    if (!transport.ready()) {
      show(viewOf(entry), true);
      return false;
    }
    if (!transport.supportsReceipts()) {
      show(viewOf(entry, { state: "update" }), true);
      return false;
    }
    if (transport.principalKey() !== entry.item.principalKey) {
      // Another principal holds this connection: this answer can never be
      // sent on it, and must not wait for one that can.
      if (entry.owned) settle(entry, { state: "signedOut" });
      return false;
    }
    return true;
  }

  /** First delivery of a fresh Submit. */
  function deliver(entry: Entry): void {
    if (!entry.owned || !usable(entry)) return;
    if (!entry.item.turnId) {
      // A card rebuilt from history may not know its turn yet: the host's
      // status reply names it.
      show(viewOf(entry), true);
      askStatus(entry);
      return;
    }
    send(entry);
  }

  /** A queued or unconfirmed submission, after a reconnect or a takeover: status first. */
  function replay(entry: Entry): void {
    if (!entry.owned || !usable(entry)) return;
    show(viewOf(entry), true);
    askStatus(entry);
  }

  function send(entry: Entry): void {
    const item = entry.item;
    if (!item.turnId || entry.cancelling || overdue(entry)) return;
    if (!item.sent) {
      // Recorded before it leaves: from here on it may be delivered, so it
      // can no longer be cancelled or edited, only confirmed.
      entry.item = { ...item, sent: true };
      void storage?.put(entry.item).catch(() => {});
      tabs?.post({ type: "item", item: entry.item });
    }
    const ok = transport.send(answerFrame({ ...entry.item, turnId: item.turnId }));
    entry.checking = false;
    show(viewOf(entry), true);
    if (ok) armWatchdog(entry);
  }

  // ---------------------------------------------------------------- inputs

  /**
   * Admit one explicitly submitted answer. Resolves `admitted` once it is
   * stored and on its way, `refused` when it was not (Full, Not saved, or a
   * host without receipts and nowhere to keep it), and `ignored` for a repeat
   * of an answer already in flight.
   */
  async function submit(input: SubmitAnswer): Promise<"admitted" | "refused" | "ignored"> {
    if (!loaded) await start();
    const { requestId } = input;
    if (saving.has(requestId)) return "ignored";
    const existing = chat.getState().deliveries[requestId];
    // One submission per request while one may still arrive. A refused
    // admission is not a submission, so it may be tried again.
    if (existing && !["full", "notSaved", "cancelled", "update"].includes(existing.state)) return "ignored";
    if (byRequest.has(requestId)) return "ignored";
    refused.delete(requestId);
    // Logout during admission voids it: no principal may find this answer.
    const admittedIn = epoch;
    const focus = input.focus !== false;
    const view = (state: "full" | "notSaved" | "update", full?: "count" | "bytes") => {
      refused.set(requestId, input);
      chat.getState().setDelivery(requestId, {
        requestId,
        submissionId: "",
        sessionId: input.sessionId,
        state,
        payload: input.payload,
        submittedAt: now(),
        ...(full ? { full } : {}),
        focus,
      });
      return "refused" as const;
    };
    const key = transport.principalKey() ?? principal;
    // A host known not to do receipts cannot take this answer now. Kept on
    // the device it survives `Reload app` (and replays, status first, once
    // the host is updated); with nowhere to keep it, say Update needed
    // rather than Not saved, which would point at the wrong fix.
    if (transport.ready() && !transport.supportsReceipts() && (!storage || !key)) return view("update");
    if (!storage || !key) return view("notSaved");
    const store = storage;

    saving.add(requestId);
    chat.getState().setDelivery(requestId, {
      requestId,
      submissionId: "",
      sessionId: input.sessionId,
      state: "saving",
      payload: input.payload,
      submittedAt: now(),
      focus,
    });
    let item: QueuedAnswer;
    // Admission is decided and committed under one lock shared by every tab,
    // against what the device actually holds, so two Submits at once (here
    // or in another tab) cannot both take the last place.
    const outcome = await exclusive(async () => {
      // Every stored record counts, valid or not: a budget is about what the
      // device holds, and an unreadable record is still held until removed.
      let held: unknown[];
      try {
        held = await store.load();
      } catch {
        return "notSaved" as const;
      }
      if (held.length >= MAX_QUEUED_ANSWERS) return "count" as const;
      item = {
        v: 1,
        submissionId: newId(),
        principalKey: key,
        requestId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        payload: input.payload,
        submittedAt: now(),
        sent: false,
      };
      const used = held.reduce((n: number, h) => n + queuedBytes(h as QueuedAnswer), 0);
      if (used + queuedBytes(item) > MAX_QUEUED_BYTES) return "bytes" as const;
      try {
        await store.put(item);
      } catch {
        return "notSaved" as const;
      }
      return "saved" as const;
    });
    saving.delete(requestId);
    if (outcome === "notSaved") return view("notSaved");
    if (outcome === "count" || outcome === "bytes") return view("full", outcome);
    const saved = item!;
    if (disposed || epoch !== admittedIn) {
      // Signed out (or torn down) while this was being written: take it back.
      await exclusive(() => store.remove(saved.submissionId)).catch(() => {});
      if (epoch !== admittedIn) {
        chat.getState().setDelivery(requestId, {
          requestId, submissionId: saved.submissionId, sessionId: saved.sessionId, state: "signedOut",
          payload: saved.payload, submittedAt: saved.submittedAt, settledAt: now(),
        });
      }
      return "refused";
    }
    chat.getState().setDelivery(requestId, {
      requestId,
      submissionId: saved.submissionId,
      sessionId: saved.sessionId,
      state: "saving",
      payload: saved.payload,
      submittedAt: saved.submittedAt,
      focus,
    });
    const entry = track(saved, false);
    applyToExchange(saved);
    if (!tabs) {
      entry.owned = true;
      deliver(entry);
      return "admitted";
    }
    // Claimed BEFORE the other tabs hear of it, so this tab is first in line
    // for its own submission and the lock is granted to it at once.
    entry.letGo = tabs.claim(saved.submissionId, () => {
      entry.owned = true;
      deliver(entry);
    });
    tabs.post({ type: "item", item: saved });
    return "admitted";
  }

  /** Run `fn` alone: across tabs when they coordinate, in this tab otherwise. */
  let localTurn: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (tabs) return tabs.exclusive("admission", fn);
    const run = localTurn.then(fn, fn);
    localTurn = run.catch(() => {});
    return run;
  }

  function receipt(frame: ServerAskAnswerReceipt): void {
    const pendingCancel = cancelled.get(frame.submissionId);
    if (pendingCancel) {
      cancelled.delete(frame.submissionId);
      const current = chat.getState().deliveries[pendingCancel.requestId];
      if (!current || current.submissionId !== frame.submissionId) return;
      // Cancelling cannot undo an answer the host already took.
      if (frame.state === "accepted") show({ ...current, state: "answered", settledAt: now() }, false);
      else show({ ...current, state: "cancelled", editable: frame.state === "pending" }, false);
      return;
    }
    const entry = entries.get(frame.submissionId);
    if (!entry || !entry.owned || entry.item.requestId !== frame.requestId) return;
    clearTimer(entry.watchdog);
    if (frame.state === "accepted") {
      settle(entry, { state: "answered" });
      return;
    }
    if (frame.state === "closed") {
      settle(entry, { state: "closed", reason: frame.reason ?? "not_recognized" });
      return;
    }
    // pending: the host is still waiting and does not have this submission.
    // Learn the binding if the card did not know it; never move it.
    const item = entry.item;
    if (item.sessionId && frame.sessionId && frame.sessionId !== item.sessionId) {
      settle(entry, { state: "closed", reason: "refused" });
      return;
    }
    if (!item.turnId && frame.turnId) {
      entry.item = { ...item, turnId: frame.turnId };
      void storage?.put(entry.item).catch(() => {});
    } else if (item.turnId && frame.turnId && frame.turnId !== item.turnId) {
      settle(entry, { state: "closed", reason: "refused" });
      return;
    }
    send(entry);
  }

  /**
   * `Cancel sending`: only for an answer that never left this device. The
   * card reads Cancelled only once the record is gone from storage; a
   * deletion that fails leaves it queued, because a reload would otherwise
   * replay an answer the user was told was stopped.
   */
  async function cancel(requestId: string): Promise<void> {
    const id = byRequest.get(requestId);
    const entry = id ? entries.get(id) : undefined;
    if (!entry || !entry.owned || entry.item.sent || entry.cancelling) return;
    entry.cancelling = true;
    clearTimer(entry.watchdog);
    try {
      const store = storage;
      if (store) await exclusive(() => store.remove(entry.item.submissionId));
    } catch {
      entry.cancelling = false;
      replay(entry);
      return;
    }
    forget(entry);
    cancelled.set(entry.item.submissionId, entry.item);
    const delivery = viewOf(entry, { state: "cancelled", settledAt: now(), mirror: undefined });
    show(delivery, false);
    tabs?.post({ type: "removed", submissionId: entry.item.submissionId, requestId, delivery: { ...delivery, focus: false } });
    // Ask whether the question is still open, so Edit is offered honestly.
    if (transport.ready() && transport.supportsReceipts()) {
      transport.send({
        type: "ask_answer_status",
        requestId,
        submissionId: entry.item.submissionId,
        ...(entry.item.sessionId ? { sessionId: entry.item.sessionId } : {}),
      });
    }
  }

  /** `Edit` on a cancelled answer the host confirmed is still wanted. */
  function edit(requestId: string): void {
    const current = chat.getState().deliveries[requestId];
    if (current?.state !== "cancelled" || !current.editable) return;
    chat.getState().reopenAskExchange(current.sessionId, requestId);
    chat.getState().setDelivery(requestId, null);
  }

  /** The question was dismissed: an answer that was never admitted goes with it. */
  function dismissed(requestId: string): void {
    const current = chat.getState().deliveries[requestId];
    if (current && (current.state === "full" || current.state === "notSaved")) {
      refused.delete(requestId);
      chat.getState().setDelivery(requestId, null);
    }
  }

  /** `Try again` after Full or Not saved. */
  async function retry(requestId: string): Promise<void> {
    const input = refused.get(requestId);
    if (!input) return;
    chat.getState().setDelivery(requestId, null);
    await submit(input);
  }

  function signOut(entry: Entry): void {
    settle(entry, { state: "signedOut" });
  }

  /** Logout: no principal may replay what another submitted. */
  async function logout(): Promise<void> {
    epoch++;
    for (const entry of [...entries.values()]) signOut(entry);
    cancelled.clear();
    principal = null;
    tabs?.post({ type: "cleared" });
    try {
      // Under the admission lock: a Submit already writing either finishes
      // first and is cleared here, or sees the new epoch and takes it back.
      const store = storage;
      if (store) await exclusive(() => store.clear());
    } catch {
      // The next hello will refuse any survivor whose principal differs.
    }
  }

  /** The connection is up and its hello known: revalidate, then replay. */
  function connected(): void {
    if (disposed) return;
    if (restoreFailed && loaded) {
      restoreFailed = false;
      started = null;
      loaded = false;
      // A successful restore replays what it finds, as at startup.
      void start();
    }
    const key = transport.principalKey();
    if (key) {
      for (const entry of [...entries.values()]) {
        if (entry.item.principalKey !== key) signOut(entry);
      }
      if (principal !== key) {
        principal = key;
        void storage?.setPrincipalKey(key).catch(() => {});
      }
    }
    for (const entry of entries.values()) replay(entry);
    // A cancel made offline still owes the user an honest Edit: ask now.
    if (!transport.supportsReceipts()) return;
    for (const item of cancelled.values()) {
      if (item.principalKey !== key) continue;
      transport.send({
        type: "ask_answer_status",
        requestId: item.requestId,
        submissionId: item.submissionId,
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      });
    }
  }

  /** The socket went away: what was awaiting stays awaiting; nothing is retried blind. */
  function disconnected(): void {
    for (const entry of entries.values()) clearTimer(entry.watchdog);
  }

  function onTabMessage(message: TabMessage): void {
    if (disposed) return;
    switch (message.type) {
      case "item": {
        const known = entries.get(message.item.submissionId);
        const item = parseQueuedAnswer(message.item);
        if (!item) return;
        if (known) {
          if (!known.owned) known.item = item;
          return;
        }
        const entry = track(item, false);
        applyToExchange(item);
        show(viewOf(entry), false);
        claim(entry);
        return;
      }
      case "delivery": {
        const id = message.delivery.submissionId;
        const entry = entries.get(id);
        if (entry?.owned) return;
        chat.getState().setDelivery(message.delivery.requestId, { ...message.delivery, mirror: true, focus: false });
        return;
      }
      case "removed": {
        const entry = entries.get(message.submissionId);
        if (entry && !entry.owned) forget(entry);
        if (message.delivery && !entry?.owned) {
          chat.getState().setDelivery(message.requestId, { ...message.delivery, mirror: true, focus: false });
        }
        return;
      }
      case "cleared": {
        epoch++;
        for (const entry of [...entries.values()]) {
          if (entry.owned) signOut(entry);
          else {
            forget(entry);
            show(viewOf(entry, { state: "signedOut", settledAt: now(), mirror: true }), false);
          }
        }
        principal = null;
        return;
      }
    }
  }

  const unsubscribe = tabs?.subscribe(onTabMessage);

  /** Load what this device kept. Safe to call more than once. */
  function start(): Promise<void> {
    started ??= (async () => {
      await restore();
      loaded = true;
    })();
    return started;
  }

  async function restore(): Promise<void> {
    if (!storage) return;
    // A logout (here or in another tab) while this reads makes the snapshot
    // stale: what it holds was just cleared, and must not come back.
    const readIn = epoch;
    let raws: unknown[];
    try {
      principal = principal ?? (await storage.getPrincipalKey());
      raws = await storage.load();
    } catch {
      // Unreadable for now. Nothing is restored, a Submit still tries the
      // store itself (and says Not saved if it fails), and the next
      // connection tries restoring again.
      restoreFailed = true;
      return;
    }
    restoreFailed = false;
    if (epoch !== readIn) return;
    for (const raw of raws) {
      if (disposed) return;
      const item = parseQueuedAnswer(raw);
      if (!item) {
        options.onCorruptRecord?.();
        const id = (raw as { submissionId?: unknown } | null)?.submissionId;
        if (typeof id === "string") void storage.remove(id).catch(() => {});
        continue;
      }
      if (entries.has(item.submissionId)) continue;
      const entry = track(item, false);
      if (now() - item.submittedAt >= MAX_REPLAY_AGE_MS) {
        entry.owned = true;
        settle(entry, { state: "expired" });
        continue;
      }
      applyToExchange(item);
      show(viewOf(entry), false);
      if (!tabs) {
        entry.owned = true;
        if (transport.ready()) replay(entry);
        continue;
      }
      claim(entry);
    }
  }

  return {
    start,
    submit,
    receipt,
    cancel,
    edit,
    retry,
    dismissed,
    logout,
    connected,
    disconnected,
    /** Submissions held on this device, for tests and measurement. */
    held: () => [...entries.values()].map((e) => ({ ...e.item, owned: e.owned })),
    dispose() {
      disposed = true;
      unsubscribe?.();
      for (const entry of [...entries.values()]) forget(entry);
    },
  };
}
