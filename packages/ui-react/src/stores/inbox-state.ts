import { createStore } from "zustand/vanilla";
import type {
  InboxActionItem,
  InboxActionStatus,
  InboxDelta,
  InboxDismissReason,
  InboxItem,
  InboxSnapshot,
  InboxThread,
  InboxView,
} from "@schlessera/brain-ui-sdk/protocol";

/**
 * Client mirror of the durable Queue and Actions (#684).
 *
 * The server is the only authority: this store holds what the snapshot-then-
 * delta stream delivered and the submissions this device has in flight. It
 * never removes a card, flips a status or claims an effect applied on its
 * own — every visible change to a decision is driven by a confirmed delta or a
 * fresh snapshot (the approved design's "no optimistic removal").
 *
 * Ordering follows the protocol: a delta before its view's first snapshot is
 * ignored, and a delta at or below the thread's high-water seq is discarded.
 * A reconnect starts with a fresh snapshot, which also reconciles anything
 * that was sent but never confirmed.
 *
 * Refusals cannot be attributed: `INBOX_DECISION_REFUSED` names no item. So a
 * refusal unlocks EVERY decision in flight and the caller re-subscribes for a
 * fresh snapshot, from which each card learns its own outcome (ruling R2). No
 * decision is ever re-sent automatically.
 */

export type DecisionKind = "commit" | "later" | "dismiss";

export interface InFlightDecision {
  kind: DecisionKind;
  /** The stored option selected, absent for Later (`inbox_snooze`). */
  optionId?: string;
  /** "Approve", "Apply: journeys/ogygia.md", "Dismiss", "Later". */
  label: string;
  /** What the receipt says once confirmed: "Approved · queued Edit → …". */
  receipt: string;
  reason?: InboxDismissReason;
  /**
   * More than one stored option leads to the same status (two commit
   * options both end `resolved`), so a status alone cannot say whose answer
   * won. Such a confirmation is reported without claiming it was this one.
   */
  ambiguous?: boolean;
  sentVersion: number;
  /**
   * applying: sent on the live socket, waiting for its delta.
   * unconfirmed: the socket dropped before a confirmation arrived.
   * refused: a refusal arrived; waiting for the fresh snapshot.
   */
  state: "applying" | "unconfirmed" | "refused";
}

export type InboxOutcome =
  | {
      kind: "receipt";
      status: Extract<InboxActionStatus, "resolved" | "dismissed" | "snoozed">;
      /** Who made it, as far as this device can know. */
      by: "you" | "elsewhere" | "unknown";
      afterReconnect?: boolean;
      waitUntil?: number;
      reason?: InboxDismissReason;
      /** This device's receipt text, when the answer was its own. */
      text?: string;
      /** Set when this device's own answer lost to another one. */
      lost?: string;
    }
  | { kind: "not-received"; label: string }
  | { kind: "not-applied" }
  | { kind: "gone"; status: "dropped" | "expired" | "removed" };

export interface InboxChangeNotice {
  fields: string[];
  before: InboxActionItem;
  reviewed: boolean;
}

interface ViewMirror {
  /** A snapshot has arrived on the current connection. */
  ready: boolean;
  highWaterSeq: Record<string, number>;
}

export interface InboxState {
  /** server_hello advertised durable Queue/Actions. */
  supported: boolean;
  /** The socket is up and both views hold a snapshot from it. */
  online: boolean;
  /** When the mirror last heard from the server. */
  asOf: number | null;
  views: Record<InboxView, ViewMirror>;
  threads: Record<string, InboxThread>;
  items: Record<string, InboxItem>;
  inFlight: Record<string, InFlightDecision>;
  outcomes: Record<string, InboxOutcome>;
  changes: Record<string, InboxChangeNotice>;

  setSupported: (supported: boolean) => void;
  /** The socket closed: nothing in flight can be confirmed until a snapshot. */
  connectionLost: () => void;
  applySnapshot: (msg: InboxSnapshot) => void;
  applyDelta: (msg: InboxDelta) => void;
  /** Record a submission the caller has just sent. False if one is in flight. */
  beginDecision: (itemId: string, decision: Omit<InFlightDecision, "state" | "sentVersion">) => boolean;
  /**
   * A refusal arrived. Returns true when a fresh snapshot is needed. With
   * `settle` (the host cannot take decisions at all) nothing in flight can
   * have applied, so each one settles as not applied at once.
   */
  decisionRefused: (settle?: boolean) => boolean;
  reviewChanges: (itemId: string) => void;
  /** Drop receipts for decisions that are already terminal. */
  clearReceipts: (exceptItemId?: string) => void;
  clear: () => void;
}

const TERMINAL: readonly InboxActionStatus[] = ["resolved", "dismissed", "snoozed"];
const OPEN: readonly InboxActionStatus[] = ["pending", "snoozed"];

function isAction(item: InboxItem | undefined): item is InboxActionItem {
  return item?.queue === "actions";
}

/** Which status confirms this device's answer. */
function confirms(kind: DecisionKind): InboxActionStatus {
  return kind === "dismiss" ? "dismissed" : kind === "later" ? "snoozed" : "resolved";
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fields of a decision that changed between two versions, in the words
 * the card prints. Status and timestamps are not "the decision changing".
 */
export function changedDecisionFields(before: InboxActionItem, after: InboxActionItem): string[] {
  const fields: string[] = [];
  if (before.payload.title !== after.payload.title) fields.push("title");
  if (before.payload.detail !== after.payload.detail) fields.push("detail");
  if (before.type !== after.type) fields.push("kind");
  const ids = (item: InboxActionItem) => item.options.map((o) => `${o.id}\u0000${o.label}`);
  if (!sameJson(ids(before), ids(after))) fields.push("options");
  const effects = (item: InboxActionItem) => Object.fromEntries(item.options.map((o) => [o.id, o.effect]));
  const shared = after.options.filter((o) => before.options.some((b) => b.id === o.id));
  if (shared.some((o) => !sameJson(effects(before)[o.id], o.effect))) fields.push("effect");
  if (before.expiresAt !== after.expiresAt) fields.push("expiry");
  return fields;
}

export function createInboxStore() {
  const emptyViews = (): Record<InboxView, ViewMirror> => ({
    actions: { ready: false, highWaterSeq: {} },
    queue: { ready: false, highWaterSeq: {} },
  });

  /**
   * What a non-append snapshot removed, per view, until the next one. The
   * server chunks a snapshot that exceeds its frame limit, and an item absent
   * from the first chunk may still arrive in an `append` continuation: it is
   * then reconciled against what it was before the snapshot began, not
   * against its own premature removal.
   */
  const removed: Record<InboxView, Map<string, { item?: InboxItem; flight?: InFlightDecision; change?: InboxChangeNotice; outcome?: InboxOutcome }>> = {
    actions: new Map(), queue: new Map(),
  };

  return createStore<InboxState>((set, get) => {
    /**
     * Fold one action's new version into the reconciliation maps. `known`
     * is false for an item this device has never seen, which never earns a
     * "resolved elsewhere" row: it was never on screen to be resolved.
     */
    function reconcile(
      draft: Pick<InboxState, "inFlight" | "outcomes" | "changes">,
      before: InboxItem | undefined,
      after: InboxItem | undefined,
      itemId: string,
      fresh: boolean,
    ): void {
      const flight = draft.inFlight[itemId];
      const prior = isAction(before) ? before : undefined;
      const next = isAction(after) ? after : undefined;
      if (after && !next) return;
      if (!next) {
        // Removed outright. Only an item someone could see deserves a row.
        if (flight || (prior && OPEN.includes(prior.status))) {
          draft.outcomes[itemId] = { kind: "gone", status: "removed" };
        }
        delete draft.inFlight[itemId];
        delete draft.changes[itemId];
        return;
      }
      if (next.type === "fyi") return;
      const wasOpen = prior ? OPEN.includes(prior.status) : false;
      // A snooze from elsewhere does not answer an Approve or Dismiss sent
      // from here: the server still accepts both on a snoozed decision, so
      // that answer stays in flight until its own confirmation.
      const pendingAnswer = next.status === "snoozed" && flight !== undefined && flight.kind !== "later";
      if (TERMINAL.includes(next.status) && next.status !== prior?.status && !pendingAnswer) {
        const status = next.status as "resolved" | "dismissed" | "snoozed";
        if (flight) {
          const matches = confirms(flight.kind) === status;
          const mine = matches && !flight.ambiguous;
          draft.outcomes[itemId] = {
            kind: "receipt",
            status,
            by: mine ? (flight.state === "refused" ? "unknown" : "you") : matches ? "unknown" : "elsewhere",
            ...(flight.state === "unconfirmed" && mine ? { afterReconnect: true } : {}),
            ...(next.waitUntil !== undefined ? { waitUntil: next.waitUntil } : {}),
            ...(mine && flight.reason ? { reason: flight.reason } : {}),
            ...(mine ? { text: flight.receipt } : {}),
            ...(!matches ? { lost: flight.label } : {}),
          };
          delete draft.inFlight[itemId];
        } else if (wasOpen) {
          draft.outcomes[itemId] = {
            kind: "receipt",
            status,
            by: "elsewhere",
            ...(next.waitUntil !== undefined ? { waitUntil: next.waitUntil } : {}),
          };
        }
        delete draft.changes[itemId];
        return;
      }
      if (next.status === "dropped" || next.status === "expired") {
        if (flight || wasOpen) draft.outcomes[itemId] = { kind: "gone", status: next.status };
        delete draft.inFlight[itemId];
        delete draft.changes[itemId];
        return;
      }
      if (!OPEN.includes(next.status)) return;
      // Still open. A changed decision must be reviewed before any answer.
      if (prior && OPEN.includes(prior.status) && next.version > prior.version) {
        // Unreviewed changes accumulate against the version the reader last
        // saw; once reviewed, the reviewed version is the new baseline.
        const pending = draft.changes[itemId] && !draft.changes[itemId].reviewed ? draft.changes[itemId] : undefined;
        const before = pending?.before ?? prior;
        const fields = changedDecisionFields(before, next);
        if (fields.length > 0) draft.changes[itemId] = { fields, before, reviewed: false };
      }
      // A fresh snapshot settles anything this device could not confirm.
      if (fresh && flight && flight.state !== "applying") {
        draft.outcomes[itemId] = flight.state === "unconfirmed"
          ? { kind: "not-received", label: flight.label }
          : { kind: "not-applied" };
        delete draft.inFlight[itemId];
      }
    }

    return {
      supported: false,
      online: false,
      asOf: null,
      views: emptyViews(),
      threads: {},
      items: {},
      inFlight: {},
      outcomes: {},
      changes: {},

      setSupported: (supported) => set(supported ? { supported } : { supported, online: false, views: emptyViews() }),

      connectionLost: () => {
        const inFlight: Record<string, InFlightDecision> = {};
        for (const [id, flight] of Object.entries(get().inFlight)) {
          inFlight[id] = flight.state === "applying" ? { ...flight, state: "unconfirmed" } : flight;
        }
        set({ online: false, views: emptyViews(), inFlight });
      },

      applySnapshot: (msg) => {
        const state = get();
        const draft = {
          inFlight: { ...state.inFlight },
          outcomes: { ...state.outcomes },
          changes: { ...state.changes },
        };
        const items = { ...state.items };
        const threads = msg.append ? { ...state.threads } : {} as Record<string, InboxThread>;
        if (!msg.append) {
          // Threads are shared by both views; keep the other view's until its
          // own snapshot, so the queue never loses its provenance mid-swap.
          for (const [id, thread] of Object.entries(state.threads)) threads[id] = thread;
        }
        for (const thread of msg.threads) threads[thread.id] = thread;
        const seen = new Set<string>();
        const baseline = removed[msg.view];
        if (!msg.append) baseline.clear();
        for (const item of msg.items) {
          if (item.queue !== msg.view) continue;
          seen.add(item.id);
          const earlier = msg.append ? baseline.get(item.id) : undefined;
          if (earlier) {
            // A later chunk carried it after all: undo the removal.
            baseline.delete(item.id);
            if (earlier.flight) draft.inFlight[item.id] = earlier.flight;
            if (earlier.change) draft.changes[item.id] = earlier.change;
            if (earlier.outcome) draft.outcomes[item.id] = earlier.outcome;
            else delete draft.outcomes[item.id];
            reconcile(draft, earlier.item, item, item.id, true);
          } else {
            reconcile(draft, items[item.id], item, item.id, true);
          }
          items[item.id] = item;
        }
        if (!msg.append) {
          const remember = (id: string, item?: InboxItem) => baseline.set(id, {
            ...(item ? { item } : {}),
            ...(draft.inFlight[id] ? { flight: draft.inFlight[id] } : {}),
            ...(draft.changes[id] ? { change: draft.changes[id] } : {}),
            ...(draft.outcomes[id] ? { outcome: draft.outcomes[id] } : {}),
          });
          for (const [id, item] of Object.entries(state.items)) {
            if (item.queue !== msg.view || seen.has(id)) continue;
            remember(id, item);
            reconcile(draft, item, undefined, id, true);
            delete items[id];
          }
          // Settled-by-snapshot entries for items the snapshot did not carry.
          if (msg.view === "actions") {
            for (const [id, flight] of Object.entries(draft.inFlight)) {
              if (items[id] || flight.state === "applying") continue;
              remember(id);
              draft.outcomes[id] = { kind: "gone", status: "removed" };
              delete draft.inFlight[id];
            }
          }
        }
        const highWaterSeq = msg.append ? { ...state.views[msg.view].highWaterSeq } : {};
        for (const [id, seq] of Object.entries(msg.highWaterSeq)) highWaterSeq[id] = seq;
        const views = { ...state.views, [msg.view]: { ready: true, highWaterSeq } };
        set({
          ...draft,
          items,
          threads,
          views,
          online: views.actions.ready && views.queue.ready,
          asOf: Date.now(),
        });
      },

      applyDelta: (msg) => {
        const state = get();
        const view = state.views[msg.view];
        if (!view.ready) return;
        const change = msg.change;
        const floor = Object.hasOwn(view.highWaterSeq, change.threadId) ? view.highWaterSeq[change.threadId]! : 0;
        if (change.seq <= floor) return;
        const draft = {
          inFlight: { ...state.inFlight },
          outcomes: { ...state.outcomes },
          changes: { ...state.changes },
        };
        const items = { ...state.items };
        const threads = { ...state.threads };
        switch (change.kind) {
          case "upsert_thread":
            threads[change.thread.id] = change.thread;
            break;
          case "remove_thread":
            delete threads[change.threadId];
            for (const [id, item] of Object.entries(items)) {
              if (item.threadId !== change.threadId) continue;
              reconcile(draft, item, undefined, id, false);
              delete items[id];
            }
            break;
          case "upsert_item":
            if (change.item.queue === msg.view) {
              reconcile(draft, items[change.itemId], change.item, change.itemId, false);
              items[change.itemId] = change.item;
            }
            break;
          case "remove_item":
            if (items[change.itemId] && items[change.itemId]!.queue === msg.view) {
              reconcile(draft, items[change.itemId], undefined, change.itemId, false);
              delete items[change.itemId];
            }
            break;
        }
        set({
          ...draft,
          items,
          threads,
          views: { ...state.views, [msg.view]: { ...view, highWaterSeq: { ...view.highWaterSeq, [change.threadId]: change.seq } } },
          asOf: Date.now(),
        });
      },

      beginDecision: (itemId, decision) => {
        const state = get();
        const item = state.items[itemId];
        if (state.inFlight[itemId] || !isAction(item) || !OPEN.includes(item.status)) return false;
        const outcomes = { ...state.outcomes };
        delete outcomes[itemId];
        set({
          inFlight: { ...state.inFlight, [itemId]: { ...decision, sentVersion: item.version, state: "applying" } },
          outcomes,
        });
        get().clearReceipts(itemId);
        return true;
      },

      decisionRefused: (settle = false) => {
        const inFlight: Record<string, InFlightDecision> = {};
        const outcomes = { ...get().outcomes };
        let any = false;
        for (const [id, flight] of Object.entries(get().inFlight)) {
          // A refusal while one is still waiting for its snapshot asks again:
          // the earlier request may itself have been the frame refused.
          if (flight.state === "refused" && !settle) any = true;
          if (flight.state === "unconfirmed" || (flight.state === "refused" && !settle)) { inFlight[id] = flight; continue; }
          any = true;
          if (settle) outcomes[id] = { kind: "not-applied" };
          else inFlight[id] = { ...flight, state: "refused" };
        }
        set({ inFlight, outcomes });
        return any && !settle;
      },

      reviewChanges: (itemId) => {
        const notice = get().changes[itemId];
        if (!notice || notice.reviewed) return;
        set({ changes: { ...get().changes, [itemId]: { ...notice, reviewed: true } } });
      },

      clearReceipts: (exceptItemId) => {
        const state = get();
        const outcomes: Record<string, InboxOutcome> = {};
        let changed = false;
        for (const [id, outcome] of Object.entries(state.outcomes)) {
          const item = state.items[id];
          const open = isAction(item) && OPEN.includes(item.status);
          if (id !== exceptItemId && !open) { changed = true; continue; }
          outcomes[id] = outcome;
        }
        if (changed) set({ outcomes });
      },

      clear: () => { removed.actions.clear(); removed.queue.clear(); set({
        supported: false, online: false, asOf: null, views: emptyViews(),
        threads: {}, items: {}, inFlight: {}, outcomes: {}, changes: {},
      }); },
    };
  });
}

/** The badge's one number, minus live approvals: open, non-FYI decisions. */
export function pendingDecisionCount(state: Pick<InboxState, "items">): number {
  let count = 0;
  for (const item of Object.values(state.items)) {
    if (item.queue === "actions" && item.type !== "fyi" && item.status === "pending") count++;
  }
  return count;
}
