/** Schedule route writes keep their SQL/file order on the shared FULL writer. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createScheduleRoutes } from "../src/routes/schedules.js";
import { createScheduleService, ScheduleError } from "../src/schedules/service.js";
import { cronDefinition, POLICY, scheduleFixture } from "./helpers/schedule-fixture.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";

const TABLES = ["schedule_proposals", "schedule_approvals", "schedule_tasks", "schedule_occurrences",
  "schedule_cancel_receipts", "schedule_reconciliations", "schedule_root", "inbox_items", "inbox_changes"];

async function fixture() {
  const f = scheduleFixture(), writer = openSqliteWriter(f.db);
  const service = createScheduleService(f.db, { brainRoot: f.root, now: () => f.clock.now,
    executionPolicy: () => POLICY, gitIgnored: () => false }, writer);
  await service.ready; // rootInfo's boot-only write is deliberately outside the guard.
  const propose = async (key = "ithaca") => (await service.propose(f.owner, { key, definition: cronDefinition() })).proposal;
  const approved = async (key = "ithaca") => {
    const proposal = await propose(key);
    const { approvalId } = await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
    return { proposalId: proposal.id, approvalId, taskId: proposal.taskId };
  };
  const created = async (key = "ithaca") => {
    const input = await approved(key); await service.publish(f.owner, { proposalId: input.proposalId, approvalId: input.approvalId }); return input;
  };
  return { ...f, writer, service, propose, approved, created,
    async close() { await writer.close(); f.close(); } };
}

for (const operation of ["propose", "approve", "publish", "cancel", "reopen", "quarantine", "reconcile", "adopt"] as const) {
  test(`schedule ${operation} commits on the write worker at FULL, never on the app connection`, async () => {
    const f = await fixture();
    try {
      expect(f.writer.offloop).toBe(true);
      const input = operation === "propose" ? null : operation === "approve"
        ? { proposal: await f.propose() } : operation === "publish" || operation === "quarantine"
          ? await f.approved() : await f.created();
      const taskId = input && "taskId" in input ? input.taskId : null;
      const file = taskId ? join(f.root, "context/scheduled-tasks/definitions", `${taskId}.md`) : null;
      if (operation === "quarantine") {
        mkdirSync(join(f.root, "context/scheduled-tasks/definitions"), { recursive: true });
        writeFileSync(file!, "An unapproved definition occupies this path.\n");
      }
      if (operation === "reopen" || operation === "adopt")
        f.db.query("UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'restore_pending' WHERE id = ?").run(taskId);
      if (operation === "adopt") {
        f.db.query("UPDATE schedule_root SET root_path = ? WHERE id = 1").run(join(f.root, "old"));
        f.db.query("INSERT INTO inbox_recovery_state (id, status, brain_root, snapshot_checksum, restored_at) VALUES (1, 'ready', ?, 'odysseus', ?)").run(f.root, f.clock.now);
      }
      if (operation === "reconcile") writeFileSync(file!, "Drifted definition.\n");
      const sites = await watchWriteSites(f.db, f.writer, TABLES);
      if (operation === "propose") {
        const proposal = await f.propose();
        expect(f.db.query("SELECT id FROM schedule_proposals WHERE id = ?").get(proposal.id), "SCHEDULE_PROPOSAL_COMMITTED").not.toBeNull();
      } else if (operation === "approve") {
        const proposal = (input as { proposal: Awaited<ReturnType<typeof f.propose>> }).proposal;
        const { approvalId } = await f.service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
        expect(f.db.query("SELECT id FROM schedule_approvals WHERE id = ?").get(approvalId), "SCHEDULE_APPROVAL_COMMITTED").not.toBeNull();
      } else if (operation === "publish") {
        expect((await f.service.publish(f.owner, { proposalId: (input as { proposalId: string }).proposalId, approvalId: (input as { approvalId: string }).approvalId })).task.state, "SCHEDULE_PUBLICATION_COMMITTED").toBe("active");
        expect(readFileSync(file!, "utf8"), "SCHEDULE_APPROVED_FILE_PUBLISHED").toContain("Ithaca");
      } else if (operation === "cancel") {
        expect((await f.service.cancel(f.owner, taskId!, { key: "cancel" })).task, "SCHEDULE_CANCEL_AND_RETIRE_COMMITTED")
          .toMatchObject({ state: "cancelled", compensationPending: false });
        expect(existsSync(file!), "SCHEDULE_FILE_RETIRED").toBe(false);
      } else if (operation === "reopen" || operation === "adopt") {
        expect((await f.service.reopen(f.owner, taskId!, { key: "reopen", decision: "reopen" })).task.state, "SCHEDULE_REOPEN_COMMITTED").toBe("active");
      } else if (operation === "quarantine") {
        let failure: unknown;
        try { await f.service.publish(f.owner, { proposalId: (input as { proposalId: string }).proposalId, approvalId: (input as { approvalId: string }).approvalId }); } catch (error) { failure = error; }
        expect(failure, "SCHEDULE_FILE_CONFLICT_CLASS_KEPT").toBeInstanceOf(ScheduleError);
        expect(failure, "SCHEDULE_FILE_CONFLICT_CODE_KEPT").toMatchObject({ code: "definition_conflict", status: 409 });
        expect(f.db.query("SELECT publication FROM schedule_tasks WHERE id = ?").get(taskId), "SCHEDULE_QUARANTINE_COMMITTED")
          .toEqual({ publication: "quarantined" });
      } else {
        await f.service.reconcile();
        expect(f.db.query("SELECT state FROM schedule_tasks WHERE id = ?").get(taskId), "SCHEDULE_DRIFT_PAUSE_COMMITTED").toEqual({ state: "paused" });
      }
      expect((await sites.log()).length, `SCHEDULE_${operation.toUpperCase()}_WRITES_ON_WORKER`).toBeGreaterThan(0);
    } finally { await f.close(); }
  });
}

test("schedule publication observes Git between the pending receipt and activation, and replay sees committed writes", async () => {
  const f = await fixture();
  try {
    const input = await f.approved();
    const observed: string[] = [];
    const service = createScheduleService(f.db, { brainRoot: f.root, now: () => f.clock.now, executionPolicy: () => POLICY,
      gitIgnored: () => {
        const row = f.db.query("SELECT publication FROM schedule_tasks WHERE id = ?").get(input.taskId) as { publication: string } | null;
        observed.push(row?.publication ?? "absent");
        return false;
      } }, f.writer);
    await service.ready;
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    const result = await service.publish(f.owner, { proposalId: input.proposalId, approvalId: input.approvalId });
    expect(observed, "SCHEDULE_GIT_CHECK_BETWEEN_COMMITS").toEqual(["absent", "absent", "pending", "pending"]);
    expect(result.task.state).toBe("active");
    expect((await service.publish(f.owner, { proposalId: input.proposalId, approvalId: input.approvalId })).created, "SCHEDULE_PUBLICATION_REPLAY_SEES_COMMIT").toBe(false);
    expect(await sites.log(), "SCHEDULE_APPROVAL_CONSUMPTION_AND_PUBLICATION_ORDER")
      .toEqual(["schedule_approvals", "schedule_tasks", "schedule_tasks"]);
  } finally { await f.close(); }
});

test("schedule worker refusals keep their class, code and status through the HTTP route", async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    const slow = held.call("slow", "Calypso", 150);
    // The policy callback runs before submission; expiry is checked inside the worker transaction.
    const service = createScheduleService(f.db, { brainRoot: f.root, now: () => f.clock.now,
      executionPolicy: () => { f.clock.now += 16 * 60_000; return POLICY; }, gitIgnored: () => false }, f.writer);
    await service.ready;
    const app = new Hono<AppEnv>().use("*", async (c, next) => { c.set("principal", f.owner); await next(); });
    app.route("/api", createScheduleRoutes(service));
    const response = await app.request(`/api/schedules/proposals/${proposal.id}/approve`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprint: proposal.fingerprint, decision: "approve" }) });
    expect(response.status, "SCHEDULE_WORKER_HTTP_REFUSAL_STATUS").toBe(409);
    expect(await response.json(), "SCHEDULE_WORKER_HTTP_REFUSAL_CLASS").toMatchObject({ error: { code: "approval_expired" } });
    await slow;
    expect(await sites.log(), "SCHEDULE_REFUSED_APPROVAL_ROLLED_BACK").toEqual([]);
  } finally { await f.close(); }
});

test("a schedule cancelled during publication retires the late file after its activation step commits", async () => {
  const f = await fixture();
  try {
    const input = await f.approved();
    let cancelled = false;
    const service = createScheduleService(f.db, { brainRoot: f.root, now: () => f.clock.now, executionPolicy: () => POLICY,
      gitIgnored: async () => {
        const row = f.db.query("SELECT publication FROM schedule_tasks WHERE id = ?").get(input.taskId) as { publication: string } | null;
        if (row?.publication === "pending" && !cancelled) {
          cancelled = true;
          await f.service.cancel(f.owner, input.taskId, { key: "cancel-during-publication" });
        }
        return false;
      } }, f.writer);
    await service.ready;
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    const result = await service.publish(f.owner, { proposalId: input.proposalId, approvalId: input.approvalId });
    expect(result.task, "SCHEDULE_LATE_PUBLICATION_RETIRED").toMatchObject({ state: "cancelled", compensationPending: false });
    expect(existsSync(join(f.root, "context/scheduled-tasks/definitions", `${input.taskId}.md`)), "SCHEDULE_LATE_ACTIVE_FILE_REMOVED").toBe(false);
    expect(await sites.log(), "SCHEDULE_CANCELLATION_PUBLICATION_RETIREMENT_ORDER").toEqual([
      "schedule_approvals", "schedule_tasks", "schedule_tasks", "schedule_cancel_receipts",
      "schedule_tasks", "schedule_tasks", "schedule_tasks",
    ]);
  } finally { await f.close(); }
});

test("schedule cancellation drops unstarted Queue work and its change records in the same worker transaction", async () => {
  const f = await fixture();
  try {
    const input = await f.created();
    const store = createInboxStore(f.db, { now: () => f.clock.now });
    store.ingest({ threadId: "ithaca-thread", itemId: "ithaca-item", dedupKey: "ithaca-key", stagingId: "ithaca-stage",
      source: "cli", stakes: 2, expiresAt: f.clock.now + 86_400_000 });
    f.db.query(`INSERT INTO schedule_occurrences (id, task_id, due_at, expires_at, state, operations_used, max_operations, created_at, updated_at)
      VALUES ('occ_ithaca', ?, ?, ?, 'queued', 0, 3, ?, ?)`)
      .run(input.taskId, f.clock.now, f.clock.now + 86_400_000, f.clock.now, f.clock.now);
    f.db.query("INSERT INTO schedule_occurrence_items (occurrence_id, item_id, sequence, created_at) VALUES ('occ_ithaca', 'ithaca-item', 1, ?)").run(f.clock.now);
    const sites = await watchWriteSites(f.db, f.writer, [...TABLES, "inbox_threads"]);
    await f.service.cancel(f.owner, input.taskId, { key: "cancel-queue" });
    expect(store.getItem("ithaca-item")?.status, "SCHEDULE_QUEUE_DROP_COMMITTED").toBe("dropped");
    expect(f.db.query("SELECT state FROM schedule_occurrences WHERE id = 'occ_ithaca'").get(), "SCHEDULE_OCCURRENCE_CANCEL_COMMITTED")
      .toEqual({ state: "cancelled" });
    const log = await sites.log();
    expect(log, "SCHEDULE_QUEUE_CHANGE_RECORDS_ON_WORKER").toContain("inbox_changes");
    expect(log.indexOf("schedule_cancel_receipts"), "SCHEDULE_CANCELLATION_RECEIPT_AFTER_QUEUE_DROP").toBeGreaterThan(log.indexOf("inbox_items"));
  } finally { await f.close(); }
});
