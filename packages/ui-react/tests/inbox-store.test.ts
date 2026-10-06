import { expect, test } from "bun:test";
import type { InboxActionItem, InboxThread } from "@schlessera/brain-ui-sdk/protocol";
import { changedDecisionFields, createInboxStore, pendingDecisionCount } from "../src/stores/inbox-state.js";
import { groupDecisions, viewDecision } from "../src/components/activity/inbox-model.js";

const T = Date.UTC(2026, 6, 12, 9);
const thread = (id: string, stakes = 1, deadline?: number): InboxThread => ({
  id, trustClass: "untrusted", source: "share", status: "open", stateMd: "Ithaca port", stakes,
  ...(deadline !== undefined ? { deadline } : {}), createdAt: T, lastSeenAt: T,
});
const action = (id: string, threadId: string, extra: Partial<InboxActionItem> = {}): InboxActionItem => ({
  id, dedupKey: id, threadId, queue: "actions", type: "approve", status: "pending", version: 1,
  createdAt: T, updatedAt: T, expiresAt: T + 86_400_000,
  payload: { title: `Harbour fee ${id}`, detail: "Penelope forwarded it." },
  options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }], ...extra,
});

function seeded(items: InboxActionItem[]) {
  const store = createInboxStore();
  store.getState().setSupported(true);
  store.getState().applySnapshot({ type: "inbox_snapshot", view: "actions", threads: [thread("t")], items, highWaterSeq: { t: 5 }, cursor: 5 });
  store.getState().applySnapshot({ type: "inbox_snapshot", view: "queue", threads: [], items: [], highWaterSeq: {}, cursor: 5 });
  return store;
}

test("deltas before a snapshot and at or below the thread's high-water seq are ignored", () => {
  const store = createInboxStore();
  store.getState().applyDelta({ type: "inbox_delta", view: "actions", change: { changeId: 1, threadId: "t", seq: 1, kind: "upsert_item", itemId: "a", item: action("a", "t") } });
  expect(store.getState().items).toEqual({});
  const s = seeded([]);
  s.getState().applyDelta({ type: "inbox_delta", view: "actions", change: { changeId: 6, threadId: "t", seq: 5, kind: "upsert_item", itemId: "a", item: action("a", "t") } });
  expect(s.getState().items.a).toBeUndefined();
  s.getState().applyDelta({ type: "inbox_delta", view: "actions", change: { changeId: 7, threadId: "t", seq: 6, kind: "upsert_item", itemId: "a", item: action("a", "t") } });
  expect(s.getState().items.a).toBeDefined();
});

test("the count is open non-FYI decisions; FYIs and snoozed items do not count", () => {
  const s = seeded([action("a", "t"), action("b", "t", { status: "snoozed" }), action("c", "t", { type: "fyi", options: [] })]);
  expect(pendingDecisionCount(s.getState())).toBe(1);
});

test("a version change records only the fields that changed and must be reviewed", () => {
  const s = seeded([action("a", "t")]);
  s.getState().applyDelta({ type: "inbox_delta", view: "actions", change: { changeId: 7, threadId: "t", seq: 6, kind: "upsert_item", itemId: "a",
    item: action("a", "t", { version: 2, updatedAt: T + 1, payload: { title: "Harbour fee a, corrected", detail: "Penelope forwarded it." } }) } });
  expect(s.getState().changes.a).toMatchObject({ fields: ["title"], reviewed: false });
  s.getState().reviewChanges("a");
  expect(s.getState().changes.a!.reviewed).toBe(true);
  // A version bump that changes nothing shown is not a change.
  expect(changedDecisionFields(action("x", "t"), action("x", "t", { version: 3, updatedAt: T + 9 }))).toEqual([]);
});

test("one decision in flight per item", () => {
  const s = seeded([action("a", "t")]);
  expect(s.getState().beginDecision("a", { kind: "dismiss", optionId: "dismiss", label: "Dismiss", receipt: "Dismissed" })).toBe(true);
  expect(s.getState().beginDecision("a", { kind: "dismiss", optionId: "dismiss", label: "Dismiss", receipt: "Dismissed" })).toBe(false);
});

test("groups follow the server's score, then creation time, then id", () => {
  const threads = { low: thread("low", 1), high: thread("high", 3), urgent: thread("urgent", 1, T + 3_600_000) };
  const groups = groupDecisions([
    action("l2", "low", { createdAt: T - 1 }), action("l1", "low", { createdAt: T - 2 }),
    action("h1", "high"), action("u1", "urgent"),
  ], threads, T);
  expect(groups.map((g) => g.threadId)).toEqual(["urgent", "high", "low"]);
  expect(groups[2]!.items.map((i) => i.id)).toEqual(["l1", "l2"]);
});

test("an option that fails the strict schema is malformed, and a deferred one is unavailable", () => {
  const view = viewDecision(action("a", "t", { options: [
    { id: "approve", label: "File", effect: { kind: "enqueue", payload: { instruction: "x", operation: { toolName: "Edit", targetPath: "finances/ithaca-port.md", input: { grants: ["all"] } } } } },
    { id: "always", label: "Always allow", effect: { kind: "write_policy", policy: { slug: "harbour", content: "always" } } },
  ] }), null);
  expect(view.commits).toHaveLength(0);
  expect(view.malformed.map((m) => m.option.id)).toEqual(["approve"]);
  expect(view.unavailable.map((u) => u.option.id)).toEqual(["always"]);
});

test("a confirmation by status alone does not claim which of two commit options won", () => {
  const s = seeded([action("a", "t")]);
  s.getState().beginDecision("a", { kind: "commit", optionId: "one", label: "Apply: one", receipt: "Applied · one", ambiguous: true });
  s.getState().applyDelta({ type: "inbox_delta", view: "actions", change: { changeId: 7, threadId: "t", seq: 6, kind: "upsert_item", itemId: "a", item: action("a", "t", { status: "resolved", version: 2 }) } });
  const outcome = s.getState().outcomes.a;
  expect(outcome).toMatchObject({ kind: "receipt", status: "resolved", by: "unknown" });
  expect(outcome && "text" in outcome ? outcome.text : undefined).toBeUndefined();
});

test("an item carried only by a later snapshot chunk keeps its in-flight answer and reconciles", () => {
  const s = seeded([action("a", "t"), action("b", "t")]);
  s.getState().beginDecision("b", { kind: "commit", optionId: "approve", label: "Approve", receipt: "Approved" });
  s.getState().connectionLost();
  const snap = (items: InboxActionItem[], append?: boolean) => s.getState().applySnapshot({
    type: "inbox_snapshot", view: "actions", threads: [thread("t")], items, highWaterSeq: { t: 9 }, cursor: 9, ...(append ? { append } : {}),
  });
  snap([action("a", "t")]);
  // The first chunk did not carry b: provisionally gone.
  expect(s.getState().items.b).toBeUndefined();
  snap([action("b", "t", { status: "resolved", version: 2 })], true);
  expect(s.getState().outcomes.b).toMatchObject({ kind: "receipt", status: "resolved", by: "you", afterReconnect: true });
  expect(s.getState().inFlight.b).toBeUndefined();
});

test("another device's snooze does not settle an Approve sent from here", () => {
  const s = seeded([action("a", "t")]);
  s.getState().beginDecision("a", { kind: "commit", optionId: "approve", label: "Approve", receipt: "Approved" });
  const delta = (seq: number, extra: Partial<InboxActionItem>) => s.getState().applyDelta({ type: "inbox_delta", view: "actions",
    change: { changeId: seq, threadId: "t", seq, kind: "upsert_item", itemId: "a", item: action("a", "t", extra) } });
  delta(6, { status: "snoozed", version: 2, waitUntil: T + 3_600_000 });
  expect(s.getState().inFlight.a?.state).toBe("applying");
  expect(s.getState().outcomes.a).toBeUndefined();
  delta(7, { status: "resolved", version: 3 });
  expect(s.getState().outcomes.a).toMatchObject({ kind: "receipt", status: "resolved", by: "you", text: "Approved" });
});

test("after a review, a status-only update does not resurrect the reviewed change", () => {
  const s = seeded([action("a", "t")]);
  const delta = (seq: number, extra: Partial<InboxActionItem>) => s.getState().applyDelta({ type: "inbox_delta", view: "actions",
    change: { changeId: seq, threadId: "t", seq, kind: "upsert_item", itemId: "a", item: action("a", "t", extra) } });
  const revised = { payload: { title: "Harbour fee a, corrected", detail: "Penelope forwarded it." } };
  delta(6, { version: 2, ...revised });
  s.getState().reviewChanges("a");
  // A version bump that changes nothing the reader sees (e.g. a lease or
  // bookkeeping write) must not re-lock the answers.
  delta(7, { version: 3, updatedAt: T + 5, ...revised });
  expect(s.getState().changes.a).toMatchObject({ reviewed: true, fields: ["title"] });
});
