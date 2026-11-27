// The schedule writer's own approver checks (#4757), at publication and at
// reopening. The service refuses a delegated agent's approval before it
// records one, the schema admits only an `owner` or `ambient` approver kind and
// approvals are immutable, so only a hand-written approval row or a changed
// approving principal reaches these checks.
import { afterEach, expect, test } from "bun:test";

import { cronDefinition, scheduleFixture, type ScheduleFixture } from "./helpers/schedule-fixture.js";

let fixture: ScheduleFixture | undefined;
afterEach(() => { fixture?.close(); fixture = undefined; });

const UNUSABLE_APPROVER = { code: "unauthorized", message: "The approving operator is no longer usable." };

/** An approval row for `proposalId` naming `approverId` as an `owner` approver, written past the service. */
function forgeApproval(f: ScheduleFixture, id: string, proposalId: string, approverId: string): void {
  f.db.query(`INSERT INTO schedule_approvals (id, proposal_id, approver_principal_id, approver_kind, channel, fingerprint, nonce, approved_at, consumed_at)
    SELECT ?, id, ?, 'owner', 'http', fingerprint, 'n', ?, NULL FROM schedule_proposals WHERE id = ?`)
    .run(id, approverId, f.clock.now, proposalId);
}

/** A principal of kind `owner` that authenticated by delegation: the server never writes one, the schema allows it. */
function delegatedOwner(f: ScheduleFixture): string {
  const id = "owner_by_delegation";
  f.db.query(`INSERT INTO principals (id, kind, auth_method, label, credential_id, created_by, created_at, expires_at, last_seen_at, revoked_at)
    VALUES (?, 'owner', 'delegated', 'Eurymachus', NULL, ?, ?, ?, NULL, NULL)`).run(id, f.owner.id, f.clock.now, f.clock.now + 86_400_000);
  return id;
}

async function propose(f: ScheduleFixture, key: string) {
  return (await f.service().propose(f.agent, { key, definition: cronDefinition() })).proposal;
}

test("publication refuses an approval that names a delegated agent", async () => {
  const f = fixture = scheduleFixture();
  const proposal = await propose(f, "agent-approval");
  forgeApproval(f, "approval_by_agent", proposal.id, f.agent.id);
  await expect(f.service().publish(f.agent, { proposalId: proposal.id, approvalId: "approval_by_agent" })).rejects.toMatchObject(UNUSABLE_APPROVER);
  expect(f.db.query("SELECT COUNT(*) AS n FROM schedule_tasks WHERE proposal_id = ?").get(proposal.id)).toEqual({ n: 0 });
});

test("publication refuses an approval by an owner-kind principal that authenticated by delegation", async () => {
  const f = fixture = scheduleFixture();
  const proposal = await propose(f, "delegated-owner-approval");
  forgeApproval(f, "approval_by_delegated_owner", proposal.id, delegatedOwner(f));
  await expect(f.service().publish(f.agent, { proposalId: proposal.id, approvalId: "approval_by_delegated_owner" })).rejects.toMatchObject(UNUSABLE_APPROVER);
  expect(f.db.query("SELECT COUNT(*) AS n FROM schedule_tasks WHERE proposal_id = ?").get(proposal.id)).toEqual({ n: 0 });
});

test("reopening refuses a task whose approving owner now authenticates by delegation", async () => {
  const f = fixture = scheduleFixture();
  const service = f.service();
  const proposal = await propose(f, "reopen-delegated-owner");
  const { approvalId } = await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const { task } = await service.publish(f.agent, { proposalId: proposal.id, approvalId });
  // A second owner reconciles; the approving one keeps its kind but no longer its auth method.
  f.db.query("UPDATE principals SET auth_method = 'delegated' WHERE id = ?").run(f.owner.id);
  f.db.query("UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'unknown_effect' WHERE id = ?").run(task.id);
  const reconciler = { ...f.owner, id: "reconciling_owner", authMethod: "password" as const };
  f.db.query(`INSERT INTO principals (id, kind, auth_method, label, credential_id, created_by, created_at, expires_at, last_seen_at, revoked_at)
    VALUES (?, 'owner', 'password', 'Penelope', NULL, NULL, ?, ?, NULL, NULL)`).run(reconciler.id, f.clock.now, f.clock.now + 86_400_000);
  await expect(service.reopen(reconciler, task.id, { key: "reopen-delegated-owner", decision: "reopen" }))
    .rejects.toMatchObject({ code: "unauthorized", message: "The schedule's creator or approving operator is no longer usable." });
  expect(f.db.query("SELECT state, blocked_reason FROM schedule_tasks WHERE id = ?").get(task.id)).toEqual({ state: "paused", blocked_reason: "unknown_effect" });
});
