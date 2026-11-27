/**
 * An inbox in which every branch of the lifecycle sweep has work (#4804):
 * an expired Action, a snoozed Action past its wait, expired ready work,
 * blocked work whose own retention ran out, a due scheduled item, failed work
 * out of attempts, terminal work awaiting cleanup, terminal work whose
 * cleanup already exists and expired work under an open interactive share.
 */
import type { Database } from "bun:sqlite";
import type { InboxActionItem, InboxActionStatus, InboxQueueStatus } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxAction, enqueueInboxCleanup } from "../../src/inbox/actions.js";
import { createInboxStore } from "../../src/inbox/store.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** When the fixture is seeded, and when the sweep runs. */
export const SEEDED_AT = Date.UTC(2026, 6, 12, 8), SWEEP_AT = SEEDED_AT + 2 * HOUR;

export function inboxFixture(db: Database) {
  const store = createInboxStore(db, { now: () => SEEDED_AT });
  const version = (id: string) => store.getItem(id)!.version;
  const move = (id: string, to: InboxQueueStatus | InboxActionStatus, extra: { leaseUntil?: number; runId?: string; waitUntil?: number; blockedByItemId?: string } = {}) =>
    store.commit([{ kind: "transition", itemId: id, expectedVersion: version(id), to, ...extra }]);
  const lease = { leaseUntil: SEEDED_AT + HOUR, runId: "run-fixture" };
  /** A thread with one triage item; `expiresAt` defaults to thirty days out. */
  const thread = (id: string, expiresAt = SEEDED_AT + 30 * DAY, stakes = 1) => {
    store.ingest({ threadId: id, itemId: `work-${id}`, dedupKey: `work-${id}`, source: "share", stagingId: `staging-${id}`, stakes, expiresAt });
    return `work-${id}`;
  };
  const finish = (work: string) => { move(work, "claimed", lease); move(work, "done"); };
  const action = (threadId: string, id: string, expiresAt = SEEDED_AT + 30 * DAY, createdAt = SEEDED_AT): InboxActionItem => {
    const item: InboxActionItem = { id, dedupKey: id, threadId, queue: "actions", type: "choose", status: "pending", version: 1, createdAt, updatedAt: createdAt, expiresAt,
      payload: { title: `Decide for ${threadId}`, detail: "Odysseus weighs the course." }, options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] };
    createInboxAction(db, item, [], { now: SEEDED_AT });
    return item;
  };
  return { store, move, lease, thread, finish, action, version };
}

/** Seeds every branch; returns nothing the golden needs beyond the exported state. */
export function seedEverySweepBranch(db: Database) {
  const f = inboxFixture(db);
  // An expired Action beside finished work: retired, reported, and the thread's staging cleaned up.
  f.finish(f.thread("aeolus"));
  f.action("aeolus", "action-aeolus", SEEDED_AT + HOUR);
  // A snoozed Action whose wait has passed returns to pending.
  f.finish(f.thread("circe"));
  f.action("circe", "action-circe");
  f.move("action-circe", "snoozed", { waitUntil: SEEDED_AT + HOUR });
  // Ready work past its retention expires.
  f.thread("scylla", SEEDED_AT + HOUR);
  // Blocked work whose retention ran out retires its blocking Action.
  const blocked = f.thread("charybdis", SEEDED_AT + HOUR);
  f.move(blocked, "claimed", f.lease);
  f.action("charybdis", "action-charybdis");
  f.move(blocked, "blocked", { blockedByItemId: "action-charybdis" });
  // A scheduled item whose wait has passed becomes ready.
  f.thread("helios");
  f.store.commit([{ kind: "item", item: { id: "schedule-helios", dedupKey: "schedule-helios", threadId: "helios", queue: "queue", type: "execute", status: "scheduled",
    attempts: 0, maxAttempts: 3, version: 1, createdAt: SEEDED_AT, updatedAt: SEEDED_AT, expiresAt: SEEDED_AT + 30 * DAY, waitUntil: SEEDED_AT + HOUR,
    payload: { instruction: "Herd the cattle of the sun" } } }]);
  // Failed work out of attempts is dead-lettered.
  const failed = f.thread("polyphemus");
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.move(failed, "claimed", f.lease);
    f.move(failed, "failed");
    if (attempt < 3) f.move(failed, "ready");
  }
  // Finished work with nothing left in its thread gets its staging cleanup.
  f.finish(f.thread("ithaca"));
  // Finished work whose cleanup is already queued needs nothing.
  f.finish(f.thread("laertes"));
  enqueueInboxCleanup(db, "laertes", SEEDED_AT);
  // Expired work under an open interactive share is left alone.
  f.thread("calypso", SEEDED_AT + HOUR);
  db.query("INSERT INTO inbox_interactive_shares (item_id, staging_id, principal_id, session_id, run_id) VALUES ('work-calypso', 'staging-calypso', 'odysseus', NULL, 'run-calypso')").run();
}
