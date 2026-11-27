import { createStore } from "zustand/vanilla";
import type { BrainApi } from "../lib/api-client.js";
import type { StoreEnvironment } from "./store-environment.js";

/** One stored session, as `GET /api/sessions` lists it. */
export type ListedSession = Awaited<ReturnType<BrainApi["sessions"]>>["sessions"][number];

export interface SessionListState {
  /** The last list the host returned; kept through a failed refresh. */
  sessions: ListedSession[];
  /** A refresh is in flight. */
  loading: boolean;
  /** Some list has arrived since the root was made. */
  loaded: boolean;
  /** Printed above the rows: a partial list, or a refresh that failed. */
  warning: string | null;
  /**
   * Ask the host for the list again. One request chain (the list and the
   * retained-conversation pages after it) is in flight at a time (#4754): a
   * call made while one runs sends nothing and marks one follow-up, which
   * every call made during that chain shares. The follow-up chain starts
   * only after the in-flight one settled, because that one may have been
   * sent before the host saved a label (#1004); its answer replaces the
   * first. The promise of a coalesced call settles with the follow-up.
   */
  refresh(): Promise<void>;
}

/**
 * The root's session list (`GET /api/sessions`), read by every surface that
 * names a session: the Sessions drawer below 1280, the Sessions pane at
 * ≥1280, and the working-session pills, whose labels come from it at render
 * time (D52 §4: the tracker record stores no title). One list per root, so
 * the pane, the drawer and the pills cannot disagree about a title.
 *
 * Handoff links (#61) are indexed from every answer, as the drawer did.
 */
export function createSessionListStore(env: Pick<StoreEnvironment, "api">, onList?: (sessions: ListedSession[]) => void) {
  let latest = 0;
  /** The chain in flight, and the one follow-up marked behind it. */
  let inFlight: Promise<void> | null = null;
  let followUp: Promise<void> | null = null;
  return createStore<SessionListState>((set) => {
    async function chain() {
      const mine = ++latest;
      set({ loading: true });
      try {
        const data = await env.api.sessions();
        // Merged by id: each row's id is its React key, so a page that
        // repeats a conversation must not draw it twice.
        const retained = new Map((data.retainedConversations ?? []).map((h) => [h.id, h]));
        let cursor = data.retainedAfter;
        while (cursor && mine === latest) {
          const next = await env.api.sessions(cursor);
          for (const h of next.retainedConversations ?? []) if (!retained.has(h.id)) retained.set(h.id, h);
          if (next.retainedAfter === cursor) throw new Error("Repeated history cursor");
          cursor = next.retainedAfter;
        }
        if (mine !== latest) return;
        onList?.(data.sessions);
        set({
          sessions: [...data.sessions,...[...retained.values()].map(h=>({id:`dialogue:${h.id}`,title:"Voice conversation",createdAt:h.created_at,lastActiveAt:h.created_at,totalCostUsd:0,numTurns:0,historyOwnerId:h.id}))],
          loaded: true,
          warning: data.unavailableBackends?.length
            ? "Some session histories are unavailable. Showing available sessions."
            : null,
        });
      } catch {
        if (mine === latest) set({ warning: "Could not refresh sessions. Please retry." });
      } finally {
        // A marked follow-up keeps the list loading until it settles.
        if (mine === latest && !followUp) set({ loading: false });
      }
    }
    function start(): Promise<void> {
      const running: Promise<void> = chain().finally(() => {
        if (inFlight === running) inFlight = null;
      });
      inFlight = running;
      return running;
    }
    return {
      sessions: [],
      loading: false,
      loaded: false,
      warning: null,
      refresh() {
        if (!inFlight) return start();
        followUp ??= inFlight.then(() => {
          followUp = null;
          return start();
        });
        return followUp;
      },
    };
  });
}
