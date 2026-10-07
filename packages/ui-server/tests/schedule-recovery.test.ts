import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUiDb } from "../src/db/client.js";
import { exportInboxSnapshot, restoreInboxSnapshot } from "../src/inbox/snapshot.js";
import { createScheduleService } from "../src/schedules/service.js";
import { atDefinition, cronDefinition, POLICY, scheduleFixture, type ScheduleFixture } from "./helpers/schedule-fixture.js";

let fixture: ScheduleFixture | undefined;
const temporary: string[] = [];
afterEach(() => {
  fixture?.close(); fixture = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function create(f: ScheduleFixture, key: string) {
  const service = f.service();
  const { proposal } = await service.propose(f.owner, { key, definition: cronDefinition() });
  const { approvalId } = await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  return (await service.publish(f.owner, { proposalId: proposal.id, approvalId })).task;
}

test("restore keeps every schedule relation but pauses enabled tasks until verified reconciliation", async () => {
  fixture = scheduleFixture();
  const active = await create(fixture, "restore-active");
  const cancelled = await create(fixture, "restore-cancelled");
  await fixture.service().cancel(fixture.owner, cancelled.id, { key: "restore-cancel" });
  // An outstanding occurrence whose worker is lost with the old installation.
  fixture.db.query(`INSERT INTO schedule_occurrences (id, task_id, due_at, expires_at, state, operations_used, max_operations, created_at, updated_at)
    VALUES ('occ_lost', ?, ?, ?, 'running', 1, 3, ?, ?)`).run(active.id, 1, 1 + 86_400_000, 1, 1);
  const at = Date.now();
  const snapshot = await exportInboxSnapshot(fixture.db, fixture.root, at);
  const target = mkdtempSync(join(tmpdir(), "brain-schedule-restore-"));
  temporary.push(target);
  const brain = join(target, "brain");
  mkdirSync(brain);
  // Content Git restore brings the definition files back alongside the image.
  cpSync(join(fixture.root, "context"), join(brain, "context"), { recursive: true });
  await restoreInboxSnapshot(snapshot, join(target, "ui.db"), brain, at);
  const restored = createUiDb(join(target, "ui.db"));
  try {
    expect(restored.query("SELECT id, state, blocked_reason FROM schedule_tasks ORDER BY state DESC").all()).toEqual([
      { id: active.id, state: "paused", blocked_reason: "restore_pending" },
      { id: cancelled.id, state: "cancelled", blocked_reason: null },
    ]);
    expect(restored.query("SELECT state FROM schedule_occurrences").get()).toEqual({ state: "unknown" });
    for (const table of ["schedule_proposals", "schedule_approvals", "schedule_cancel_receipts", "schedule_root"])
      expect(restored.query(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(fixture.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    // Matching restored bytes do not reopen dispatch: the task stays paused for the operator.
    const service = createScheduleService(restored, { brainRoot: brain, executionPolicy: () => POLICY, gitIgnored: () => false, now: () => at + 7 * 86_400_000 });
    await service.ready;
    const view = (await service.list(fixture.owner, { id: active.id })).tasks[0]!;
    expect(view).toMatchObject({ state: "paused", blockedReason: "restore_pending", executionAvailable: false });
    // Due stays visible but never admittable, and a different brain root is
    // not the approved root identity, so nothing new can be proposed there.
    const due = (await service.due(fixture.owner, {})).due;
    expect(due).toEqual([expect.objectContaining({ taskId: active.id, admittable: false, blockedReason: "restore_pending" })]);
    const proposal = service.propose(fixture.owner, { key: "after-restore", definition: cronDefinition() });
    await expect(proposal).rejects.toMatchObject({ code: "unsupported_capability" });
  } finally { restored.close(); }
});

test("export refuses a forged task whose snapshot does not match its approved proposal", async () => {
  fixture = scheduleFixture();
  const task = await create(fixture, "forge-base");
  const proposal = fixture.db.query("SELECT * FROM schedule_proposals WHERE task_id = ?").get(task.id) as { id: string; definition_json: string };
  const widened = JSON.parse(proposal.definition_json as string);
  widened.id = "task_forged";
  widened.scope.targets.push("notes/palace.md");
  fixture.db.query(`INSERT INTO schedule_proposals SELECT 'proposal_forged', 'task_forged', principal_id, 'forged-key', input_hash,
    definition_json, zone_source, execution_policy_json, root_identity, fingerprint, created_at, expires_at FROM schedule_proposals WHERE id = ?`).run(proposal.id);
  fixture.db.query(`INSERT INTO schedule_approvals (id, proposal_id, approver_principal_id, approver_kind, channel, fingerprint, nonce, approved_at, consumed_at)
    SELECT 'approval_forged', 'proposal_forged', approver_principal_id, approver_kind, channel, fingerprint, 'n', approved_at, approved_at FROM schedule_approvals WHERE proposal_id = ?`).run(proposal.id);
  fixture.db.query(`INSERT INTO schedule_tasks SELECT 'task_forged', 'proposal_forged', 'approval_forged', creator_principal_id, root_identity,
    ?, execution_policy_json, fingerprint, file_sha256, zone_source, created_at, state, blocked_reason, publication, retirement, cancelled_at,
    evaluated_through, updated_at FROM schedule_tasks WHERE id = ?`).run(JSON.stringify(widened), task.id);
  await expect(exportInboxSnapshot(fixture.db, fixture.root, Date.now())).rejects.toThrow("inbox_snapshot_relations");
});

test("only verified operator reconciliation reopens restored tasks, against the approved bytes, never replaying unknown work", async () => {
  fixture = scheduleFixture();
  const f = fixture;
  const cron = await create(f, "reopen-cron");
  const service = f.service();
  const once = await (async () => {
    const { proposal } = await service.propose(f.owner, { key: "reopen-once", definition: atDefinition("2026-07-13T09:00:00+03:00") });
    const { approvalId } = await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
    return (await service.publish(f.owner, { proposalId: proposal.id, approvalId })).task;
  })();
  const delegated = await (async () => {
    const { proposal } = await service.propose(f.agent, { key: "reopen-agent", definition: cronDefinition("30 7 * * *") });
    await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
    return (await service.publish(f.agent, { proposalId: proposal.id })).task;
  })();
  // The one-off's worker is lost with the old installation.
  const due = Date.parse("2026-07-13T06:00:00Z");
  f.db.query(`INSERT INTO schedule_occurrences (id, task_id, due_at, expires_at, state, operations_used, max_operations, created_at, updated_at)
    VALUES ('occ_lost_once', ?, ?, ?, 'running', 1, 3, ?, ?)`).run(once.id, due, due + 86_400_000, due, due);
  const at = Date.now();
  // The recurring task was busy with an occurrence when the image was taken.
  f.db.query(`INSERT INTO schedule_occurrences (id, task_id, due_at, expires_at, state, operations_used, max_operations, created_at, updated_at)
    VALUES ('occ_busy_cron', ?, ?, ?, 'running', 1, 3, ?, ?)`).run(cron.id, at - 7_200_000, at - 7_200_000 + 86_400_000, at, at);
  const snapshot = await exportInboxSnapshot(f.db, f.root, at);
  const target = mkdtempSync(join(tmpdir(), "brain-schedule-reopen-"));
  temporary.push(target);
  const brain = join(target, "brain");
  mkdirSync(brain);
  cpSync(join(f.root, "context"), join(brain, "context"), { recursive: true });
  await restoreInboxSnapshot(snapshot, join(target, "ui.db"), brain, at);
  const restored = createUiDb(join(target, "ui.db"));
  try {
    const s = createScheduleService(restored, { brainRoot: brain, executionPolicy: () => POLICY, gitIgnored: () => false });
    await s.ready;
    // A service still pointed at the original directory, started before reconciliation.
    const stale = createScheduleService(restored, { brainRoot: f.root, executionPolicy: () => POLICY, gitIgnored: () => false });
    await stale.ready;
    const state = async (id: string) => (await s.list(f.owner, { id })).tasks[0]!;
    const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code ?? String(error));
    // Instants that arrived while that occurrence was outstanding stay consumed
    // through the restore, so reopening cannot replay one.
    expect(restored.query("SELECT evaluated_through FROM schedule_tasks WHERE id = ?").get(cron.id)).toEqual({ evaluated_through: at });
    // A delegated creator sees its task but cannot state the uncertainty was investigated.
    expect(await code(s.reopen(f.agent, delegated.id, { key: "agent", decision: "reopen" }))).toBe("unauthorized");
    expect(await code(s.reopen(f.owner, cron.id, { key: "bad", decision: "approve" }))).toBe("invalid_request");

    // The restored file must still be the approved bytes.
    const file = join(brain, "context/scheduled-tasks/definitions", `${cron.id}.md`);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.toString("utf8").replace("Ithaca", "Sparta"));
    expect(await code(s.reopen(f.owner, cron.id, { key: "drifted", decision: "reopen" }))).toBe("definition_conflict");
    expect(await state(cron.id)).toMatchObject({ state: "paused" });
    writeFileSync(file, bytes);

    const reopened = await s.reopen(f.owner, cron.id, { key: "reopen-cron", decision: "reopen" });
    expect(reopened).toMatchObject({ ok: true, changed: true, task: { id: cron.id, state: "active", blockedReason: "dispatch_disabled" } });
    // Receipts: a matched replay changes nothing; the key cannot move to another task.
    expect(await s.reopen(f.owner, cron.id, { key: "reopen-cron", decision: "reopen" })).toMatchObject({ changed: false, task: { state: "active" } });
    expect(await code(s.reopen(f.owner, delegated.id, { key: "reopen-cron", decision: "reopen" }))).toBe("key_conflict");
    // Reopening an already reconciled task with a new key is an honest no-op.
    expect(await s.reopen(f.owner, cron.id, { key: "again", decision: "reopen" })).toMatchObject({ changed: false });

    // The one-off's unknown occurrence keeps its outcome and its due instant
    // stays consumed: it has nothing left to run, so it ends expired.
    expect(await s.reopen(f.owner, once.id, { key: "reopen-once", decision: "reopen" }))
      .toMatchObject({ changed: true, task: { state: "expired", nextDueAt: null, lastOccurrence: { id: "occ_lost_once", state: "unknown" } } });
    expect((await s.due(f.owner, {})).due.map((c) => c.taskId)).not.toContain(once.id);
    expect(await state(delegated.id)).toMatchObject({ state: "paused", blockedReason: "restore_pending" });
    expect(restored.query("SELECT principal_id, task_id, approver_kind, resolved_reason, changed FROM schedule_reconciliations ORDER BY created_at, task_id").all())
      .toEqual(expect.arrayContaining([
        { principal_id: f.owner.id, task_id: cron.id, approver_kind: "owner", resolved_reason: "restore_pending", changed: 1 },
        { principal_id: f.owner.id, task_id: cron.id, approver_kind: "owner", resolved_reason: null, changed: 0 },
      ]));
    // The restore named this brain directory, so the ledger now serves it.
    const { status } = await s.propose(f.owner, { key: "after-reopen", definition: cronDefinition() });
    expect(status).toBe(201);
    // ...and no longer the old one, even for a service that cached the old answer.
    expect(await code(stale.propose(f.owner, { key: "stale-root", definition: cronDefinition() }))).toBe("unsupported_capability");
    // A no-op reconciliation records its receipt even when the host has no policy.
    const unpoliced = createScheduleService(restored, { brainRoot: brain, executionPolicy: () => null, gitIgnored: () => false });
    expect(await unpoliced.reopen(f.owner, cron.id, { key: "no-policy", decision: "reopen" })).toMatchObject({ changed: false });
  } finally { restored.close(); }
});
