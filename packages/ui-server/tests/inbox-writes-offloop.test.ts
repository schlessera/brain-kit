/** Inbox lifecycle commits share the hosted write worker (#3001). */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createBrainApplication } from "../src/brain/application.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createInboxIntake, IntakeKeyConflictError } from "../src/inbox/intake.js";
import { createInteractiveShares } from "../src/inbox/interactive-share.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";
import { createInboxStore } from "../src/inbox/store.js";
import { inboxLifecycleWrites } from "../src/inbox/lifecycle-writes.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { createInboxAction } from "../src/inbox/actions.js";
import { createInboxCleanup } from "../src/inbox/cleanup.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createHygieneReview } from "../src/inbox/hygiene-review.js";
import type { BrainClient } from "../src/brain/client.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { registerInboxWrites } from "../src/inbox/write-runtime.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import { expectRejection } from "./helpers/expect-rejection.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inbox-writes-odysseus-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  registerInboxWrites(db, writer);
  return { root, db, writer, principal, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("intake and replay commit on the write worker at FULL, never on the app connection", async () => {
  const f = fixture(), intake = createInboxIntake(f.db, f.root);
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_intake_receipts", "inbox_threads", "inbox_items", "inbox_changes", "inbox_thread_sequences"]);
    const first = await intake.cli({ text: "Odysseus returns to Ithaca.", files: [] }, "odysseus", f.principal);
    expect(createInboxStore(f.db).getItem(first.itemId), "INBOX_INTAKE_COMMITTED_BEFORE_REPLY").not.toBeNull();
    const replay = await intake.cli({ text: "Odysseus returns to Ithaca.", files: [] }, "odysseus", f.principal);
    expect(replay.created, "INBOX_REPLAY_KEEPS_ONE_ITEM").toBe(false);
    await expectRejection(intake.cli({ text: "A different route.", files: [] }, "odysseus", f.principal), IntakeKeyConflictError, "INBOX_REFUSAL_CLASS_KEPT");
    expect(new Set(await sites.log()), "INBOX_INTAKE_WRITES_ON_WORKER_AT_FULL").toEqual(new Set(["inbox_intake_receipts", "inbox_threads", "inbox_items", "inbox_changes", "inbox_thread_sequences"]));
  } finally { await intake.close(); await f.close(); }
});

test("interactive share start bind and end commit on the write worker at FULL", async () => {
  const f = fixture(), intake = createInboxIntake(f.db, f.root);
  const shares = createInteractiveShares(f.db, f.root);
  try {
    const arrival = await intake.share({ text: "Odysseus' homecoming.", files: [] }, f.principal);
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_interactive_shares", "inbox_items", "inbox_changes", "inbox_thread_sequences"]);
    await shares.start(f.principal.id, "odysseus-turn", undefined, arrival.result.id, () => true);
    await shares.bind("odysseus-turn", "odysseus-session");
    expect(f.db.query("SELECT session_id FROM inbox_interactive_shares").get(), "INBOX_SHARE_BIND_COMMITTED").toEqual({ session_id: "odysseus-session" });
    await shares.end("odysseus-turn");
    expect(createInboxStore(f.db).getItem(arrival.itemId)?.status, "INBOX_SHARE_END_RECOVERED").toBe("ready");
    expect(new Set(await sites.log()), "INBOX_SHARE_WRITES_ON_WORKER_AT_FULL").toEqual(new Set(["inbox_interactive_shares", "inbox_items", "inbox_changes", "inbox_thread_sequences"]));
  } finally { await shares.end("odysseus-turn"); await intake.close(); await f.close(); }
});

test("share application and completion receipts commit on the write worker at FULL", async () => {
  const f = fixture(), intake = createInboxIntake(f.db, f.root), shares = createInteractiveShares(f.db, f.root);
  try {
    mkdirSync(join(f.root, "notes"));
    const arrival = await intake.share({ text: "Odysseus returns to Ithaca.", files: [] }, f.principal);
    await shares.start(f.principal.id, "odysseus-turn", "odysseus-session", arrival.result.id, () => true);
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_share_applications", "inbox_interactive_shares", "inbox_items", "inbox_changes", "inbox_thread_sequences"]);
    const input = { operation: "write" as const, path: "notes/ithaca.md", expectedBaseHash: null, content: `Odysseus returns.\n<!-- share-source:${arrival.result.id} -->\n` };
    const lock = createKeyedLock();
    const application = createBrainApplication({ root: f.root, principalId: f.principal.id, turnId: "odysseus-turn", signal: new AbortController().signal,
      isAuthorized: () => true, approve: async () => false, record() {}, policy: { lock, available: ["write"], autoAllowed: ["write"] },
      planner: { planAdd: async () => { throw new Error("No capture in this fixture"); }, index: async () => {} } });
    let applied = 0;
    const apply = () => { applied++; return application({ principalId: f.principal.id, turnId: "odysseus-turn", input }); };
    const result = await shares.apply(f.principal.id, "odysseus-turn", "odysseus-session", () => true, input, apply);
    expect(result.ok, "INBOX_SHARE_APPLICATION_SUCCEEDED").toBe(true);
    expect(result.shareReceiptId, "INBOX_SHARE_APPLICATION_RECEIPT_COMMITTED").toBeDefined();
    expect(await shares.apply(f.principal.id, "odysseus-turn", "odysseus-session", () => true, input, apply), "INBOX_SHARE_APPLICATION_REPLAY").toEqual(result);
    expect(applied, "INBOX_SHARE_APPLICATION_APPLIED_ONCE").toBe(1);
    const request = { receiptIds: [result.shareReceiptId!], files: [] };
    const complete = () => shares.complete(f.principal.id, "odysseus-turn", "odysseus-session", () => true, request, async () => false, lock);
    expect(await complete(), "INBOX_SHARE_COMPLETION_COMMITTED_BEFORE_REPLY").toEqual({ itemId: arrival.itemId, status: "done", replay: false });
    expect(await complete(), "INBOX_SHARE_COMPLETION_REPLAY").toEqual({ itemId: arrival.itemId, status: "done", replay: true });
    expect(await sites.log(), "INBOX_SHARE_RECEIPTS_ON_WORKER_AT_FULL").toContain("inbox_share_applications");
  } finally { await shares.end("odysseus-turn"); await intake.close(); await f.close(); }
});

test("recovery lifecycle and heartbeat commit on the write worker at FULL", async () => {
  const f = fixture();
  let runtime: ReturnType<typeof createInboxRuntime> | undefined;
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_scheduler_heartbeats", "inbox_changes", "inbox_thread_sequences", "inbox_items"]);
    runtime = createInboxRuntime(f.db, { log: { emit() {}, enabled: () => false } });
    await runtime.ready;
    expect(await runtime.tick(), "INBOX_TICK_COMMITTED_BEFORE_REPLY").not.toHaveProperty("failed");
    expect(await sites.log(), "INBOX_HEARTBEAT_WRITES_ON_WORKER_AT_FULL").toEqual(["inbox_scheduler_heartbeats", "inbox_scheduler_heartbeats"]);
  } finally { await runtime?.close(); await f.close(); }
});

test("expired leases reconcile their budget and recover on the write worker at FULL", async () => {
  const f = fixture(), store = createInboxStore(f.db);
  let runtime: ReturnType<typeof createInboxRuntime> | undefined;
  try {
    let at = Date.now();
    store.ingest({ threadId: "odysseus", itemId: "arrival", source: "share", dedupKey: "arrival", stagingId: "odysseus", expiresAt: at + 86_400_000, stakes: 1 });
    const budget = createInboxBudget(f.db, { now: () => at, config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => null } });
    expect(budget.claim("arrival", { runId: "odysseus-turn", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "triage" }, at + 5)).not.toBeNull();
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_budget_reservations", "inbox_items", "inbox_changes", "inbox_thread_sequences", "inbox_scheduler_heartbeats"]);
    at += 10;
    runtime = createInboxRuntime(f.db, { now: () => at, log: { emit() {}, enabled: () => false } });
    await runtime.ready;
    expect(store.getItem("arrival"), "INBOX_EXPIRED_LEASE_RECOVERED_ON_WORKER").toMatchObject({ status: "ready", attempts: 1 });
    expect(f.db.query("SELECT status FROM inbox_budget_reservations").get(), "INBOX_BUDGET_RECONCILED_BEFORE_RECOVERY_REPLY").toEqual({ status: "released" });
    expect((await sites.log())[0], "INBOX_BUDGET_COMMIT_PRECEDES_LEASE_RECOVERY").toBe("inbox_budget_reservations");
  } finally { await runtime?.close(); await f.close(); }
});

test("failed inbox boot recovery submits no later sweep or heartbeat", async () => {
  const f = fixture();
  let runtime: ReturnType<typeof createInboxRuntime> | undefined;
  try {
    let at = Date.now();
    const store = createInboxStore(f.db);
    store.ingest({ threadId: "odysseus", itemId: "arrival", source: "share", dedupKey: "arrival", stagingId: "odysseus", expiresAt: at + 86_400_000, stakes: 1 });
    const budget = createInboxBudget(f.db, { now: () => at, config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => null } });
    budget.claim("arrival", { runId: "odysseus-turn", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "triage" }, at + 5);
    f.db.exec("CREATE TRIGGER refuse_recovery BEFORE UPDATE ON inbox_budget_reservations BEGIN SELECT RAISE(ABORT, 'fixture recovery failure'); END");
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_scheduler_heartbeats"]);
    at += 10;
    runtime = createInboxRuntime(f.db, { now: () => at, log: { emit() {}, enabled: () => false } });
    await expectRejection(runtime.ready, "fixture recovery failure");
    expect(await sites.log(), "INBOX_FAILED_RECOVERY_SUBMITS_NO_LATER_WRITES").toEqual([]);
  } finally { await runtime?.close(); await f.close(); }
});

test("decisions and cleanup commit on the write worker at FULL before their reply", async () => {
  const f = fixture(), store = createInboxStore(f.db), cleanup = createInboxCleanup(f.db, f.root);
  try {
    const at = Date.now(), stagingId = crypto.randomUUID();
    store.ingest({ threadId: "odysseus", itemId: "arrival", source: "share", dedupKey: "arrival", stagingId, expiresAt: at + 86_400_000, stakes: 1 });
    store.commit([{ kind: "transition", itemId: "arrival", expectedVersion: 1, to: "claimed", leaseUntil: at + 60_000 },
      { kind: "transition", itemId: "arrival", expectedVersion: 2, to: "done" }]);
    createInboxAction(f.db, { id: "decision", dedupKey: "decision", threadId: "odysseus", queue: "actions", type: "choose", status: "pending", version: 1,
      createdAt: at, updatedAt: at, expiresAt: at + 86_400_000, payload: { title: "Return to Ithaca", detail: "Choose the route." },
      options: [{ id: "later", label: "Later", effect: { kind: "snooze" } }, { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] }, []);
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_items", "inbox_changes", "inbox_thread_sequences", "inbox_resolutions"]);
    const resolver = createInboxResolver(f.db, { allowedOperations: () => [] });
    await resolver.snoozeAsync(f.principal.id, "decision");
    expect(store.getItem("decision")?.status, "INBOX_SNOOZE_COMMITTED_BEFORE_REPLY").toBe("snoozed");
    await resolver.resolveAsync(f.principal.id, { type: "inbox_resolve", itemId: "decision", optionId: "dismiss" });
    expect(store.getItem("decision")?.status, "INBOX_DECISION_COMMITTED_BEFORE_REPLY").toBe("dismissed");
    expect((await cleanup.run({})).cleaned, "INBOX_CLEANUP_COMMITTED_BEFORE_REPLY").toBe(1);
    const log = await sites.log();
    expect(log, "INBOX_DECISION_WRITES_ON_WORKER_AT_FULL").toContain("inbox_resolutions");
    expect(store.snapshot().items.find(item => item.type === "cleanup_pending")?.status, "INBOX_CLEANUP_DONE_ON_WORKER").toBe("done");
  } finally { await cleanup.close(); await f.close(); }
});

test("hygiene review admission preview and completion commit on the write worker at FULL", async () => {
  const f = fixture();
  try {
    let finished = false;
    const counts = { eligibleRemaining: 1, fixed: 0, dismissed: 0, snoozed: 0, nextSnoozeDueAt: null, informationalNotShown: 0 };
    const finding = { id: "odysseus-finding", fingerprint: "ithaca", path: "notes/ithaca.md", title: "Review the route", handlers: [
      { name: "route", kind: "field", input: { type: "string" }, effect: "Name the route", explanation: "Use the chosen route." },
    ] };
    const brain = { hygiene: async (args: string[]) => {
      if (args[0] === "next") return { finding: finished ? null : finding, counts };
      if (args.includes("--dry-run")) return { status: "preview", id: finding.id, previewToken: "route-preview", diff: { path: finding.path, before: "Sea", after: "Ithaca", changes: [] } };
      finished = true; return { status: "fixed", id: finding.id };
    } } as BrainClient;
    const review = createHygieneReview(f.db, { brain });
    const sites = await watchWriteSites(f.db, f.writer, ["hygiene_review", "hygiene_effect_attempts", "hygiene_action_revisions", "inbox_items", "inbox_changes", "inbox_thread_sequences", "inbox_resolutions"]);
    const first = (await review.command(f.principal.id, "start")).action!;
    const preview = await review.preview(f.principal.id, { itemId: first.id, optionId: "route", expectedVersion: first.version, input: "Ithaca" });
    await review.resolver.resolveAsync(f.principal.id, { type: "inbox_resolve", itemId: preview.id, optionId: "route", input: "Ithaca" });
    expect(review.read().review, "INBOX_HYGIENE_COMPLETED_BEFORE_REPLY").toMatchObject({ status: "complete", fixed: 1 });
    expect(new Set(await sites.log()), "INBOX_HYGIENE_WRITES_ON_WORKER_AT_FULL").toEqual(new Set(["hygiene_review", "hygiene_effect_attempts", "hygiene_action_revisions", "inbox_items", "inbox_changes", "inbox_thread_sequences", "inbox_resolutions"]));
  } finally { await f.close(); }
});

test("concurrent inbox submissions keep gap-free sequences and commit order through a rollback", async () => {
  const f = fixture(), store = createInboxStore(f.db);
  try {
    const at = Date.now();
    store.ingest({ threadId: "odysseus", itemId: "arrival", source: "share", dedupKey: "arrival", stagingId: "odysseus", expiresAt: at + 86_400_000, stakes: 1 });
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_changes", "inbox_thread_sequences", "inbox_checkpoints"]);
    const write = inboxLifecycleWrites(f.db);
    const checkpoint = (n: number) => ({ kind: "checkpoint", id: `voyage-${n}`, threadId: "odysseus", stateMd: `Port ${n}`, facts: { decisions: [], operations: [], capabilities: [], paths: [], questions: [] } });
    const commits = Array.from({ length: 12 }, (_, n) => write("commit", n === 5 ? [checkpoint(n), { kind: "transition", itemId: "missing", expectedVersion: 1, to: "done" }] : [checkpoint(n)], at));
    const results = await Promise.allSettled(commits);
    expect(results.filter(result => result.status === "rejected"), "INBOX_ONE_TRANSACTION_ROLLED_BACK").toHaveLength(1);
    expect(store.checkpoints("odysseus").map(row => row.stateMd), "INBOX_CONCURRENT_COMMITS_IN_SUBMISSION_ORDER").toEqual(Array.from({ length: 12 }, (_, n) => n).filter(n => n !== 5).map(n => `Port ${n}`));
    const rows = f.db.query("SELECT change_id, seq FROM inbox_changes ORDER BY change_id").all() as { change_id: number; seq: number }[];
    expect(rows.map(row => row.change_id), "INBOX_CHANGE_IDS_GAP_FREE_AFTER_ROLLBACK").toEqual(rows.map((_, i) => i + 1));
    expect(rows.map(row => row.seq), "INBOX_THREAD_SEQUENCES_GAP_FREE_AFTER_ROLLBACK").toEqual(rows.map((_, i) => i + 1));
    expect((await sites.log()).filter(table => table === "inbox_checkpoints"), "INBOX_ROLLED_BACK_WRITE_NOT_COMMITTED").toHaveLength(11);
  } finally { await f.close(); }
});

test("share submission does not wait on the app loop and settles after earlier worker commits", async () => {
  const f = fixture(), shares = createInteractiveShares(f.db, f.root);
  try {
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 400);
    const at = performance.now();
    let settled = false;
    const started = shares.start(f.principal.id, "odysseus-turn", undefined, undefined, () => true).then(() => { settled = true; });
    expect(performance.now() - at, "INBOX_SHARE_SUBMISSION_NEVER_BLOCKS_APP_LOOP").toBeLessThan(100);
    await Bun.sleep(20);
    expect(settled, "INBOX_SHARE_WAITS_FOR_EARLIER_COMMITS").toBe(false);
    await slow; await started;
  } finally { await f.close(); }
});

test("inbox and Activity commits keep their shared submission order", async () => {
  const f = fixture();
  try {
    const at = Date.now(), store = createInboxStore(f.db);
    store.ingest({ threadId: "odysseus", itemId: "arrival", source: "share", dedupKey: "arrival", stagingId: "odysseus", expiresAt: at + 86_400_000, stakes: 1 });
    const sites = await watchWriteSites(f.db, f.writer, ["inbox_checkpoints", "activity_spans"]);
    const write = inboxLifecycleWrites(f.db), activity = createOffloopActivityStore(f.db, f.writer, { writer: "odysseus", pricingConfig: { brainPath: f.root, enabled: false } });
    const commits: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      commits.push(write("commit", [{ kind: "checkpoint", id: `voyage-${i}`, threadId: "odysseus", stateMd: `Port ${i}`, facts: { decisions: [], operations: [], capabilities: [], paths: [], questions: [] } }], at));
      commits.push(activity.startSpan({ spanId: `voyage-${i}`, runId: `voyage-${i}`, name: "invoke_agent", kind: "turn", origin: "session" }));
    }
    await Promise.all(commits);
    expect(await sites.log(), "INBOX_ACTIVITY_SHARED_COMMIT_ORDER").toEqual(Array.from({ length: 4 }, () => ["inbox_checkpoints", "activity_spans"]).flat());
  } finally { await f.close(); }
});
