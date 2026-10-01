import { Database } from "bun:sqlite";
import type {
  BillingMode,
  InboxActionStatus,
  InboxChange,
  InboxDismissReason,
  InboxItem,
  InboxOperation,
  InboxQueueStatus,
  InboxSnapshot,
  InboxThread,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  inboxChangeSchema,
  inboxDismissReasonSchema,
  inboxItemSchema,
  inboxOperationSchema,
  inboxOptionSchema,
  inboxThreadSchema,
  inboxWorkPayloadSchema,
  v1ResolutionEffectSchema,
} from "@schlessera/brain-ui-sdk/schemas";
import {
  assertInboxTransition,
  clampInboxStakes,
  inboxPriority,
} from "./state.js";

export type InboxStoreSnapshot = Pick<
  InboxSnapshot,
  "threads" | "items" | "highWaterSeq" | "cursor"
>;
/** Retained prompt facts are audit data, never an authority source. */
export interface InboxCheckpointFacts {
  decisions: string[];
  operations: InboxOperation[];
  /** Server-recorded grant identifiers for audit only; never grants on replay. */
  capabilities: string[];
  paths: string[];
  questions: string[];
}
export interface InboxCheckpoint {
  id: string;
  threadId: string;
  itemId?: string;
  runId?: string;
  seq: number;
  createdAt: number;
  kind: "run" | "compaction";
  stateMd: string;
  facts: InboxCheckpointFacts;
}
export interface InboxReservation {
  id: string;
  operationKey: string;
  itemId: string;
  attempt: number;
  purpose: "triage" | "execute" | "retry" | "redo" | "compaction";
  runId?: string;
  principalId: string;
  model: string;
  billingMode: BillingMode;
  localDay: string;
  reserveKind: "normal" | "emergency";
  reservedCostUsd: number;
  reservedTurns: number;
}
export type InboxMutation =
  | { kind: "item"; item: InboxItem }
  | {
      kind: "transition";
      itemId: string;
      expectedVersion: number;
      to: InboxQueueStatus | InboxActionStatus;
      waitUntil?: number | null;
      leaseUntil?: number;
      runId?: string;
      blockedByItemId?: string;
    }
  | {
      kind: "checkpoint";
      id: string;
      threadId: string;
      itemId?: string;
      runId?: string;
      stateMd: string;
      facts: InboxCheckpointFacts;
    }
  | {
      kind: "compact";
      id: string;
      threadId: string;
      expectedSeq: number;
      stateMd: string;
    }
  | {
      kind: "resolution";
      id: string;
      itemId: string;
      optionId: string;
      principalId: string;
      reason?: InboxDismissReason;
    }
  | { kind: "remove_item"; itemId: string; expectedVersion: number }
  | { kind: "remove_thread"; threadId: string }
  | {
      kind: "suppress";
      classKey: string;
      evidenceBoundary: string;
      expiresAt: number;
      reraiseCondition: string;
    }
  | { kind: "heartbeat"; name: string; tickAt: number; changeCursor: number }
  | { kind: "reserve"; reservation: InboxReservation }
  | {
      kind: "settle";
      reservationId: string;
      status: "settled" | "released";
      observedCostUsd: number | null;
      chargedCostUsd: number;
      chargedTurns: number;
    };

interface ThreadRow {
  id: string;
  trust_class: "trusted" | "untrusted";
  source: "share" | "cli";
  status: "open" | "closed";
  stakes: number;
  deadline: number | null;
  created_at: number;
  last_seen_at: number;
  state_md: string;
  projection_seq: number;
  compaction_pending: number;
  deleted_at: number | null;
}
interface ItemRow {
  id: string;
  thread_id: string;
  dedup_key: string;
  data_json: string;
  deleted_at: number | null;
}
interface CheckpointRow {
  id: string;
  thread_id: string;
  item_id: string | null;
  run_id: string | null;
  seq: number;
  created_at: number;
  kind: "run" | "compaction";
  state_md: string;
  facts_json: string;
}
const EMPTY_FACTS: InboxCheckpointFacts = {
  decisions: [],
  operations: [],
  capabilities: [],
  paths: [],
  questions: [],
};
const TABLES = [
  "inbox_threads",
  "inbox_items",
  "inbox_thread_sequences",
  "inbox_changes",
  "inbox_checkpoints",
  "inbox_resolutions",
  "inbox_suppressions",
  "inbox_scheduler_heartbeats",
  "inbox_budget_reservations",
] as const;
const TERMINAL = new Set([
  "done",
  "resolved",
  "dismissed",
  "superseded",
  "expired",
  "dropped",
]);

function wireThread(row: ThreadRow): InboxThread {
  return inboxThreadSchema.parse({
    id: row.id,
    trustClass: row.trust_class,
    source: row.source,
    status: row.status,
    stakes: row.stakes,
    deadline: row.deadline ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    stateMd: row.state_md,
  });
}
function wireItem(row: ItemRow): InboxItem {
  return inboxItemSchema.parse(JSON.parse(row.data_json));
}
function checkpoint(row: CheckpointRow): InboxCheckpoint {
  return {
    id: row.id,
    threadId: row.thread_id,
    itemId: row.item_id ?? undefined,
    runId: row.run_id ?? undefined,
    seq: row.seq,
    createdAt: row.created_at,
    kind: row.kind,
    stateMd: row.state_md,
    facts: JSON.parse(row.facts_json),
  };
}
function clipProjection(text: string): string {
  // Iterate code points: never store a replacement character from a sliced UTF-8 sequence.
  let bytes = 0,
    end = 0;
  for (const char of text) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 4096) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}
function assertId(value: string): void {
  if (!value || value.length > 256) throw new Error("Invalid inbox id");
}
function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid inbox time/count");
}
function assertMoney(value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Invalid inbox cost");
}
function validateFacts(facts: InboxCheckpointFacts): void {
  for (const values of [
    facts.decisions,
    facts.capabilities,
    facts.paths,
    facts.questions,
  ]) {
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    )
      throw new Error("Invalid checkpoint facts");
  }
  if (!Array.isArray(facts.operations))
    throw new Error("Invalid checkpoint operations");
  for (const operation of facts.operations)
    inboxOperationSchema.parse(operation);
}
function validateItem(value: InboxItem): InboxItem {
  const item = inboxItemSchema.parse(value);
  const allowed = new Set([
    "id",
    "threadId",
    "dedupKey",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "waitUntil",
    "version",
    "runId",
    "queue",
    "type",
    "status",
    "payload",
    ...(item.queue === "queue"
      ? [
          "attempts",
          "maxAttempts",
          "claimedAt",
          "leaseUntil",
          "blockedByItemId",
        ]
      : ["options"]),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unexpected inbox item field");
  if (item.queue === "queue" && item.type === "execute")
    inboxWorkPayloadSchema.parse(item.payload);
  if (
    item.queue === "queue" &&
    item.type !== "execute" &&
    Object.keys(item.payload).some((key) => key !== "stagingId")
  )
    throw new Error("Unexpected staging payload field");
  if (item.queue === "actions") {
    if (
      Object.keys(item.payload).some(
        (key) => key !== "title" && key !== "detail"
      )
    )
      throw new Error("Unexpected Action payload field");
    const ids = new Set<string>();
    for (const option of item.options) {
      inboxOptionSchema.parse(option);
      v1ResolutionEffectSchema.parse(option.effect);
      if (ids.has(option.id)) throw new Error("Duplicate inbox option id");
      ids.add(option.id);
    }
  }
  if (item.queue === "queue") {
    if (
      item.status === "claimed" &&
      (item.claimedAt === undefined || item.leaseUntil === undefined)
    )
      throw new Error("Claim requires a lease");
    if (
      item.status !== "claimed" &&
      (item.claimedAt !== undefined || item.leaseUntil !== undefined)
    )
      throw new Error("Only claimed work can hold a lease");
    if (item.status !== "blocked" && item.blockedByItemId !== undefined)
      throw new Error("Only blocked work can reference an Action");
  }
  return item;
}

/** Concrete operational store. It receives server-validated commands, never model authority. */
export class InboxStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  private write<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  private threadRow(id: string): ThreadRow {
    const row = this.db
      .query("SELECT * FROM inbox_threads WHERE id = ?")
      .get(id) as ThreadRow | null;
    if (!row) throw new Error("Inbox thread not found");
    return row;
  }
  private itemRow(id: string): ItemRow {
    const row = this.db
      .query("SELECT * FROM inbox_items WHERE id = ?")
      .get(id) as ItemRow | null;
    if (!row) throw new Error("Inbox item not found");
    return row;
  }
  private change(
    threadId: string,
    data:
      | { kind: "upsert_thread"; thread: InboxThread }
      | { kind: "upsert_item"; itemId: string; item: InboxItem }
      | { kind: "remove_item"; itemId: string }
      | { kind: "remove_thread" }
  ): number {
    this.db
      .query(
        "INSERT INTO inbox_thread_sequences (thread_id, seq) VALUES (?, 1) ON CONFLICT(thread_id) DO UPDATE SET seq = seq + 1"
      )
      .run(threadId);
    const { seq } = this.db
      .query("SELECT seq FROM inbox_thread_sequences WHERE thread_id = ?")
      .get(threadId) as { seq: number };
    this.db
      .query(
        "INSERT INTO inbox_changes (thread_id, item_id, seq, kind, data_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        threadId,
        "itemId" in data ? data.itemId : null,
        seq,
        data.kind,
        JSON.stringify(data)
      );
    return seq;
  }
  private threadChange(row: ThreadRow): number {
    return this.change(
      row.id,
      row.deleted_at === null
        ? { kind: "upsert_thread", thread: wireThread(row) }
        : { kind: "remove_thread" }
    );
  }
  private itemColumns(item: InboxItem): (string | number | null)[] {
    return [
      item.expiresAt,
      item.waitUntil ?? null,
      item.runId ?? null,
      item.queue === "queue" ? item.claimedAt ?? null : null,
      item.queue === "queue" ? item.leaseUntil ?? null : null,
      item.queue === "queue" ? item.attempts : null,
      item.queue === "queue" ? item.maxAttempts : null,
      item.queue === "queue" ? item.blockedByItemId ?? null : null,
    ];
  }
  private insertItem(input: InboxItem): void {
    const item = validateItem(input),
      thread = this.threadRow(item.threadId);
    if (thread.deleted_at !== null || thread.status !== "open")
      throw new Error("Thread is not open");
    if (item.version !== 1) throw new Error("New item version must be 1");
    if (
      item.queue === "queue"
        ? !["ready", "scheduled"].includes(item.status)
        : item.status !== "pending"
    )
      throw new Error("Invalid initial inbox state");
    if (item.queue === "queue" && item.attempts !== 0)
      throw new Error("New work must start with zero attempts");
    this.db
      .query(
        "INSERT INTO inbox_items (id, thread_id, dedup_key, queue, type, status, version, data_json, expires_at, wait_until, run_id, claimed_at, lease_until, attempts, max_attempts, blocked_by_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        item.id,
        item.threadId,
        item.dedupKey,
        item.queue,
        item.type,
        item.status,
        item.version,
        JSON.stringify(item),
        ...this.itemColumns(item)
      );
    this.change(item.threadId, { kind: "upsert_item", itemId: item.id, item });
  }

  /** Source is supplied by authenticated intake code; trust is derived, never supplied. */
  ingest(input: {
    threadId: string;
    itemId: string;
    source: "share" | "cli";
    dedupKey: string;
    stagingId: string;
    expiresAt: number;
    stakes: number;
    deadline?: number;
  }): { created: boolean; thread: InboxThread; item: InboxItem } {
    for (const id of [
      input.threadId,
      input.itemId,
      input.dedupKey,
      input.stagingId,
    ])
      assertId(id);
    assertTime(input.expiresAt);
    if (input.deadline !== undefined) assertTime(input.deadline);
    if (input.source !== "share" && input.source !== "cli")
      throw new Error("Unsupported inbox source");
    return this.write(() => {
      const existing = this.db
        .query("SELECT * FROM inbox_items WHERE dedup_key = ?")
        .get(input.dedupKey) as ItemRow | null;
      const now = this.now();
      assertTime(now);
      if (existing) {
        this.db
          .query(
            "UPDATE inbox_threads SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?"
          )
          .run(now, existing.thread_id);
        const row = this.threadRow(existing.thread_id);
        this.threadChange(row);
        return {
          created: false,
          thread: wireThread(row),
          item: wireItem(existing),
        };
      }
      this.db
        .query(
          "INSERT INTO inbox_threads (id, trust_class, source, status, stakes, deadline, created_at, last_seen_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)"
        )
        .run(
          input.threadId,
          input.source === "cli" ? "trusted" : "untrusted",
          input.source,
          clampInboxStakes(input.stakes),
          input.deadline ?? null,
          now,
          now
        );
      const row = this.threadRow(input.threadId);
      this.threadChange(row);
      const item: InboxItem = {
        id: input.itemId,
        threadId: input.threadId,
        dedupKey: input.dedupKey,
        createdAt: now,
        updatedAt: now,
        expiresAt: input.expiresAt,
        version: 1,
        queue: "queue",
        type: "triage",
        status: "ready",
        attempts: 0,
        maxAttempts: 3,
        payload: { stagingId: input.stagingId },
      };
      this.insertItem(item);
      return { created: true, thread: wireThread(row), item };
    });
  }

  getThread(id: string): InboxThread | null {
    const row = this.db
      .query("SELECT * FROM inbox_threads WHERE id = ? AND deleted_at IS NULL")
      .get(id) as ThreadRow | null;
    return row ? wireThread(row) : null;
  }
  getItem(id: string): InboxItem | null {
    const row = this.db
      .query("SELECT * FROM inbox_items WHERE id = ? AND deleted_at IS NULL")
      .get(id) as ItemRow | null;
    return row ? wireItem(row) : null;
  }
  checkpoints(threadId: string): InboxCheckpoint[] {
    return (
      this.db
        .query(
          "SELECT * FROM inbox_checkpoints WHERE thread_id = ? ORDER BY seq"
        )
        .all(threadId) as CheckpointRow[]
    ).map(checkpoint);
  }
  projectionForRun(threadId: string): {
    thread: InboxThread;
    seq: number;
    needsCompaction: boolean;
    facts: InboxCheckpointFacts;
    checkpoints: InboxCheckpoint[];
  } {
    // Read-only preparation. The next already-admitted model-bearing use owns
    // compaction; this store never starts a standalone inference run.
    return this.db.transaction(() => {
      const row = this.threadRow(threadId);
      if (row.deleted_at !== null) throw new Error("Thread is removed");
      const history = this.checkpoints(threadId);
      const facts: InboxCheckpointFacts = {
        decisions: [],
        operations: [],
        capabilities: [],
        paths: [],
        questions: [],
      };
      for (const entry of history) {
        for (const key of [
          "decisions",
          "capabilities",
          "paths",
          "questions",
        ] as const)
          for (const value of entry.facts[key])
            if (!facts[key].includes(value)) facts[key].push(value);
        for (const value of entry.facts.operations)
          if (
            !facts.operations.some(
              (old) => JSON.stringify(old) === JSON.stringify(value)
            )
          )
            facts.operations.push(value);
      }
      return {
        thread: wireThread(row),
        seq: row.projection_seq,
        needsCompaction: row.compaction_pending === 1,
        facts,
        checkpoints: history,
      };
    })();
  }

  /** All composed item/claim/checkpoint/resolution/reservation writes share one immediate transaction. */
  commit(mutations: readonly InboxMutation[]): void {
    this.write(() => {
      for (const mutation of mutations) this.apply(mutation);
    });
  }
  private apply(mutation: InboxMutation): void {
    const now = this.now();
    assertTime(now);
    switch (mutation.kind) {
      case "item":
        this.insertItem(mutation.item);
        return;
      case "transition": {
        const row = this.itemRow(mutation.itemId),
          item = wireItem(row);
        if (
          row.deleted_at !== null ||
          item.version !== mutation.expectedVersion
        )
          throw new Error("Inbox version conflict");
        assertInboxTransition(item, mutation.to);
        const next = {
          ...item,
          status: mutation.to,
          version: item.version + 1,
          updatedAt: now,
        } as InboxItem;
        if (mutation.runId !== undefined) {
          assertId(mutation.runId);
          next.runId = mutation.runId;
        }
        if (mutation.waitUntil !== undefined) {
          if (mutation.waitUntil === null) delete next.waitUntil;
          else {
            assertTime(mutation.waitUntil);
            next.waitUntil = mutation.waitUntil;
          }
        }
        if (next.queue === "queue") {
          if (mutation.blockedByItemId !== undefined) {
            const blocker = wireItem(this.itemRow(mutation.blockedByItemId));
            if (
              this.itemRow(mutation.blockedByItemId).deleted_at !== null ||
              blocker.queue !== "actions" ||
              blocker.type === "fyi" ||
              blocker.threadId !== item.threadId ||
              !["pending", "snoozed"].includes(blocker.status)
            )
              throw new Error("Invalid blocking Action");
            next.blockedByItemId = blocker.id;
          }
          if (next.status === "claimed") {
            if (next.attempts >= next.maxAttempts)
              throw new Error("Inbox attempt limit reached");
            if (mutation.leaseUntil === undefined || mutation.leaseUntil <= now)
              throw new Error("Claim requires a future lease");
            assertTime(mutation.leaseUntil);
            next.claimedAt = now;
            next.leaseUntil = mutation.leaseUntil;
            next.attempts++;
          } else {
            delete next.claimedAt;
            delete next.leaseUntil;
          }
          if (next.status !== "blocked") delete next.blockedByItemId;
          if (next.status === "claimed") delete next.waitUntil;
          if (next.status === "blocked" && !next.blockedByItemId)
            throw new Error("Blocked work requires an Action");
        } else if (
          mutation.leaseUntil !== undefined ||
          mutation.blockedByItemId !== undefined
        )
          throw new Error("Actions cannot hold leases/blocks");
        validateItem(next);
        this.db
          .query(
            "UPDATE inbox_items SET status = ?, version = ?, data_json = ?, expires_at = ?, wait_until = ?, run_id = ?, claimed_at = ?, lease_until = ?, attempts = ?, max_attempts = ?, blocked_by_item_id = ? WHERE id = ?"
          )
          .run(
            next.status,
            next.version,
            JSON.stringify(next),
            ...this.itemColumns(next),
            next.id
          );
        this.change(next.threadId, {
          kind: "upsert_item",
          itemId: next.id,
          item: next,
        });
        return;
      }
      case "checkpoint":
      case "compact": {
        assertId(mutation.id);
        const row = this.threadRow(mutation.threadId);
        if (row.deleted_at !== null) throw new Error("Thread is removed");
        const compact = mutation.kind === "compact";
        if (compact && row.projection_seq !== mutation.expectedSeq)
          throw new Error("Projection version conflict");
        if (typeof mutation.stateMd !== "string")
          throw new Error("Invalid state projection");
        const projection = compact
          ? mutation.stateMd
          : [row.state_md, mutation.stateMd].filter(Boolean).join("\n\n");
        const clipped = clipProjection(projection),
          overflow = clipped !== projection;
        if (compact && overflow)
          throw new Error("Compacted projection exceeds 4096 bytes");
        const facts = compact ? EMPTY_FACTS : mutation.facts;
        validateFacts(facts);
        if (!compact && mutation.itemId) {
          if (this.itemRow(mutation.itemId).thread_id !== row.id)
            throw new Error("Checkpoint item belongs to another thread");
        }
        this.db
          .query(
            "UPDATE inbox_threads SET state_md = ?, compaction_pending = ? WHERE id = ?"
          )
          .run(
            clipped,
            compact ? 0 : Number(overflow || row.compaction_pending === 1),
            row.id
          );
        const seq = this.threadChange(this.threadRow(row.id));
        this.db
          .query("UPDATE inbox_threads SET projection_seq = ? WHERE id = ?")
          .run(seq, row.id);
        this.db
          .query(
            "INSERT INTO inbox_checkpoints (id, thread_id, item_id, run_id, seq, created_at, kind, state_md, facts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            mutation.id,
            row.id,
            compact ? null : mutation.itemId ?? null,
            compact ? null : mutation.runId ?? null,
            seq,
            now,
            compact ? "compaction" : "run",
            mutation.stateMd,
            JSON.stringify(facts)
          );
        return;
      }
      case "resolution": {
        for (const id of [mutation.id, mutation.principalId, mutation.optionId])
          assertId(id);
        const row = this.itemRow(mutation.itemId),
          item = wireItem(row);
        if (
          row.deleted_at !== null ||
          item.queue !== "actions" ||
          item.type === "fyi" ||
          !["pending", "snoozed"].includes(item.status)
        )
          throw new Error("Action is not resolvable");
        const option = item.options.find(
          (entry) => entry.id === mutation.optionId
        );
        if (!option) throw new Error("Unknown inbox option");
        const effect = v1ResolutionEffectSchema.parse(option.effect);
        if (mutation.reason !== undefined)
          inboxDismissReasonSchema.parse(mutation.reason);
        this.db
          .query(
            "INSERT INTO inbox_resolutions (id, item_id, thread_id, option_id, principal_id, reason, effect_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            mutation.id,
            item.id,
            item.threadId,
            option.id,
            mutation.principalId,
            mutation.reason ?? null,
            JSON.stringify(effect),
            now
          );
        // The effect is frozen, not executed. U7 composes this record with its
        // guarded transition/follow-up in this same commit transaction.
        this.change(item.threadId, {
          kind: "upsert_item",
          itemId: item.id,
          item,
        });
        return;
      }
      case "remove_item": {
        const row = this.itemRow(mutation.itemId),
          item = wireItem(row);
        if (
          row.deleted_at !== null ||
          item.version !== mutation.expectedVersion
        )
          throw new Error("Inbox version conflict");
        if (!TERMINAL.has(item.status))
          throw new Error("Only terminal inbox items can be removed");
        this.db
          .query("UPDATE inbox_items SET deleted_at = ? WHERE id = ?")
          .run(now, item.id);
        this.change(item.threadId, { kind: "remove_item", itemId: item.id });
        return;
      }
      case "remove_thread": {
        const row = this.threadRow(mutation.threadId);
        if (row.deleted_at !== null) throw new Error("Thread already removed");
        const active = this.db
          .query(
            "SELECT 1 FROM inbox_items WHERE thread_id = ? AND deleted_at IS NULL LIMIT 1"
          )
          .get(row.id);
        if (active) throw new Error("Remove thread items first");
        this.db
          .query(
            "UPDATE inbox_threads SET deleted_at = ?, status = 'closed' WHERE id = ?"
          )
          .run(now, row.id);
        this.change(row.id, { kind: "remove_thread" });
        return;
      }
      case "suppress":
        assertId(mutation.classKey);
        assertTime(mutation.expiresAt);
        this.db
          .query(
            "INSERT INTO inbox_suppressions VALUES (?, ?, ?, ?, ?) ON CONFLICT(class_key) DO UPDATE SET evidence_boundary = excluded.evidence_boundary, expires_at = excluded.expires_at, reraise_condition = excluded.reraise_condition"
          )
          .run(
            mutation.classKey,
            mutation.evidenceBoundary,
            mutation.expiresAt,
            mutation.reraiseCondition,
            now
          );
        return;
      case "heartbeat":
        assertId(mutation.name);
        assertTime(mutation.tickAt);
        assertTime(mutation.changeCursor);
        this.db
          .query(
            "INSERT INTO inbox_scheduler_heartbeats VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET tick_at = excluded.tick_at, change_cursor = excluded.change_cursor"
          )
          .run(mutation.name, mutation.tickAt, mutation.changeCursor);
        return;
      case "reserve": {
        const r = mutation.reservation;
        for (const id of [r.id, r.operationKey, r.principalId, r.model])
          assertId(id);
        assertTime(r.attempt);
        assertTime(r.reservedTurns);
        assertMoney(r.reservedCostUsd);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.localDay))
          throw new Error("Invalid reservation day");
        if (r.billingMode === "subscription" && r.reservedCostUsd !== 0)
          throw new Error("Subscription reservation must cost zero");
        this.db
          .query(
            "INSERT INTO inbox_budget_reservations (id, operation_key, item_id, attempt, purpose, run_id, principal_id, model, billing_mode, local_day, reserve_kind, reserved_cost_usd, reserved_turns, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)"
          )
          .run(
            r.id,
            r.operationKey,
            r.itemId,
            r.attempt,
            r.purpose,
            r.runId ?? null,
            r.principalId,
            r.model,
            r.billingMode,
            r.localDay,
            r.reserveKind,
            r.reservedCostUsd,
            r.reservedTurns,
            now
          );
        return;
      }
      case "settle": {
        assertMoney(mutation.chargedCostUsd);
        assertTime(mutation.chargedTurns);
        if (mutation.observedCostUsd !== null)
          assertMoney(mutation.observedCostUsd);
        const row = this.db
          .query(
            "SELECT status, billing_mode FROM inbox_budget_reservations WHERE id = ?"
          )
          .get(mutation.reservationId) as {
          status: string;
          billing_mode: string;
        } | null;
        if (!row || row.status !== "active")
          throw new Error("Reservation already settled or missing");
        if (
          row.billing_mode === "subscription" &&
          mutation.chargedCostUsd !== 0
        )
          throw new Error("Subscription settlement must cost zero");
        if (
          mutation.observedCostUsd !== null &&
          mutation.chargedCostUsd < mutation.observedCostUsd
        )
          throw new Error("Settlement cannot erase observed spend");
        this.db
          .query(
            "UPDATE inbox_budget_reservations SET status = ?, observed_cost_usd = ?, charged_cost_usd = ?, charged_turns = ?, settled_at = ? WHERE id = ?"
          )
          .run(
            mutation.status,
            mutation.observedCostUsd,
            mutation.chargedCostUsd,
            mutation.chargedTurns,
            now,
            mutation.reservationId
          );
        return;
      }
    }
  }

  snapshot(): InboxStoreSnapshot {
    const read = (): InboxStoreSnapshot => {
      const threads = (
        this.db
          .query(
            "SELECT * FROM inbox_threads WHERE deleted_at IS NULL ORDER BY id"
          )
          .all() as ThreadRow[]
      ).map(wireThread);
      const items = (
        this.db
          .query(
            "SELECT * FROM inbox_items WHERE deleted_at IS NULL ORDER BY id"
          )
          .all() as ItemRow[]
      ).map(wireItem);
      const highWaterSeq = Object.fromEntries(
        (
          this.db
            .query(
              "SELECT thread_id, seq FROM inbox_thread_sequences ORDER BY thread_id"
            )
            .all() as { thread_id: string; seq: number }[]
        ).map((row) => [row.thread_id, row.seq])
      );
      const { cursor } = this.db
        .query(
          "SELECT COALESCE(MAX(change_id), 0) AS cursor FROM inbox_changes"
        )
        .get() as { cursor: number };
      return { threads, items, highWaterSeq, cursor };
    };
    return this.db.transaction(read)();
  }
  changesSince(cursor: number, limit = 500): InboxChange[] {
    assertTime(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error("Invalid inbox change limit");
    const rows = this.db
      .query(
        "SELECT * FROM inbox_changes WHERE change_id > ? ORDER BY change_id LIMIT ?"
      )
      .all(cursor, limit) as {
      change_id: number;
      thread_id: string;
      seq: number;
      data_json: string;
    }[];
    return rows.map((row) =>
      inboxChangeSchema.parse({
        ...JSON.parse(row.data_json),
        changeId: row.change_id,
        threadId: row.thread_id,
        seq: row.seq,
      })
    );
  }
  orderedItems(): Array<{ item: InboxItem; priority: number }> {
    const snapshot = this.snapshot(),
      now = this.now();
    const threads = new Map(
      snapshot.threads.map((thread) => [thread.id, thread])
    );
    return snapshot.items
      .map((item) => {
        const thread = threads.get(item.threadId)!;
        return {
          item,
          priority: inboxPriority(
            thread.stakes,
            thread.deadline,
            item.createdAt,
            item.queue === "queue" ? item.attempts : 0,
            now
          ),
        };
      })
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.item.createdAt - b.item.createdAt ||
          (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)
      );
  }
  /** Complete operational export, including tombstones/history. U13 owns restore/backup. */
  exportState(): Record<(typeof TABLES)[number], Record<string, unknown>[]> {
    return this.db.transaction(() =>
      Object.fromEntries(
        TABLES.map((table) => [
          table,
          this.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ])
      )
    )() as Record<(typeof TABLES)[number], Record<string, unknown>[]>;
  }
}

export function createInboxStore(
  db: Database,
  options: { now?: () => number } = {}
): InboxStore {
  return new InboxStore(db, options.now);
}
