import type {
  ActivitySpan,
  ActivitySpanEvent,
  ServerActivityDelta,
  ServerActivitySnapshot,
} from "@schlessera/brain-ui-sdk/protocol";
import type { ActivityIntent } from "../lib/api-client.js";

export interface ActivityState {
  /** server_hello said this host records activity. */
  supported: boolean;
  /** Session ids this connection has an activity subscription for. */
  subscribed: Record<string, true>;
  /** Bumped on every new connection so subscribe effects re-send. */
  connectionEpoch: number;
  /** Live span state per run, keyed runId -> spanId. */
  spans: Record<string, Record<string, ActivitySpan>>;
  /** Ordered events per span (already sorted by eventIndex). */
  events: Record<string, ActivitySpanEvent[]>;
  /** Per-run high-water seq from the snapshot; deltas at or below drop. */
  highWater: Record<string, number>;
  /**
   * Newest APPLIED delta seq per run. Kept apart from `highWater` on
   * purpose: the snapshot staleness guard compares against the max of both
   * (a snapshot older than an applied delta must not roll it back), while
   * the delta gate keeps comparing against the snapshot floor alone so
   * out-of-order delta delivery stays tolerated (insert-if-absent absorbs it).
   */
  deltaSeq: Record<string, number>;
  /** spanId -> runId reverse index, for timing lookups by toolUseId. */
  spanRun: Record<string, string>;

  /** Unacknowledged notification intents — the guaranteed-tier inbox. */
  inbox: ActivityIntent[];
  loadInbox: () => Promise<void>;
  acknowledgeIntent: (id: number) => Promise<void>;
  acknowledgeAllIntents: () => Promise<void>;
  setSupported: (supported: boolean) => void;
  /** New connection: server-side subscriptions are gone; re-subscribe lazily. */
  resetSubscriptions: () => void;
  bumpConnectionEpoch: () => void;
  markSubscribed: (sessionId: string) => void;
  applySnapshot: (msg: ServerActivitySnapshot) => void;
  applyDelta: (msg: ServerActivityDelta) => void;
  clear: () => void;
}

/** The five indexes that make up the mirror, mutated together during merges. */
export interface MirrorMaps {
  spans: Record<string, Record<string, ActivitySpan>>;
  events: Record<string, ActivitySpanEvent[]>;
  highWater: Record<string, number>;
  deltaSeq: Record<string, number>;
  spanRun: Record<string, string>;
}
