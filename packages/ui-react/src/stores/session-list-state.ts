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
   * Ask the host for the list again. Calls overlap freely: the newest one's
   * answer is the one kept, so a slow early answer cannot replace a later one.
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
  return createStore<SessionListState>((set) => ({
    sessions: [],
    loading: false,
    loaded: false,
    warning: null,
    async refresh() {
      const mine = ++latest;
      set({ loading: true });
      try {
        const data = await env.api.sessions();
        if (mine !== latest) return;
        onList?.(data.sessions);
        set({
          sessions: data.sessions,
          loaded: true,
          warning: data.unavailableBackends?.length
            ? "Some session histories are unavailable. Showing available sessions."
            : null,
        });
      } catch {
        if (mine === latest) set({ warning: "Could not refresh sessions. Please retry." });
      } finally {
        if (mine === latest) set({ loading: false });
      }
    },
  }));
}
