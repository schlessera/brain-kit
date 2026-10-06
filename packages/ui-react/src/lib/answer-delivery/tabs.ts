/**
 * Two tabs, one queue (#910). Both read the same stored answers, so without
 * coordination both would replay the same submission. Each submission has
 * one owner: the tab holding its Web Lock replays it; any other tab waits for
 * the lock and shows the owner's state, read-only, from its broadcasts. A
 * closed owner releases the lock, and a waiting tab takes over.
 */
import type { AnswerDelivery, QueuedAnswer } from "./types.js";

export type TabMessage =
  /** A submission exists (new, or its record changed). */
  | { type: "item"; item: QueuedAnswer }
  /** The owner's current view of a submission. */
  | { type: "delivery"; delivery: AnswerDelivery }
  /** The record is gone; `delivery` is its final state when there is one. */
  | { type: "removed"; submissionId: string; requestId: string; delivery?: AnswerDelivery }
  /** Everything was cleared (logout). */
  | { type: "cleared" };

export interface TabCoordinator {
  post(message: TabMessage): void;
  subscribe(listener: (message: TabMessage) => void): () => void;
  /**
   * Ask to own one submission. `onOwned` runs when this tab holds it, which
   * may be at once or after another tab lets go. The returned function lets
   * go, or withdraws a request still waiting.
   */
  claim(submissionId: string, onOwned: () => void): () => void;
  /** Run `fn` while holding a lock no other tab can hold at the same time. */
  exclusive<T>(name: string, fn: () => Promise<T>): Promise<T>;
  dispose(): void;
}

/** Real tabs: a BroadcastChannel and the Web Locks API. */
export function createBrowserTabCoordinator(name: string): TabCoordinator | null {
  if (typeof BroadcastChannel === "undefined" || typeof navigator === "undefined" || !navigator.locks) return null;
  const channel = new BroadcastChannel(name);
  const listeners = new Set<(message: TabMessage) => void>();
  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    for (const listener of listeners) listener(event.data);
  };
  const releases = new Set<() => void>();
  return {
    post: (message) => channel.postMessage(message),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    claim(submissionId, onOwned) {
      const abort = new AbortController();
      let release: (() => void) | null = null;
      let done = false;
      void navigator.locks
        .request(`${name}:${submissionId}`, { signal: abort.signal }, () => {
          if (done) return;
          return new Promise<void>((resolve) => {
            release = resolve;
            onOwned();
          });
        })
        .catch(() => {
          // Withdrawn while waiting.
        });
      const letGo = () => {
        if (done) return;
        done = true;
        releases.delete(letGo);
        if (release) release();
        else abort.abort();
      };
      releases.add(letGo);
      return letGo;
    },
    exclusive: (lock, fn) => navigator.locks.request(`${name}:${lock}`, () => fn()) as Promise<never>,
    dispose() {
      for (const letGo of [...releases]) letGo();
      listeners.clear();
      channel.close();
    },
  };
}

/**
 * Tabs in one process, for tests: every coordinator from one hub shares the
 * locks and hears the others' broadcasts (never its own, as with a real
 * BroadcastChannel). A lone coordinator is a single tab.
 */
export function createTabHub() {
  const members = new Set<{ deliver: (m: TabMessage) => void }>();
  const locks = new Map<string, Array<{ grant: () => void }>>();
  function grantNext(key: string) {
    const queue = locks.get(key);
    if (!queue || queue.length === 0) {
      locks.delete(key);
      return;
    }
    queue[0]!.grant();
  }
  const exclusives = new Map<string, Promise<unknown>>();
  return {
    tab(): TabCoordinator {
      const listeners = new Set<(message: TabMessage) => void>();
      const member = {
        deliver: (m: TabMessage) => {
          for (const listener of listeners) listener(structuredClone(m));
        },
      };
      members.add(member);
      const held = new Set<() => void>();
      return {
        post(message) {
          for (const other of members) if (other !== member) other.deliver(message);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        claim(submissionId, onOwned) {
          const queue = locks.get(submissionId) ?? [];
          locks.set(submissionId, queue);
          let granted = false;
          let done = false;
          const entry = {
            grant: () => {
              if (done || granted) return;
              granted = true;
              onOwned();
            },
          };
          queue.push(entry);
          if (queue.length === 1) queueMicrotask(() => entry.grant());
          const letGo = () => {
            if (done) return;
            done = true;
            held.delete(letGo);
            const q = locks.get(submissionId) ?? [];
            const wasHead = q[0] === entry;
            q.splice(q.indexOf(entry), 1);
            if (wasHead) queueMicrotask(() => grantNext(submissionId));
          };
          held.add(letGo);
          return letGo;
        },
        exclusive(name, fn) {
          const before = exclusives.get(name) ?? Promise.resolve();
          const run = before.then(fn, fn);
          exclusives.set(name, run.catch(() => {}));
          return run;
        },
        dispose() {
          for (const letGo of [...held]) letGo();
          listeners.clear();
          members.delete(member);
        },
      };
    },
  };
}
