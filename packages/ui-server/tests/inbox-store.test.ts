import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InboxActionItem,
  InboxChange,
  InboxItem,
  InboxThread,
} from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import {
  createInboxStore,
  type InboxCheckpointFacts,
  type InboxReservation,
  type InboxStore,
} from "../src/inbox/store.js";
import { inboxPriority } from "../src/inbox/state.js";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const facts: InboxCheckpointFacts = {
  decisions: ["Archive approved"],
  capabilities: ["grant-operation-1"],
  operations: [
    {
      toolName: "archive",
      input: { reason: "reviewed" },
      targetPath: "inbox/example.md",
    },
  ],
  paths: ["inbox/example.md"],
  questions: ["Confirm retention period?"],
};

describe("durable inbox store", () => {
  let dir: string, path: string, db: Database, store: InboxStore, now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-inbox-store-"));
    path = join(dir, "ui.sqlite");
    db = createUiDb(path);
    now = START;
    store = createInboxStore(db, { now: () => now });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ingest(
    id = "seed",
    source: "share" | "cli" = "share",
    stakes = 2,
    deadline?: number
  ) {
    return store.ingest({
      threadId: `thread-${id}`,
      itemId: `item-${id}`,
      dedupKey: `dedup-${id}`,
      stagingId: `staging-${id}`,
      source,
      stakes,
      deadline,
      expiresAt: now + 30 * DAY,
    });
  }
  function action(id = "action", threadId = "thread-seed"): InboxActionItem {
    return {
      id,
      threadId,
      dedupKey: `dedup-${id}`,
      queue: "actions",
      type: "approve",
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + DAY,
      payload: {
        title: "Archive document?",
        detail: "Keep a reversible copy.",
      },
      options: [
        {
          id: "accept",
          label: "Archive",
          effect: {
            kind: "enqueue",
            payload: { instruction: "Archive document" },
          },
        },
      ],
    };
  }
  function transition(
    itemId: string,
    to: InboxItem["status"],
    extra: {
      leaseUntil?: number;
      blockedByItemId?: string;
      waitUntil?: number | null;
    } = {}
  ) {
    store.commit([
      {
        kind: "transition",
        itemId,
        expectedVersion: store.getItem(itemId)!.version,
        to,
        ...extra,
      },
    ]);
  }
  function reservation(id = "reservation"): InboxReservation {
    return {
      id,
      operationKey: `operation-${id}`,
      itemId: "item-seed",
      attempt: 1,
      purpose: "triage",
      runId: "run",
      principalId: "principal",
      model: "fixture-model",
      billingMode: "api",
      localDay: "2026-01-01",
      reserveKind: "normal",
      reservedCostUsd: 0.4,
      reservedTurns: 4,
    };
  }

  test("ingest derives immutable trust and dedup updates last seen without another item", () => {
    const first = ingest();
    const before = store.snapshot();
    now += 1000;
    const duplicate = store.ingest({
      threadId: "unused",
      itemId: "unused",
      source: "cli",
      stakes: 3,
      dedupKey: "dedup-seed",
      stagingId: "other",
      expiresAt: now + DAY,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.item).toEqual(first.item);
    expect(duplicate.thread).toMatchObject({
      trustClass: "untrusted",
      source: "share",
      lastSeenAt: now,
    });
    expect(store.snapshot().items).toHaveLength(1);
    expect(store.snapshot().threads).toHaveLength(1);
    expect(store.changesSince(before.cursor)).toHaveLength(1);
    expect(ingest("trusted", "cli").thread.trustClass).toBe("trusted");
  });

  test("Queue leases, retries, blocked supersession and Action resurface use separate transitions", () => {
    ingest();
    store.commit([{ kind: "item", item: action() }]);
    transition("item-seed", "claimed", { leaseUntil: now + 1000 });
    expect(store.getItem("item-seed")).toMatchObject({
      attempts: 1,
      claimedAt: now,
      leaseUntil: now + 1000,
    });
    now += 1001;
    transition("item-seed", "ready");
    expect(store.getItem("item-seed")).not.toHaveProperty("leaseUntil");
    transition("item-seed", "claimed", { leaseUntil: now + 1000 });
    transition("item-seed", "failed");
    transition("item-seed", "ready", { waitUntil: now + 10 });
    transition("item-seed", "claimed", { leaseUntil: now + 1000 });
    transition("item-seed", "blocked", { blockedByItemId: "action" });
    transition("item-seed", "superseded");
    expect(store.getItem("item-seed")).not.toHaveProperty("blockedByItemId");
    transition("action", "snoozed", { waitUntil: now + DAY });
    const before = store.snapshot();
    expect(() =>
      transition("action", "claimed", { leaseUntil: now + 1000 })
    ).toThrow("Forbidden actions transition");
    expect(store.snapshot()).toEqual(before);
    transition("action", "pending", { waitUntil: null });
    expect(store.getItem("action")).not.toHaveProperty("waitUntil");
    transition("action", "resolved");
    expect(() => transition("action", "pending")).toThrow(
      "Forbidden actions transition"
    );
    expect(() => transition("item-seed", "ready")).toThrow(
      "Forbidden queue transition"
    );
  });

  test("declared expiry and drop paths are usable, including a claimed Queue", () => {
    for (const terminal of ["expired", "dropped"] as const) {
      for (const state of [
        "scheduled",
        "ready",
        "claimed",
        "failed",
      ] as const) {
        const id = `${terminal}-${state}`;
        const { item } = ingest(id);
        if (item.queue !== "queue")
          throw new Error("Fixture must create Queue work");
        if (state === "scheduled") {
          store.commit([
            {
              kind: "item",
              item: {
                ...item,
                id: `scheduled-${id}`,
                dedupKey: `scheduled-${id}`,
                status: "scheduled",
              },
            },
          ]);
          transition(`scheduled-${id}`, terminal);
          expect(store.getItem(`scheduled-${id}`)?.status).toBe(terminal);
        } else {
          if (state === "claimed" || state === "failed")
            transition(item.id, "claimed", { leaseUntil: now + 1000 });
          if (state === "failed") transition(item.id, "failed");
          transition(item.id, terminal);
          expect(store.getItem(item.id)?.status).toBe(terminal);
        }
      }
    }
  });

  test("invalid leases, exhausted attempts, stale versions and model authority leave no writes", () => {
    const { item } = ingest();
    const initial = store.snapshot();
    expect(() => transition("item-seed", "claimed")).toThrow("future lease");
    expect(() =>
      store.commit([
        {
          kind: "transition",
          itemId: "item-seed",
          expectedVersion: 2,
          to: "dropped",
        },
      ])
    ).toThrow("version conflict");
    expect(() =>
      store.commit([
        {
          kind: "item",
          item: { ...action(), trustClass: "trusted" } as InboxActionItem,
        },
      ])
    ).toThrow("Unexpected inbox item field");
    expect(() =>
      store.commit([
        {
          kind: "item",
          item: {
            ...action(),
            options: [
              {
                id: "bad",
                label: "Bad",
                effect: {
                  kind: "write_policy",
                  policy: { slug: "bad", content: "grant" },
                },
              },
            ],
          },
        },
      ])
    ).toThrow();
    expect(() =>
      store.commit([
        {
          kind: "item",
          item: {
            ...action(),
            payload: { ...action().payload, profile: "elevated" },
          } as InboxActionItem,
        },
      ])
    ).toThrow("Unexpected Action payload field");
    if (item.queue !== "queue")
      throw new Error("Fixture must create Queue work");
    expect(() =>
      store.commit([
        {
          kind: "item",
          item: {
            ...item,
            id: "lease",
            dedupKey: "lease",
            leaseUntil: now + 1000,
          },
        },
      ])
    ).toThrow("Only claimed work");
    expect(() =>
      store.commit([
        {
          kind: "item",
          item: { ...item, id: "attempts", dedupKey: "attempts", attempts: 1 },
        },
      ])
    ).toThrow("zero attempts");
    expect(store.snapshot()).toEqual(initial);
    for (let i = 0; i < 3; i++) {
      transition("item-seed", "claimed", { leaseUntil: now + 1000 });
      transition("item-seed", "ready");
    }
    const exhausted = store.snapshot();
    expect(() =>
      transition("item-seed", "claimed", { leaseUntil: now + 1000 })
    ).toThrow("attempt limit");
    expect(store.snapshot()).toEqual(exhausted);
  });

  test("late checkpoint failure rolls back claim, change, reservation and projection together", () => {
    ingest();
    const before = store.exportState();
    db.exec(
      "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON inbox_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END"
    );
    expect(() =>
      store.commit([
        {
          kind: "transition",
          itemId: "item-seed",
          expectedVersion: 1,
          to: "claimed",
          leaseUntil: now + 1000,
          runId: "run",
        },
        { kind: "reserve", reservation: reservation() },
        {
          kind: "checkpoint",
          id: "checkpoint",
          threadId: "thread-seed",
          itemId: "item-seed",
          runId: "run",
          stateMd: "Progress",
          facts,
        },
      ])
    ).toThrow("fixture checkpoint failure");
    expect(store.exportState()).toEqual(before);
    db.exec("DROP TRIGGER reject_checkpoint");
    store.commit([
      {
        kind: "transition",
        itemId: "item-seed",
        expectedVersion: 1,
        to: "claimed",
        leaseUntil: now + 1000,
        runId: "run",
      },
      { kind: "reserve", reservation: reservation() },
      {
        kind: "checkpoint",
        id: "checkpoint",
        threadId: "thread-seed",
        itemId: "item-seed",
        runId: "run",
        stateMd: "Progress",
        facts,
      },
    ]);
    expect(store.getItem("item-seed")).toMatchObject({
      status: "claimed",
      version: 2,
    });
    expect(store.checkpoints("thread-seed")).toHaveLength(1);
    expect(store.exportState().inbox_budget_reservations).toHaveLength(1);
    expect(store.changesSince(2).map((entry) => entry.kind)).toEqual([
      "upsert_item",
      "upsert_thread",
    ]);
  });

  test("resolution and follow-up roll back together and freeze a write-once effect", () => {
    ingest();
    store.commit([{ kind: "item", item: action() }]);
    const before = store.exportState();
    const resolution = {
      kind: "resolution",
      id: "resolution",
      itemId: "action",
      optionId: "accept",
      principalId: "principal",
    } as const;
    expect(() =>
      store.commit([
        resolution,
        { kind: "item", item: action("conflict", "missing-thread") },
      ])
    ).toThrow("thread not found");
    expect(store.exportState()).toEqual(before);
    store.commit([
      resolution,
      {
        kind: "transition",
        itemId: "action",
        expectedVersion: 1,
        to: "resolved",
      },
    ]);
    const recorded = store.exportState().inbox_resolutions[0]!;
    expect(JSON.parse(recorded.effect_json as string)).toEqual(
      action().options[0]!.effect
    );
    expect(recorded.principal_id).toBe("principal");
    expect(() =>
      db.exec("UPDATE inbox_resolutions SET principal_id = 'other'")
    ).toThrow("Write-once");
    expect(() => db.exec("DELETE FROM inbox_resolutions")).toThrow(
      "Write-once"
    );
  });

  async function race(operation: "dedup" | "resolution") {
    const workers = [0, 1].map(
      () =>
        new Worker(new URL("./fixtures/inbox-writer.ts", import.meta.url).href)
    );
    try {
      const results = workers.map((worker, ordinal) => {
        let ready!: () => void,
          finish!: (result: { won: boolean; error?: string }) => void,
          reject!: (error: Error) => void;
        const readyPromise = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const resultPromise = new Promise<{ won: boolean; error?: string }>(
          (resolve, fail) => {
            finish = resolve;
            reject = fail;
          }
        );
        worker.onmessage = (event) => {
          if (event.data.kind === "ready") ready();
          else finish(event.data);
        };
        worker.onerror = (event) => {
          ready();
          reject(new Error(event.message));
        };
        worker.postMessage({
          kind: "init",
          path,
          ordinal,
          operation,
          now: now + ordinal,
        });
        return { readyPromise, resultPromise };
      });
      await Promise.all(results.map((result) => result.readyPromise));
      for (const worker of workers) worker.postMessage({ kind: "go" });
      return await Promise.all(results.map((result) => result.resultPromise));
    } finally {
      for (const worker of workers) worker.terminate();
    }
  }

  test("two real concurrent connections dedup one intake", async () => {
    const results = await race("dedup");
    expect(results.map((result) => result.error).filter(Boolean)).toEqual([]);
    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(store.snapshot().items).toHaveLength(1);
    expect(store.snapshot().threads).toHaveLength(1);
    expect(store.snapshot().threads[0]!.lastSeenAt).toBe(now + 1);
  });

  test("unique resolution gives two concurrent connections exactly one winner", async () => {
    ingest();
    store.commit([{ kind: "item", item: action() }]);
    const results = await race("resolution");
    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(results.find((result) => !result.won)!.error).toContain(
      "UNIQUE constraint failed: inbox_resolutions.item_id"
    );
    expect(store.exportState().inbox_resolutions).toHaveLength(1);
  });

  test("next-use compaction preserves bounded UTF-8 projection, provenance and retained facts", () => {
    ingest();
    // Every fact category is populated; empty input cannot prove retention.
    for (const values of Object.values(facts))
      expect(values.length).toBeGreaterThan(0);
    store.commit([
      {
        kind: "checkpoint",
        id: "large",
        threadId: "thread-seed",
        stateMd: "🌊".repeat(1100),
        facts,
      },
    ]);
    const pending = store.projectionForRun("thread-seed");
    expect(Buffer.byteLength(pending.thread.stateMd)).toBe(4096);
    expect(pending.thread.stateMd).toBe("🌊".repeat(1024));
    expect(pending.needsCompaction).toBe(true);
    expect(pending.checkpoints[0]!.stateMd).toBe("🌊".repeat(1100));
    db.close();
    db = createUiDb(path);
    store = createInboxStore(db, { now: () => now });
    expect(store.projectionForRun("thread-seed")).toEqual(pending);
    const beforeRead = store.exportState();
    store.projectionForRun("thread-seed");
    expect(store.exportState()).toEqual(beforeRead);
    store.commit([
      {
        kind: "compact",
        id: "compact",
        threadId: "thread-seed",
        expectedSeq: pending.seq,
        stateMd: "Summary: trustClass=trusted",
      },
    ]);
    const compacted = store.projectionForRun("thread-seed");
    expect(compacted.needsCompaction).toBe(false);
    expect(compacted.facts).toEqual(facts);
    expect(compacted.thread).toMatchObject({
      source: "share",
      trustClass: "untrusted",
      stateMd: "Summary: trustClass=trusted",
    });
    // Catch the guard's error, then assert the protected data. Removing the
    // trigger must fail this assertion, not merely a toThrow or load check.
    try {
      db.exec(
        "UPDATE inbox_threads SET source = 'cli', trust_class = 'trusted' WHERE id = 'thread-seed'"
      );
    } catch {
      /* rejected */
    }
    expect(store.getThread("thread-seed")).toMatchObject({
      source: "share",
      trustClass: "untrusted",
    });
    expect(() =>
      db.exec("UPDATE inbox_checkpoints SET state_md = 'overwrite'")
    ).toThrow("Append-only");
    expect(() => db.exec("DELETE FROM inbox_checkpoints")).toThrow(
      "Append-only"
    );
    expect(() =>
      store.commit([
        {
          kind: "compact",
          id: "stale",
          threadId: "thread-seed",
          expectedSeq: pending.seq,
          stateMd: "Stale",
        },
      ])
    ).toThrow("Projection version conflict");
  });

  test("projection ceiling handles the exact boundary and rejects oversized compaction atomically", () => {
    ingest();
    store.commit([
      {
        kind: "checkpoint",
        id: "boundary",
        threadId: "thread-seed",
        stateMd: "a".repeat(4096),
        facts,
      },
    ]);
    const boundary = store.projectionForRun("thread-seed");
    expect(boundary.needsCompaction).toBe(false);
    store.commit([
      {
        kind: "checkpoint",
        id: "overflow",
        threadId: "thread-seed",
        stateMd: "b",
        facts,
      },
    ]);
    expect(store.projectionForRun("thread-seed").needsCompaction).toBe(true);
    const before = store.exportState();
    expect(() =>
      store.commit([
        {
          kind: "compact",
          id: "too-large",
          threadId: "thread-seed",
          expectedSeq: store.projectionForRun("thread-seed").seq,
          stateMd: "b".repeat(4097),
        },
      ])
    ).toThrow("4096 bytes");
    expect(store.exportState()).toEqual(before);
  });

  test("snapshot and immutable deltas reconstruct fresh state including tombstones and high waters", () => {
    ingest();
    const snapshot = store.snapshot();
    store.commit([{ kind: "item", item: action() }]);
    transition("action", "dismissed");
    store.commit([
      { kind: "remove_item", itemId: "action", expectedVersion: 2 },
    ]);
    transition("item-seed", "dropped");
    store.commit([
      { kind: "remove_item", itemId: "item-seed", expectedVersion: 2 },
      { kind: "remove_thread", threadId: "thread-seed" },
    ]);
    ingest("another");
    const changes: InboxChange[] = [];
    let cursor = snapshot.cursor;
    for (;;) {
      const page = store.changesSince(cursor, 2);
      if (!page.length) break;
      changes.push(...page);
      cursor = page.at(-1)!.changeId;
    }
    const threads = new Map<string, InboxThread>(
      snapshot.threads.map((thread) => [thread.id, thread])
    );
    const items = new Map<string, InboxItem>(
      snapshot.items.map((item) => [item.id, item])
    );
    const highWaterSeq = { ...snapshot.highWaterSeq };
    for (const change of changes) {
      expect(change.seq).toBe((highWaterSeq[change.threadId] ?? 0) + 1);
      highWaterSeq[change.threadId] = change.seq;
      if (change.kind === "upsert_thread")
        threads.set(change.threadId, change.thread);
      else if (change.kind === "upsert_item")
        items.set(change.itemId, change.item);
      else if (change.kind === "remove_item") items.delete(change.itemId);
      else threads.delete(change.threadId);
    }
    expect({
      threads: [...threads.values()],
      items: [...items.values()],
      highWaterSeq,
      cursor,
    }).toEqual(store.snapshot());
    expect(
      changes.find(
        (change) => change.kind === "upsert_item" && change.itemId === "action"
      )
    ).toMatchObject({
      kind: "upsert_item",
      item: { status: "pending", version: 1 },
    });
    expect(
      changes.filter((change) => change.kind.startsWith("remove_"))
    ).toHaveLength(3);
    expect(
      changes
        .filter((change) => change.kind.startsWith("remove_"))
        .every((change) => change.threadId === "thread-seed")
    ).toBe(true);
    expect(store.snapshot().highWaterSeq["thread-seed"]).toBeGreaterThan(0);
    expect(() => store.projectionForRun("thread-seed")).toThrow("removed");
  });

  test("snapshot holds one high-water state when a foreign connection commits between reads", () => {
    ingest();
    const before = store.snapshot();
    const foreignDb = createUiDb(path);
    const foreign = createInboxStore(foreignDb, { now: () => now });
    const query = db.query.bind(db);
    let wrote = false;
    db.query = ((sql: string) => {
      const statement = query(sql);
      return new Proxy(statement, {
        get(target, key) {
          if (
            key === "all" &&
            sql.includes("FROM inbox_threads WHERE deleted_at IS NULL")
          )
            return (...args: unknown[]) => {
              const result = (
                target.all as (...args: unknown[]) => unknown
              ).apply(target, args);
              if (!wrote) {
                wrote = true;
                foreign.ingest({
                  threadId: "foreign",
                  itemId: "foreign",
                  dedupKey: "foreign",
                  source: "share",
                  stakes: 1,
                  stagingId: "foreign",
                  expiresAt: now + DAY,
                });
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof db.query;
    try {
      expect(store.snapshot()).toEqual(before);
      expect(wrote).toBe(true);
    } finally {
      db.query = query;
      foreignDb.close();
    }
    expect(store.snapshot().items).toHaveLength(2);
  });

  test("priority ages at read time, clamps stakes and uses deterministic ties", () => {
    ingest("old", "share", 1);
    store.commit([{ kind: "item", item: action("old-action", "thread-old") }]);
    expect(
      store.orderedItems().find((entry) => entry.item.id === "old-action")!
        .priority
    ).toBe(4);
    now += 5 * DAY;
    ingest("new", "share", 2);
    ingest("ceiling", "share", 4);
    ingest("floor", "share", 0);
    const priorities = store.orderedItems();
    expect(
      priorities.find((entry) => entry.item.id === "old-action")!.priority
    ).toBe(9);
    expect(
      priorities.findIndex((entry) => entry.item.id === "old-action")
    ).toBeLessThan(
      priorities.findIndex((entry) => entry.item.id === "item-new")
    );
    expect(store.getThread("thread-ceiling")!.stakes).toBe(3);
    expect(store.getThread("thread-floor")!.stakes).toBe(1);
    ingest("Z", "share", 3);
    ingest("a", "share", 3);
    const tied = store
      .orderedItems()
      .filter(
        (entry) => entry.item.id === "item-Z" || entry.item.id === "item-a"
      );
    expect(tied.map((entry) => entry.item.id)).toEqual(["item-Z", "item-a"]);
    expect(inboxPriority(1, undefined, START, 100, START + 20 * DAY)).toBe(6);
    for (const [remaining, urgency] of [
      [DAY - 1, 3],
      [DAY, 2],
      [3 * DAY - 1, 2],
      [3 * DAY, 1],
      [7 * DAY - 1, 1],
      [7 * DAY, 0],
      [-1, 3],
    ]) {
      expect(inboxPriority(1, now + remaining!, now, 0, now)).toBe(
        4 + 3 * urgency!
      );
    }
  });

  test("explicit budget, suppression, heartbeat and checkpoint records survive reopening and export", () => {
    ingest();
    store.commit([
      { kind: "reserve", reservation: reservation() },
      {
        kind: "suppress",
        classKey: "example",
        evidenceBoundary: "digest-1",
        expiresAt: now + DAY,
        reraiseCondition: "new evidence",
      },
      {
        kind: "heartbeat",
        name: "drain",
        tickAt: now,
        changeCursor: store.snapshot().cursor,
      },
      {
        kind: "checkpoint",
        id: "checkpoint",
        threadId: "thread-seed",
        stateMd: "State",
        facts,
      },
    ]);
    expect(() =>
      store.commit([
        {
          kind: "settle",
          reservationId: "reservation",
          status: "settled",
          observedCostUsd: 0.6,
          chargedCostUsd: 0.5,
          chargedTurns: 2,
        },
      ])
    ).toThrow("erase observed");
    now += DAY; // Settlement retains the day on which admission happened.
    store.commit([
      {
        kind: "settle",
        reservationId: "reservation",
        status: "settled",
        observedCostUsd: 0.6,
        chargedCostUsd: 0.6,
        chargedTurns: 2,
      },
    ]);
    expect(() =>
      store.commit([
        {
          kind: "settle",
          reservationId: "reservation",
          status: "released",
          observedCostUsd: null,
          chargedCostUsd: 0,
          chargedTurns: 0,
        },
      ])
    ).toThrow("already settled");
    store.commit([
      {
        kind: "reserve",
        reservation: {
          ...reservation("subscription"),
          billingMode: "subscription",
          reservedCostUsd: 0,
          localDay: "2026-01-02",
          reserveKind: "emergency",
        },
      },
    ]);
    const before = store.exportState();
    db.close();
    db = createUiDb(path);
    store = createInboxStore(db, { now: () => now });
    expect(store.exportState()).toEqual(before);
    expect(store.exportState().inbox_budget_reservations[0]).toMatchObject({
      status: "settled",
      local_day: "2026-01-01",
      observed_cost_usd: 0.6,
      charged_cost_usd: 0.6,
      settled_at: now,
    });
    expect(store.exportState().inbox_suppressions).toHaveLength(1);
    expect(store.exportState().inbox_scheduler_heartbeats).toHaveLength(1);
    expect(store.exportState().inbox_budget_reservations[1]).toMatchObject({
      status: "active",
      billing_mode: "subscription",
      reserve_kind: "emergency",
      reserved_cost_usd: 0,
      reserved_turns: 4,
    });
    expect(store.projectionForRun("thread-seed").facts).toEqual(facts);
    expect(
      readdirSync(dir).every((filename) => filename.startsWith("ui.sqlite"))
    ).toBe(true);
  });

  test("migration 021 preserves a populated 020 database and applies once", () => {
    db.close();
    rmSync(path);
    db = new Database(path, { create: true });
    db.exec(
      "PRAGMA foreign_keys = ON; CREATE TABLE _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at INTEGER NOT NULL)"
    );
    const migrations = join(import.meta.dir, "../migrations");
    for (const filename of readdirSync(migrations)
      .filter((name) => name.endsWith(".sql") && name < "021")
      .sort()) {
      db.exec(readFileSync(join(migrations, filename), "utf8"));
      db.query(
        "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)"
      ).run(filename, START);
    }
    db.query(
      "INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)"
    ).run("existing", "Existing session", START, START);
    db.close();
    db = createUiDb(path);
    store = createInboxStore(db, { now: () => now });
    ingest();
    expect(
      db.query("SELECT title FROM sessions WHERE id = 'existing'").get()
    ).toEqual({ title: "Existing session" });
    db.close();
    db = createUiDb(path);
    store = createInboxStore(db, { now: () => now });
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM _migrations WHERE filename = '021_inbox.sql'"
        )
        .get()
    ).toEqual({ n: 1 });
    expect(store.snapshot().items).toHaveLength(1);
  });
});
