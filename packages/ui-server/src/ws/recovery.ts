import type {
  SessionRecovery,
  SessionRecoveryLatest,
  SessionRecoveryPending,
} from "@schlessera/brain-ui-sdk/protocol";
import type { Principal } from "../db/principals.js";
import type { WsHost } from "./host.js";
import type { AcceptedWork } from "./session-work.js";

/**
 * Session recovery (#964, D52 §6): the host's own account of a session's
 * latest accepted request and of the interactions waiting in it.
 *
 * Every fact here comes from a host record. Acceptance order is the
 * persisted revision; queued and running come from the coordinator, which
 * is process-local and so never survives a restart; a terminal outcome comes
 * only from the Activity rollup of the request's turn. Where none of those
 * proves the state, the answer is `unknown`. A read never selects a session,
 * starts work, replies to anything or grants anything.
 */

/** Whether this host can answer recovery reads: it records acceptance and reads it back. */
export function supportsSessionRecovery(host: Pick<WsHost, "catalog">): boolean {
  return typeof host.catalog.acceptWork === "function" && typeof host.catalog.latestWork === "function";
}

/**
 * Record that the host accepted a request for a known session, and return
 * its revision. A failed write leaves the session unordered: its recovery
 * reads `unknown` until a later acceptance is recorded, because the
 * persisted latest request is now older than the work actually accepted.
 */
export function acceptRequest(
  host: Pick<WsHost, "catalog" | "coordinator">,
  sessionId: string,
  requestId: string | undefined,
  backendId: string | null
): number | undefined {
  if (!host.catalog.acceptWork) return undefined;
  const revision = host.catalog.acceptWork(sessionId, requestId ?? null, backendId);
  if (revision === null) {
    host.coordinator.unorderedSessions.add(sessionId);
    return undefined;
  }
  host.coordinator.unorderedSessions.delete(sessionId);
  return revision;
}

/** The outcome of one recovery read, before it becomes an HTTP response. */
export type RecoveryRead =
  | { kind: "ok"; recovery: SessionRecovery }
  | { kind: "unauthorized" }
  | { kind: "not_found" };

/** A request the coordinator holds for the session right now. */
interface LiveRequest {
  revision: number | undefined;
  state: "queued" | "running";
  turnId?: string;
  startedAt?: number;
}

function liveRequests(host: WsHost, sessionId: string): LiveRequest[] {
  const live: LiveRequest[] = [];
  const starting = host.coordinator.startingBySession.get(sessionId);
  if (starting && !starting.cancelled) {
    live.push({ revision: starting.revision, state: "queued" });
    for (const entry of starting.queue) live.push({ revision: entry.revision, state: "queued" });
  }
  const turn = host.coordinator.bySession.get(sessionId);
  if (turn) {
    // A slot between turns holds no request; one that has taken a request
    // but not yet handed it to the backend holds a queued one.
    if (turn.revision !== undefined || turn.startedAt !== undefined) {
      live.push(turn.startedAt !== undefined
        ? { revision: turn.revision, state: "running", turnId: turn.turnId, startedAt: turn.startedAt }
        : { revision: turn.revision, state: "queued" });
    }
    for (const entry of turn.queue) live.push({ revision: entry.revision, state: "queued" });
  }
  return live;
}

const UNKNOWN: SessionRecoveryLatest = {
  requestId: null,
  turnId: null,
  state: "unknown",
  outcome: null,
  startedAt: null,
  endedAt: null,
};

function latestOf(host: WsHost, sessionId: string, row: AcceptedWork | null, live: LiveRequest[]): SessionRecoveryLatest {
  // Ordering evidence is missing: the newest acceptance was not recorded, or
  // the newest live request carries no revision. Nothing older may stand in
  // for it. (Live requests are listed oldest first, in the order the slot
  // runs them, so an older one without a revision is older than the latest.)
  if (host.coordinator.unorderedSessions.has(sessionId) || (live.length > 0 && live.at(-1)!.revision === undefined)) {
    return UNKNOWN;
  }
  if (row === null) return UNKNOWN;
  // A live request newer than the persisted latest contradicts it.
  if (live.some((request) => request.revision! > row.revision)) return UNKNOWN;
  const match = live.find((request) => request.revision === row.revision);
  if (match) {
    if (match.state === "queued") {
      // Not dispatched yet, so it cannot have a turn on record.
      if (row.turnId !== null) return UNKNOWN;
      return { ...UNKNOWN, requestId: row.requestId, state: "queued" };
    }
    if (row.turnId !== null && row.turnId !== match.turnId) return UNKNOWN;
    return { ...UNKNOWN, requestId: row.requestId, turnId: match.turnId!, state: "running", startedAt: match.startedAt! };
  }
  // Not held by this process. Without a dispatched turn there is nothing to
  // prove: a queue lost to a restart, or a request dropped before it ran.
  if (row.turnId === null) return { ...UNKNOWN, requestId: row.requestId };
  const known = { ...UNKNOWN, requestId: row.requestId, turnId: row.turnId, startedAt: row.startedAt };
  const rollup = host.activity?.store.runRollup?.(row.turnId) ?? null;
  // The Activity run of this turn must have ended, and must not belong to
  // another session.
  if (!rollup || rollup.outcome === null || rollup.endedAt === null) return known;
  if (rollup.sessionId !== null && rollup.sessionId !== sessionId) return UNKNOWN;
  return {
    requestId: row.requestId,
    turnId: row.turnId,
    state: "terminal",
    outcome: rollup.outcome,
    startedAt: rollup.startedAt,
    endedAt: rollup.endedAt,
  };
}

function pendingOf(host: WsHost, sessionId: string): SessionRecoveryPending[] {
  const { coordinator } = host;
  const pending: SessionRecoveryPending[] = [];
  for (const [toolUseId, p] of coordinator.pendingApprovals) {
    if (p.turn.sessionId === sessionId) pending.push({ kind: "approval", requestId: toolUseId, turnId: p.turnId });
  }
  const asks = [
    ["ask_user", coordinator.pendingAskUser],
    ["ask_user_list", coordinator.pendingAskUserList],
    ["ask_user_rank", coordinator.pendingAskUserRank],
    ["ask_user_form", coordinator.pendingAskUserForm],
  ] as const;
  for (const [kind, map] of asks) {
    for (const p of map.values()) {
      if (p.turn.sessionId === sessionId) pending.push({ kind, requestId: p.requestId, turnId: p.turnId });
    }
  }
  return pending;
}

/**
 * Read one session's recovery envelope for `principal`. A storage failure
 * throws, so the route answers 5xx rather than a successful `unknown`.
 */
export async function readSessionRecovery(host: WsHost, sessionId: string, principal: Principal): Promise<RecoveryRead> {
  if (!host.isPrincipalValid(principal)) return { kind: "unauthorized" };
  const { catalog, coordinator } = host;
  const known = () =>
    coordinator.bySession.has(sessionId) ||
    coordinator.startingBySession.has(sessionId) ||
    catalog.latestWork!(sessionId) !== null ||
    catalog.hasSession?.(sessionId) === true;
  if (!known()) {
    // A session the catalog never saw may still be one its backend holds
    // (imported history). It exists if the backend replays anything for it.
    const backends = await host.registry.getBackends();
    const reads = await Promise.allSettled(backends.map((backend) => backend.getHistory(sessionId)));
    // Authorization is re-read after every asynchronous step.
    if (!host.isPrincipalValid(principal)) return { kind: "unauthorized" };
    const found = reads.some((read) => read.status === "fulfilled" && read.value.length > 0);
    if (!found && !known()) {
      // A backend that failed to answer might hold it: that is a failed
      // read, not an absent session.
      const failed = reads.find((read): read is PromiseRejectedResult => read.status === "rejected");
      if (failed) throw failed.reason;
      return { kind: "not_found" };
    }
  }
  // One synchronous snapshot: nothing below awaits, so the persisted latest,
  // the coordinator's live requests and its pending interactions describe
  // the same instant.
  const row = catalog.latestWork!(sessionId);
  const live = liveRequests(host, sessionId);
  const running = coordinator.bySession.get(sessionId);
  return {
    kind: "ok",
    recovery: {
      sessionId,
      backendId: row?.backendId ?? catalog.getStoredBackendId(sessionId) ?? running?.backend.id ?? null,
      revision: row?.revision ?? 0,
      latest: latestOf(host, sessionId, row, live),
      pending: pendingOf(host, sessionId),
    },
  };
}
