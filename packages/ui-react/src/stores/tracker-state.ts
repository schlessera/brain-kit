import { createStore } from "zustand/vanilla";
import type { SessionRecoveryResult } from "@schlessera/brain-ui-sdk/protocol";
import type { StoreEnvironment } from "./store-environment.js";
import {
  SETTLED_TRACKER_CAP,
  TRACKER_STORAGE_KEY,
  applyLiveEvent,
  applySnapshot,
  applyUnavailable,
  compareTrackers,
  deriveTrackerView,
  evidenceFromRecord,
  isCleared,
  parseTrackerSet,
  seenKey,
  serializeTrackerSet,
  type TrackerEvidence,
  type TrackerLiveEvent,
  type TrackerRecord,
  type TrackerView,
} from "../lib/trackers.js";

export interface TrackerSeenObservation {
  sessionId: string;
  turnId: string;
  revision: number;
}

export interface TrackerStoreState {
  /** The stored set: identifiers only (D52 §4). */
  records: Record<string, TrackerRecord>;
  /** What this page knows about each session's work; never stored. */
  evidence: Record<string, TrackerEvidence>;
  /** A send per session with no acceptance proof yet, by its requestId. Never stored. */
  unconfirmed: Record<string, string>;
  /**
   * Chat requests the host refused on this page, newest last. The composer
   * consumes a refusal's receipt, and a refused request is never accepted,
   * so this is the one place that still knows it is settled.
   */
  refusedRequests: string[];
  /**
   * Chat requests the host accepted on this page, newest last: the
   * receipts that proved it are consumed by the composer, and the latest
   * work moves on.
   */
  acceptedRequests: string[];
  /** Record requests the host has shown it accepted (a queue report, for one). */
  accepted(requestIds: ReadonlyArray<string | null | undefined>): void;
  /**
   * Trackers created only because of an unconfirmed send, by its requestId.
   * If the host then refuses that send, there was never any work to track.
   */
  createdFor: Record<string, string>;
  /** `server_hello.principalKey` the stored set belongs to. */
  principalKey: string | null;
  /** `server_hello.capabilities.sessionRecovery`; null until a hello. */
  recoverySupported: boolean | null;
  /**
   * Sessions whose recovery read is in flight, each with the live events
   * that arrived during it. They are applied after the envelope (rule 6).
   */
  reading: Record<string, TrackerLiveEvent[]>;
  /** Bumped when the set is deleted, so a read begun before cannot write after. */
  epoch: number;
  /**
   * The principal was revoked: nothing is tracked until a hello shows the
   * connection is authorized again, so a leave cannot rebuild the set from
   * the run state the revoked socket left behind.
   */
  suspended: boolean;

  /**
   * Track a session: it was left with work in flight, or its work started
   * while another was in view. A tracker already present starts over unseen.
   */
  track(sessionId: string, options?: { unconfirmedRequestId?: string | null; onlyUnconfirmed?: boolean; now?: number }): void;
  /** The session was left with nothing in flight: a seen tracker goes, an unseen one stays. */
  leftIdle(sessionId: string): void;
  /** Apply one frame's events, or hold them while a read is in flight. */
  live(sessionId: string, events: readonly TrackerLiveEvent[]): void;
  /** A chat request was refused: it is no longer unconfirmed, and it was never accepted. */
  refused(sessionId: string, requestId: string): void;
  /** Mark a read in flight. False when one already is. */
  beginRead(sessionId: string): boolean;
  /** Settle a read begun under `epoch`. */
  endRead(sessionId: string, result: SessionRecoveryResult, epoch: number): void;
  /**
   * The seen observer's report (D52 §4): it clears the tracker only when
   * the key is the latest turn's. An older key never clears a newer tracker.
   */
  observeSeen(observation: TrackerSeenObservation): boolean;
  /**
   * `Mark as seen` (D52 R1), for a latest turn no replay links: the reader's
   * acknowledgement, stored as such and never as proof.
   */
  acknowledge(sessionId: string): void;
  setRecoverySupported(supported: boolean): void;
  /** A hello named a principal. A different one than the set was stored under deletes the set. */
  setPrincipal(principalKey: string | null): void;
  /**
   * Another tab of this root changed the stored set (a `storage` event):
   * this tab takes its trackers as they now stand.
   */
  syncFromStorage(): string[];
  /** A revocation: the whole set goes, and tracking stops until `resume`. */
  revoke(): void;
  /** A hello arrived: the connection is authorized, so tracking resumes. */
  resume(): void;
}

/** Every tracker with its state, in display order, cleared ones included. */
export function trackerViews(
  state: Pick<TrackerStoreState, "records" | "evidence" | "unconfirmed" | "recoverySupported">,
  queueNotes: Record<string, string> = {},
): TrackerView[] {
  return Object.values(state.records)
    .map((record) =>
      deriveTrackerView(record, state.evidence[record.sessionId] ?? evidenceFromRecord(record), {
        recoverySupported: state.recoverySupported,
        unconfirmed: state.unconfirmed[record.sessionId] !== undefined,
        queueNote: queueNotes[record.sessionId] ?? null,
      }))
    .sort(compareTrackers);
}

/**
 * The trackers the pill row may show: none that is cleared, every live one
 * (states needs you through can't check, which live work bounds), and at
 * most {@link SETTLED_TRACKER_CAP} done or cancelled. The rest are
 * `overflow`: off the row, still unseen on their Sessions row (D52 §4).
 */
export function trackerRow(views: readonly TrackerView[]): { shown: TrackerView[]; overflow: TrackerView[] } {
  const shown: TrackerView[] = [];
  const overflow: TrackerView[] = [];
  let settled = 0;
  for (const view of views) {
    if (view.cleared) continue;
    if (view.state === "done" || view.state === "cancelled") {
      if (settled++ >= SETTLED_TRACKER_CAP) { overflow.push(view); continue; }
    }
    shown.push(view);
  }
  return { shown, overflow };
}

/** Refusals remembered per page: far more than the sends one page makes between reads. */
const REFUSALS_KEPT = 256;

export function createTrackerStore(env: StoreEnvironment) {
  const key = env.storageKey(TRACKER_STORAGE_KEY);

  function read() {
    try {
      return parseTrackerSet(env.storage()?.getItem(key) ?? null);
    } catch {
      return parseTrackerSet(null);
    }
  }

  /**
   * Store the set. Another tab of the same root may have written since this
   * one last read, so its trackers are merged in rather than overwritten:
   * only what this tab removed goes. A deletion of the whole set (a new
   * principal, a revocation) replaces it. Returns the merged records.
   */
  function write(state: Pick<TrackerStoreState, "records" | "principalKey">, removed: readonly string[], replace: boolean): Record<string, TrackerRecord> {
    let records = state.records;
    try {
      const storage = env.storage();
      if (!storage) return records;
      if (!replace) {
        const current = read();
        if (current.principalKey === null || state.principalKey === null || current.principalKey === state.principalKey) {
          const merged = { ...current.records };
          for (const sessionId of removed) delete merged[sessionId];
          records = { ...merged, ...state.records };
        }
      }
      if (Object.keys(records).length === 0) storage.removeItem(key);
      else storage.setItem(key, serializeTrackerSet({ principalKey: state.principalKey, records }));
    } catch {
      // Storage full, disabled or throwing: the trackers still work for this page.
    }
    return records;
  }

  const stored = read();

  return createStore<TrackerStoreState>((set, get) => {
    function commit(patch: Partial<TrackerStoreState>, replace = false) {
      const before = get().records;
      set(patch);
      if (patch.records === undefined && patch.principalKey === undefined) return;
      const removed = patch.records ? Object.keys(before).filter((id) => !(id in patch.records!)) : [];
      const records = write(get(), removed, replace);
      if (records !== get().records) adopt(records);
    }

    /**
     * Take in trackers another tab of this root stored. Returns the sessions
     * whose tracker is new here, or whose stored revision is ahead of what
     * this tab knows: their evidence starts over from the record, so an
     * older turn cannot be shown or seen, and they need a fresh read.
     */
    function adopt(records: Record<string, TrackerRecord>): string[] {
      const state = get();
      const evidence = { ...state.evidence };
      const changed: string[] = [];
      for (const record of Object.values(records)) {
        const known = evidence[record.sessionId];
        const mine = state.records[record.sessionId];
        if (!mine || !known || (record.revision ?? -1) > (known.revision ?? -1)) {
          if (!mine || (record.revision ?? -1) > (known?.revision ?? -1)) evidence[record.sessionId] = evidenceFromRecord(record);
          changed.push(record.sessionId);
        }
      }
      set({ records, evidence });
      return changed;
    }

    /** Keep the record's identifiers in step with the newest evidence, so a reload can detect a rollback. */
    function withIdentity(record: TrackerRecord, evidence: TrackerEvidence): TrackerRecord {
      const revision = evidence.revision ?? record.revision;
      const requestId = evidence.latest?.requestId ?? record.requestId;
      const turnId = evidence.latest ? evidence.latest.turnId : record.turnId;
      if (revision === record.revision && requestId === record.requestId && turnId === record.turnId) return record;
      return { ...record, revision, requestId, turnId };
    }

    function settleEvidence(sessionId: string, evidence: TrackerEvidence, unconfirmedPatch?: Record<string, string>) {
      const state = get();
      const patch: Partial<TrackerStoreState> = { evidence: { ...state.evidence, [sessionId]: evidence } };
      const record = state.records[sessionId];
      if (record) {
        const next = withIdentity(record, evidence);
        if (next !== record) patch.records = { ...state.records, [sessionId]: next };
      }
      if (unconfirmedPatch) patch.unconfirmed = unconfirmedPatch;
      commit(patch);
    }

    function remember(requestIds: ReadonlyArray<string | null | undefined>) {
      const known = get().acceptedRequests;
      const fresh = requestIds.filter((id): id is string => !!id && !known.includes(id));
      if (fresh.length > 0) set({ acceptedRequests: [...known, ...fresh].slice(-REFUSALS_KEPT) });
    }

    function confirmed(state: TrackerStoreState, sessionId: string, requestIds: Array<string | null>): Record<string, string> | undefined {
      const pending = state.unconfirmed[sessionId];
      if (pending === undefined || !requestIds.includes(pending)) return undefined;
      const unconfirmed = { ...state.unconfirmed };
      delete unconfirmed[sessionId];
      return unconfirmed;
    }

    function deleteAll() {
      commit({ records: {}, evidence: {}, unconfirmed: {}, createdFor: {}, reading: {}, epoch: get().epoch + 1 }, true);
    }

    return {
      records: stored.records,
      evidence: Object.fromEntries(Object.values(stored.records).map((r) => [r.sessionId, evidenceFromRecord(r)])),
      unconfirmed: {},
      refusedRequests: [],
      acceptedRequests: [],
      createdFor: {},
      principalKey: stored.principalKey,
      recoverySupported: null,
      reading: {},
      epoch: 0,
      suspended: false,

      track(sessionId, options = {}) {
        const state = get();
        if (state.suspended) return;
        const existing = state.records[sessionId];
        const evidence = state.evidence[sessionId] ?? evidenceFromRecord(existing);
        const record: TrackerRecord = withIdentity({
          sessionId,
          requestId: existing?.requestId ?? null,
          turnId: existing?.turnId ?? null,
          revision: existing?.revision ?? null,
          leftAt: options.now ?? Date.now(),
          seen: null,
        }, evidence);
        const patch: Partial<TrackerStoreState> = {
          records: { ...state.records, [sessionId]: record },
          evidence: { ...state.evidence, [sessionId]: evidence },
        };
        if (options.unconfirmedRequestId) patch.unconfirmed = { ...state.unconfirmed, [sessionId]: options.unconfirmedRequestId };
        const createdFor = { ...state.createdFor };
        if (options.onlyUnconfirmed && options.unconfirmedRequestId && !existing) createdFor[sessionId] = options.unconfirmedRequestId;
        else delete createdFor[sessionId];
        patch.createdFor = createdFor;
        commit(patch);
      },

      leftIdle(sessionId) {
        const state = get();
        const record = state.records[sessionId];
        if (record) {
          if (!isCleared(record, state.evidence[sessionId] ?? evidenceFromRecord(record))) return;
          const records = { ...state.records };
          delete records[sessionId];
          commit({ records });
        }
        // Nothing tracks this session any more: what was known about it
        // need not be kept, and the next frame starts over.
        const evidence = { ...get().evidence };
        delete evidence[sessionId];
        set({ evidence });
      },

      live(sessionId, events) {
        const state = get();
        if (events.length === 0 || state.suspended) return;
        const held = state.reading[sessionId];
        if (held) {
          set({ reading: { ...state.reading, [sessionId]: [...held, ...events] } });
          // Held for ordering, but what they prove about acceptance holds now.
          const accepted = events.flatMap((e) => (e.kind === "queued" || e.kind === "running" ? [e.requestId] : []));
          remember(accepted);
          const unconfirmed = confirmed(get(), sessionId, accepted);
          if (unconfirmed) set({ unconfirmed });
          return;
        }
        let evidence = state.evidence[sessionId] ?? evidenceFromRecord(state.records[sessionId]);
        for (const event of events) evidence = applyLiveEvent(evidence, event);
        const accepted = events.flatMap((e) => (e.kind === "queued" || e.kind === "running" ? [e.requestId] : []));
        remember(accepted);
        settleEvidence(sessionId, evidence, confirmed(state, sessionId, accepted));
      },

      refused(sessionId, requestId) {
        const state = get();
        const unconfirmed = confirmed(state, sessionId, [requestId]);
        const refusedRequests = state.refusedRequests.includes(requestId)
          ? state.refusedRequests
          : [...state.refusedRequests, requestId].slice(-REFUSALS_KEPT);
        set({ refusedRequests, ...(unconfirmed ? { unconfirmed } : {}) });
        // A tracker that existed only for this send tracked nothing.
        if (state.createdFor[sessionId] === requestId) {
          const createdFor = { ...state.createdFor };
          delete createdFor[sessionId];
          const evidence = state.evidence[sessionId];
          const working = !!evidence && (evidence.pending.length > 0 || evidence.latest?.state === "queued" || evidence.latest?.state === "running");
          if (working) set({ createdFor });
          else {
            const records = { ...state.records };
            delete records[sessionId];
            commit({ createdFor, records });
          }
        }
      },

      beginRead(sessionId) {
        const state = get();
        if (state.reading[sessionId]) return false;
        set({ reading: { ...state.reading, [sessionId]: [] } });
        return true;
      },

      endRead(sessionId, result, epoch) {
        const state = get();
        // A read begun before the set was deleted settles nothing: not even
        // the slot, which may already belong to a newer read.
        if (epoch !== state.epoch) return;
        const held = state.reading[sessionId];
        if (!held) return;
        const reading = { ...state.reading };
        delete reading[sessionId];
        set({ reading });
        let evidence = state.evidence[sessionId] ?? evidenceFromRecord(state.records[sessionId]);
        evidence = result.ok ? applySnapshot(evidence, result.recovery) : applyUnavailable(evidence, result.reason);
        for (const event of held) evidence = applyLiveEvent(evidence, event);
        const accepted = [
          ...(result.ok ? [result.recovery.latest.requestId] : []),
          ...held.flatMap((e) => (e.kind === "queued" || e.kind === "running" ? [e.requestId] : [])),
        ];
        remember(accepted);
        settleEvidence(sessionId, evidence, confirmed(get(), sessionId, accepted));
      },

      accepted(requestIds) {
        remember(requestIds);
        const unconfirmed = Object.fromEntries(Object.entries(get().unconfirmed).filter(([, id]) => !requestIds.includes(id)));
        if (Object.keys(unconfirmed).length !== Object.keys(get().unconfirmed).length) set({ unconfirmed });
      },

      observeSeen({ sessionId, turnId, revision }) {
        const state = get();
        const record = state.records[sessionId];
        // A newer send without acceptance proof is not on screen yet: the
        // turn at the bottom is not the latest work.
        if (!record || state.reading[sessionId] || state.unconfirmed[sessionId] !== undefined) return false;
        const key = seenKey(record, state.evidence[sessionId] ?? evidenceFromRecord(record));
        if (!key || key.turnId !== turnId || key.revision !== revision) return false;
        if (record.seen?.turnId === turnId && record.seen.revision === revision && record.seen.basis === "proof") return true;
        commit({ records: { ...state.records, [sessionId]: { ...record, seen: { turnId, revision, basis: "proof" } } } });
        return true;
      },

      acknowledge(sessionId) {
        const state = get();
        const record = state.records[sessionId];
        if (!record) return;
        const key = seenKey(record, state.evidence[sessionId] ?? evidenceFromRecord(record));
        const records = { ...state.records };
        // With no turn to name, there is nothing to store an acknowledgement
        // against: clearing it is all the reader asked for.
        if (!key) delete records[sessionId];
        else records[sessionId] = { ...record, seen: { ...key, basis: "acknowledged" } };
        commit({ records });
      },

      setRecoverySupported(recoverySupported) {
        if (get().recoverySupported !== recoverySupported) set({ recoverySupported });
      },

      setPrincipal(principalKey) {
        const current = get().principalKey;
        if (principalKey === null || principalKey === current) return;
        if (current !== null) deleteAll();
        commit({ principalKey });
      },

      syncFromStorage() {
        const current = read();
        const principalKey = get().principalKey;
        // A set stored under another principal is not this tab's to take;
        // its next hello decides.
        if (current.principalKey !== null && principalKey !== null && current.principalKey !== principalKey) return [];
        return adopt(current.records);
      },

      revoke() {
        deleteAll();
        set({ suspended: true });
      },

      resume() {
        if (get().suspended) set({ suspended: false });
      },
    };
  });
}
