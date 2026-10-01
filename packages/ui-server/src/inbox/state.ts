import type {
  InboxActionStatus,
  InboxItem,
  InboxQueueStatus,
} from "@schlessera/brain-ui-sdk/protocol";

const queueTransitions: Record<InboxQueueStatus, readonly InboxQueueStatus[]> =
  {
    scheduled: ["ready", "expired", "dropped"],
    ready: ["claimed", "expired", "dropped"],
    claimed: [
      "ready",
      "done",
      "blocked",
      "failed",
      "superseded",
      "expired",
      "dropped",
    ],
    blocked: ["superseded"],
    failed: ["ready", "expired", "dropped"],
    done: [],
    superseded: [],
    expired: [],
    dropped: [],
  };
const actionTransitions: Record<
  InboxActionStatus,
  readonly InboxActionStatus[]
> = {
  pending: ["snoozed", "resolved", "dismissed", "expired", "dropped"],
  snoozed: ["pending", "resolved", "dismissed", "expired", "dropped"],
  resolved: [],
  dismissed: [],
  expired: [],
  dropped: [],
};

export function assertInboxTransition(
  item: InboxItem,
  to: InboxQueueStatus | InboxActionStatus
): void {
  const allowed: readonly string[] =
    item.queue === "queue"
      ? queueTransitions[item.status]
      : actionTransitions[item.status];
  if (!allowed.includes(to))
    throw new Error(
      `Forbidden ${item.queue} transition: ${item.status} -> ${to}`
    );
}

export function clampInboxStakes(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Stakes must be finite");
  return Math.max(1, Math.min(3, Math.floor(value)));
}

/** Computed on every read: persisted components never freeze the age term. */
export function inboxPriority(
  stakes: number,
  deadline: number | undefined,
  createdAt: number,
  attempts: number,
  now: number
): number {
  const day = 86_400_000;
  const remaining = deadline === undefined ? Infinity : deadline - now;
  const urgency =
    remaining < day ? 3 : remaining < 3 * day ? 2 : remaining < 7 * day ? 1 : 0;
  const age = Math.min(Math.max(Math.floor((now - createdAt) / day), 0), 5);
  return 4 * stakes + 3 * urgency + age - Math.min(attempts, 3);
}
