import { createStore } from "zustand/vanilla";
import type { ChatSession } from "@schlessera/brain-ui-sdk/protocol";
import type { StoreEnvironment } from "./store-environment.js";

/**
 * The cross-backend handoff (#61): which review sheet is open, what the host
 * has said about it, and the links between sources and destinations.
 *
 * A small standalone store, like the mask request: the sheet is modal, one
 * is open at a time, and nothing here belongs in a transcript. The form the
 * user edits (text, references, destination) is the sheet's own state; this
 * holds what arrives over the socket, so a frame handler can reach it.
 */
export interface HandoffSheetTarget {
  sourceSessionId: string;
  /** Minted per open: the idempotency key of everything this review sends. */
  handoffId: string;
  /** The source was opened for this review; snapshot its replayed history. */
  awaitHistory?: boolean;
}

/** The model summary for the open sheet (R1: it runs when the sheet opens). */
export interface HandoffDraftState {
  state: "idle" | "running" | "ready" | "failed" | "cancelled";
  text?: string;
  message?: string;
  costUsd?: number;
  runId?: string;
}

/** Where `Start new chat` stands. */
export type HandoffPhase =
  | { kind: "review" }
  | { kind: "creating" }
  | { kind: "checking" }
  | { kind: "refused"; message: string }
  | { kind: "uncertain" };

/** What the destination was sent, so its first message can be drawn before history. */
export interface HandoffSend {
  handoffId: string;
  requestId: string;
  /** Echoed on `session_info`; never the chat draft's, so no draft adopts it. */
  draftId: string;
  text: string;
  providerId: string;
}

export interface HandoffLink {
  sessionId: string;
  title: string | null;
  backendId?: string;
  /** Messages the source had when it was handed off; absent means unknown. */
  afterMessages?: number;
}

export interface HandoffState {
  sheet: HandoffSheetTarget | null;
  /**
   * The summary run the sheet is waiting on. Each run (the one at open, and
   * each explicit Refresh) gets its own id, so a late answer from a stopped
   * run can never overwrite the current one.
   */
  prepareId: string | null;
  draft: HandoffDraftState;
  phase: HandoffPhase;
  pendingSend: HandoffSend | null;
  /** The destination the open review created, once anything names it. */
  created: { handoffId: string; sessionId: string; live: boolean } | null;
  /** Destinations by source session: the source's forward markers. */
  forward: Record<string, HandoffLink[]>;
  /** Source by destination session: the destination's handoff card link. */
  from: Record<string, HandoffLink>;

  open(sourceSessionId: string, handoffId: string, options?: { awaitHistory?: boolean }): void;
  close(): void;
  /** Begin waiting on a summary run under its own id. */
  startPrepare(prepareId: string): void;
  /** A run's answer; only the current run's is kept. */
  setDraft(prepareId: string, draft: HandoffDraftState): void;
  setPhase(phase: HandoffPhase): void;
  beginSend(send: HandoffSend): void;
  /** A refused send names its request; anything else is not ours. */
  noteRefusal(requestId: string, message: string): void;
  noteReceipt(handoffId: string, state: "created" | "pending" | "none", sessionId?: string): void;
  noteCreated(handoffId: string, sessionId: string, live: boolean): void;
  /** Index the links the session list carries. */
  setLinks(sessions: readonly ChatSession[]): void;
  addLink(sourceSessionId: string, destination: HandoffLink, source: HandoffLink): void;
}

export function createHandoffStore(_env?: StoreEnvironment) {
  return createStore<HandoffState>((set, get) => ({
    sheet: null,
    prepareId: null,
    draft: { state: "idle" },
    phase: { kind: "review" },
    pendingSend: null,
    created: null,
    forward: {},
    from: {},

    open: (sourceSessionId, handoffId, options) =>
      set({ sheet: { sourceSessionId, handoffId, ...(options?.awaitHistory ? { awaitHistory: true } : {}) }, prepareId: null, draft: { state: "idle" }, phase: { kind: "review" }, pendingSend: null, created: null }),
    close: () => set({ sheet: null, prepareId: null, draft: { state: "idle" }, phase: { kind: "review" }, pendingSend: null, created: null }),
    startPrepare: (prepareId) => set({ prepareId, draft: { state: "running" } }),
    setDraft: (prepareId, draft) => {
      if (get().prepareId === prepareId) set({ draft });
    },
    setPhase: (phase) => set({ phase }),
    beginSend: (pendingSend) => set({ pendingSend, phase: { kind: "creating" } }),
    noteRefusal: (requestId, message) => {
      if (get().pendingSend?.requestId !== requestId) return;
      set({ phase: { kind: "refused", message } });
    },
    noteReceipt: (handoffId, state, sessionId) => {
      if (get().sheet?.handoffId !== handoffId) return;
      if (state === "created" && sessionId) set({ created: { handoffId, sessionId, live: false } });
      // Nothing exists for this key: the send is refused, the text kept.
      else if (state === "none") set({ phase: { kind: "refused", message: "The new chat wasn't created." } });
      else set({ phase: { kind: "uncertain" } });
    },
    noteCreated: (handoffId, sessionId, live) => {
      if (get().sheet?.handoffId !== handoffId) return;
      set({ created: { handoffId, sessionId, live } });
    },
    setLinks: (sessions) => {
      const forward: Record<string, HandoffLink[]> = {};
      const from: Record<string, HandoffLink> = {};
      for (const session of sessions) {
        const link = session.handoffFrom;
        if (!link) continue;
        from[session.id] = { sessionId: link.sessionId, title: link.title, ...(link.backendId ? { backendId: link.backendId } : {}) };
        (forward[link.sessionId] ??= []).push({
          sessionId: session.id,
          title: session.title,
          ...(session.backendId ? { backendId: session.backendId } : {}),
          ...(link.afterMessages !== undefined ? { afterMessages: link.afterMessages } : {}),
        });
      }
      set({ forward, from });
    },
    addLink: (sourceSessionId, destination, source) =>
      set((state) => ({
        forward: {
          ...state.forward,
          [sourceSessionId]: [
            ...(state.forward[sourceSessionId] ?? []).filter((link) => link.sessionId !== destination.sessionId),
            destination,
          ],
        },
        from: { ...state.from, [destination.sessionId]: source },
      })),
  }));
}
