import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { parseDefinitionFile } from "../src/schedules/definition.js";
import { ScheduleError } from "../src/schedules/service.js";
import { atDefinition, cronDefinition, POLICY, PROMPT, SCOPE, scheduleFixture, type ScheduleFixture } from "./helpers/schedule-fixture.js";

let fixture: ScheduleFixture | undefined;
afterEach(() => { fixture?.close(); fixture = undefined; });

const HOUR = 3_600_000;

async function code(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try { await (typeof promise === "function" ? promise() : promise); }
  catch (error) { if (error instanceof ScheduleError) return error.code; throw error; }
  return "ok";
}

async function create(f: ScheduleFixture, key: string, definition: unknown, service = f.service()) {
  const { proposal } = await service.propose(f.owner, { key, definition });
  const { approvalId } = await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  return { proposal, approvalId, result: await service.publish(f.owner, { proposalId: proposal.id, approvalId }), service };
}

test("creation publishes the approved Markdown definition and the host record agrees with it", async () => {
  fixture = scheduleFixture();
  const { result, proposal } = await create(fixture, "ithaca-review-01", cronDefinition());
  expect(result.status).toBe(201);
  expect(result.created).toBe(true);
  const task = result.task;
  expect(task).toMatchObject({
    id: proposal.taskId, state: "active", zoneSource: "explicit", creatorPrincipalId: fixture.owner.id,
    executionAvailable: false, blockedReason: "dispatch_disabled", lastOccurrence: null, compensationPending: false,
    // 07:00 Athens on Monday 2026-07-13 is 04:00Z.
    nextDueAt: "2026-07-13T04:00:00.000Z",
  });
  expect(task.definition).toEqual({ prompt: PROMPT, scope: SCOPE, notifyOnSuccess: false,
    when: { kind: "cron", cron: "0 7 * * 1-5", timeZone: "Europe/Athens", endAt: null },
    limits: { attemptTimeoutMs: 600000, maxOperations: 3 } });
  const file = join(fixture.root, "context/scheduled-tasks/definitions", `${task.id}.md`);
  const stored = parseDefinitionFile(readFileSync(file, "utf8"));
  expect(stored).toEqual({ schedule_schema: 1, id: task.id, ...task.definition });
  // The file holds definition data only: no creator, approval or control state.
  expect(readFileSync(file, "utf8")).not.toContain(fixture.owner.id);
  expect(readFileSync(file, "utf8")).not.toContain("approval");
  const listed = await fixture.service().list(fixture.owner, {});
  expect(listed).toEqual({ ok: true, tasks: [task], nextCursor: null });
});

test("a delegated agent can propose but never approve, and the operator's approval lets it publish", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { proposal } = await service.propose(fixture.agent, { key: "agent-01", definition: cronDefinition() });
  expect(await code(service.approve(fixture.agent, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" }))).toBe("unauthorized");
  expect(await code(service.publish(fixture.agent, { proposalId: proposal.id }))).toBe("approval_required");
  // A copied fingerprint for another proposal is not an approval of this one.
  expect(await code(service.approve(fixture.owner, proposal.id, { fingerprint: "0".repeat(64), decision: "approve" }))).toBe("definition_conflict");
  expect(await code(service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approved" }))).toBe("invalid_request");
  await service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  // The creator publishes; the operator who approved cannot publish on its behalf.
  expect(await code(service.publish(fixture.owner, { proposalId: proposal.id }))).toBe("not_found");
  const published = await service.publish(fixture.agent, { proposalId: proposal.id });
  expect(published.created).toBe(true);
  expect(published.task.creatorPrincipalId).toBe(fixture.agent.id);
  const approval = fixture.db.query("SELECT approver_principal_id, approver_kind, channel, consumed_at FROM schedule_approvals").get();
  expect(approval).toEqual({ approver_principal_id: fixture.owner.id, approver_kind: "owner", channel: "http", consumed_at: fixture.clock.now });
  // The agent only sees its own tasks; the operator sees every task.
  expect((await service.list(fixture.agent, {})).tasks.map((t) => t.id)).toEqual([published.task.id]);
});

test("matched receipts replay before clock checks; changed payloads conflict; expired proposals need a new key", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const definition = atDefinition("2026-07-12T09:30:00+03:00");
  const first = await create(fixture, "oneoff-01", definition, service);
  expect(first.result.task.definition.when).toEqual({ kind: "at", at: "2026-07-12T06:30:00.000Z", timeZone: "Europe/Athens" });
  fixture.clock.now += 2 * HOUR; // The appointment is now in the past.
  const replayed = await service.propose(fixture.owner, { key: "oneoff-01", definition });
  expect(replayed.status).toBe(200);
  expect(replayed.proposal).toEqual({ ...first.proposal, approvalState: "approved" });
  const republished = await service.publish(fixture.owner, { proposalId: first.proposal.id, approvalId: first.approvalId });
  expect(republished).toMatchObject({ status: 200, created: false, task: { id: first.result.task.id } });
  expect(await code(service.propose(fixture.owner, { key: "oneoff-01", definition: atDefinition("2026-07-13T09:00:00+03:00") }))).toBe("key_conflict");
  // A new key with a past first-create instant is refused before any write.
  expect(await code(service.propose(fixture.owner, { key: "oneoff-02", definition }))).toBe("invalid_request");
  const pending = await service.propose(fixture.owner, { key: "late-01", definition: cronDefinition() });
  fixture.clock.now += 16 * 60_000;
  expect(await code(service.propose(fixture.owner, { key: "late-01", definition: cronDefinition() }))).toBe("approval_expired");
  expect(await code(service.approve(fixture.owner, pending.proposal.id, { fingerprint: pending.proposal.fingerprint, decision: "approve" }))).toBe("approval_expired");
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM schedule_tasks").get()).toEqual({ n: 1 });
});

test("zones resolve explicit, then client, then disclosed UTC; invalid zones, instants and cron fail before writes", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const base = { prompt: PROMPT, scope: SCOPE };
  const client = await service.propose(fixture.owner, { key: "zone-client", clientTimeZone: "Asia/Tokyo", definition: { ...base, when: { kind: "cron", cron: "0 9 * * *" } } });
  expect(client.proposal).toMatchObject({ zoneSource: "client", definition: { when: { timeZone: "Asia/Tokyo" } } });
  const utc = await service.propose(fixture.owner, { key: "zone-utc", definition: { ...base, when: { kind: "cron", cron: "0 9 * * *" } } });
  expect(utc.proposal).toMatchObject({ zoneSource: "utc_fallback", definition: { when: { timeZone: "UTC" } } });
  for (const [key, definition, extra] of [
    ["bad-zone", { ...base, when: { kind: "cron", cron: "0 9 * * *", timeZone: "Atlantis/Ogygia" } }, {}],
    ["bad-client", { ...base, when: { kind: "cron", cron: "0 9 * * *" } }, { clientTimeZone: "+03:00" }],
    ["no-offset", { ...base, when: { kind: "at", at: "2026-07-13T09:00:00" } }, {}],
    ["past", { ...base, when: { kind: "at", at: "2026-07-12T05:59:00Z" } }, {}],
    ["bad-cron", { ...base, when: { kind: "cron", cron: "0 9 30 2 *" } }, {}],
    ["end-past", { ...base, when: { kind: "cron", cron: "0 9 * * *", endAt: "2026-07-11T00:00:00Z" } }, {}],
    ["end-on-at", { ...base, when: { kind: "at", at: "2026-07-13T09:00:00Z", endAt: null } }, {}],
  ] as const) {
    expect({ key, code: await code(service.propose(fixture.owner, { key, definition, ...extra })) }).toEqual({ key, code: "invalid_request" });
  }
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM schedule_proposals").get()).toEqual({ n: 2 });
});

test("the host refuses unsupported, broader or authority-bearing scope", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const tool = SCOPE.tools[0]!;
  const cases: Record<string, unknown> = {
    unknownTool: { ...SCOPE, tools: [{ name: "Bash", inputs: { command: "ls" } }] },
    aliasTool: { ...SCOPE, tools: [{ name: "mcp__brain__brain_read", inputs: tool.inputs }] },
    untargetedPath: { ...SCOPE, tools: [{ name: "brain_read", inputs: { path: "notes/other.md" } }] },
    extraInput: { ...SCOPE, tools: [{ name: "brain_read", inputs: { path: "notes/ithaca.md", principal: "owner" } }] },
    escape: { ...SCOPE, targets: ["../outside.md"] },
    absolute: { ...SCOPE, targets: ["/etc/passwd"] },
    hidden: { ...SCOPE, targets: [".brain-ui/inbox/x"] },
    policy: { ...SCOPE, targets: ["context/policies/rules.md"] },
    schedules: { ...SCOPE, targets: ["context/scheduled-tasks/definitions/x.md"] },
    wildcard: { ...SCOPE, targets: ["notes/*.md"] },
    egress: { ...SCOPE, egress: ["https://example.org"] },
    variesPath: { ...SCOPE, variableInputs: [{ pointer: "/tools/0/inputs/path", bound: { kind: "string", maxBytes: 64 } }] },
    missingLeaf: { ...SCOPE, variableInputs: [{ pointer: "/tools/0/inputs/section", bound: { kind: "string", maxBytes: 64 } }] },
    extraScopeField: { ...SCOPE, approvalId: "approval_x" },
  };
  for (const [name, scope] of Object.entries(cases)) {
    expect({ name, code: await code(service.propose(fixture.owner, { key: `scope-${name}`, definition: { prompt: PROMPT, when: { kind: "cron", cron: "0 9 * * *" }, scope } })) })
      .toEqual({ name, code: "invalid_request" });
  }
  const varying = await service.propose(fixture.owner, { key: "scope-varying", definition: { prompt: PROMPT, when: { kind: "cron", cron: "0 9 * * *" },
    scope: { ...SCOPE, tools: [{ name: "brain_read", inputs: { path: "notes/ithaca.md", section: "Harbor" } }],
      variableInputs: [{ pointer: "/tools/0/inputs/section", bound: { kind: "enum", values: ["Harbor", "Palace"] } }] } } });
  expect(varying.status).toBe(201);
  symlinkSync(join(fixture.root, "notes"), join(fixture.root, "linked"));
  expect(await code(service.propose(fixture.owner, { key: "symlinked-target", definition: { prompt: PROMPT, when: { kind: "cron", cron: "0 9 * * *" },
    scope: { ...SCOPE, targets: ["linked/ithaca.md"], tools: [{ name: "brain_read", inputs: { path: "linked/ithaca.md" } }] } } }))).toBe("invalid_request");
  expect(await code(service.propose(fixture.owner, { key: "authority", definition: { ...cronDefinition(), creatorPrincipalId: "x" } }))).toBe("invalid_request");
  expect(await code(service.propose(fixture.owner, { key: "limits", definition: { ...cronDefinition(), limits: { attemptTimeoutMs: 600001, maxOperations: 3 } } }))).toBe("invalid_request");
  expect(await code(service.propose(fixture.owner, { key: "ops", definition: { ...cronDefinition(), limits: { attemptTimeoutMs: 1000, maxOperations: 4 } } }))).toBe("invalid_request");
});

test("without a reviewable host execution policy, or when Git ignores definitions, proposals are refused", async () => {
  fixture = scheduleFixture();
  expect(await code(fixture.service({ executionPolicy: () => null }).propose(fixture.owner, { key: "p", definition: cronDefinition() }))).toBe("unsupported_capability");
  expect(await code(fixture.service({ gitIgnored: () => true }).propose(fixture.owner, { key: "g", definition: cronDefinition() }))).toBe("unsupported_capability");
  // A policy change between proposal and approval invalidates the review.
  const service = fixture.service();
  const { proposal } = await service.propose(fixture.owner, { key: "p2", definition: cronDefinition() });
  const changed = fixture.service({ executionPolicy: () => ({ ...POLICY, inferenceOrigins: ["https://other.example"] }) });
  expect(await code(changed.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" }))).toBe("definition_conflict");
});

test("revoked creators and approvers cannot publish, and a revoked creator's task reports unusable authority", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  // An agent's published task loses its authority when the agent is revoked.
  const first = await service.propose(fixture.agent, { key: "agent-task", definition: cronDefinition() });
  await service.approve(fixture.owner, first.proposal.id, { fingerprint: first.proposal.fingerprint, decision: "approve" });
  const published = await service.publish(fixture.agent, { proposalId: first.proposal.id });
  expect(published.task.blockedReason).toBe("dispatch_disabled");
  const pending = await service.propose(fixture.agent, { key: "agent-pending", definition: cronDefinition() });
  await service.approve(fixture.owner, pending.proposal.id, { fingerprint: pending.proposal.fingerprint, decision: "approve" });
  revokePrincipal(fixture.db, fixture.agent.id, Date.now());
  expect(await code(service.publish(fixture.agent, { proposalId: pending.proposal.id }))).toBe("unauthorized");
  const view = (await service.list(fixture.owner, { id: published.task.id })).tasks[0]!;
  expect(view).toMatchObject({ state: "active", executionAvailable: false, blockedReason: "authority_unusable" });
  // An approval whose operator was revoked before publication cannot be used.
  const other = createPrincipal(fixture.db, { authMethod: "password", label: "Eurycleia", ttlSeconds: 3600 * 24 * 365 });
  const owned = await service.propose(fixture.owner, { key: "owner-pending", definition: cronDefinition() });
  await service.approve(other, owned.proposal.id, { fingerprint: owned.proposal.fingerprint, decision: "approve" });
  revokePrincipal(fixture.db, other.id, Date.now());
  expect(await code(service.publish(fixture.owner, { proposalId: owned.proposal.id }))).toBe("unauthorized");
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM schedule_tasks").get()).toEqual({ n: 1 });
});

test("cancel is idempotent, retires the definition, keeps the tombstone listed and removes the task from due", async () => {
  fixture = scheduleFixture(Date.parse("2026-07-13T03:59:00Z"));
  const service = fixture.service();
  const { result } = await create(fixture, "cancel-01", cronDefinition());
  const id = result.task.id;
  fixture.clock.now = Date.parse("2026-07-13T04:00:30Z");
  const due = await service.due(fixture.owner, {});
  expect(due.due).toEqual([{ taskId: id, occurrenceId: expect.stringMatching(/^occ_/), dueAt: "2026-07-13T04:00:00.000Z",
    expiresAt: "2026-07-14T04:00:00.000Z", admittable: false, blockedReason: "dispatch_disabled" }]);
  const cancelled = await service.cancel(fixture.owner, id, { key: "cancel-key-01" });
  expect(cancelled).toMatchObject({ ok: true, changed: true, runningOccurrences: [],
    task: { id, state: "cancelled", nextDueAt: null, blockedReason: null, compensationPending: false } });
  expect(existsSync(join(fixture.root, "context/scheduled-tasks/definitions", `${id}.md`))).toBe(false);
  expect(existsSync(join(fixture.root, "context/scheduled-tasks/retired", `${id}.md`))).toBe(true);
  const again = await service.cancel(fixture.owner, id, { key: "cancel-key-01" });
  expect(again).toEqual({ ...cancelled, changed: false });
  expect((await service.cancel(fixture.owner, id, { key: "cancel-key-02" })).changed).toBe(false);
  const other = await create(fixture, "cancel-02", atDefinition("2026-07-20T09:00:00Z"));
  expect(await code(service.cancel(fixture.owner, other.result.task.id, { key: "cancel-key-01" }))).toBe("key_conflict");
  expect((await service.due(fixture.owner, {})).due).toEqual([]);
  const listed = await service.list(fixture.owner, { state: "cancelled" });
  expect(listed.tasks.map((t) => [t.id, t.state])).toEqual([[id, "cancelled"]]);
  // Re-creating the active file does not revive the cancelled ID.
  const retired = readFileSync(join(fixture.root, "context/scheduled-tasks/retired", `${id}.md`));
  writeFileSync(join(fixture.root, "context/scheduled-tasks/definitions", `${id}.md`), retired);
  await service.reconcile();
  expect((await service.list(fixture.owner, { id })).tasks[0]).toMatchObject({ state: "cancelled", nextDueAt: null });
  expect((await service.due(fixture.owner, {})).due).toEqual([]);
  // A delegated agent can neither see nor cancel the operator's task.
  expect(await code(service.cancel(fixture.agent, other.result.task.id, { key: "agent-cancel" }))).toBe("not_found");
});

test("with a fake clock, a one-off is due only once its time has passed and only within 24 hours", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { result } = await create(fixture, "oneoff-due", atDefinition("2026-07-12T10:00:00+03:00"));
  expect((await service.due(fixture.owner, {})).due).toEqual([]);
  fixture.clock.now = Date.parse("2026-07-12T06:59:59Z");
  expect((await service.due(fixture.owner, {})).due).toEqual([]);
  fixture.clock.now = Date.parse("2026-07-12T07:00:00Z");
  const due = await service.due(fixture.owner, {});
  expect(due).toMatchObject({ ok: true, evaluatedAt: "2026-07-12T07:00:00.000Z", nextCursor: null,
    due: [{ taskId: result.task.id, dueAt: "2026-07-12T07:00:00.000Z" }] });
  // Querying due is read-only: no occurrence, counter or cursor changes.
  const before = JSON.stringify(fixture.db.query("SELECT * FROM schedule_tasks").all());
  await service.due(fixture.owner, {});
  expect(JSON.stringify(fixture.db.query("SELECT * FROM schedule_tasks").all())).toBe(before);
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM schedule_occurrences").get()).toEqual({ n: 0 });
  fixture.clock.now = Date.parse("2026-07-13T07:00:00Z");
  expect((await service.due(fixture.owner, {})).due).toEqual([]);
});

test("a recurring task's due instant follows its own zone across a DST change and coalesces to the latest", async () => {
  fixture = scheduleFixture(Date.parse("2026-10-23T00:00:00Z"));
  const service = fixture.service();
  const { result } = await create(fixture, "athens-0330", cronDefinition("30 3 * * *"));
  // 03:30 in Athens (UTC+3 until the fall-back) is 00:30Z.
  expect(result.task.nextDueAt).toBe("2026-10-23T00:30:00.000Z");
  // Inside the repeated hour on 25 October: the fold ran once, at its earlier instant.
  fixture.clock.now = Date.parse("2026-10-25T01:45:00Z");
  expect((await service.due(fixture.owner, {})).due.map((d) => d.dueAt)).toEqual(["2026-10-25T00:30:00.000Z"]);
  expect((await service.list(fixture.owner, {})).tasks[0]!.nextDueAt).toBe("2026-10-26T01:30:00.000Z");
  // After two missed days only the latest instant within 24 hours is a candidate.
  fixture.clock.now = Date.parse("2026-10-27T02:00:00Z");
  expect((await service.due(fixture.owner, {})).due.map((d) => d.dueAt)).toEqual(["2026-10-27T01:30:00.000Z"]);
  // An approved recurrence end stops candidates at the boundary.
  const ending = await create(fixture, "ending", cronDefinition("0 * * * *", { endAt: "2026-10-27T04:00:00Z" }));
  fixture.clock.now = Date.parse("2026-10-27T03:30:00Z");
  expect((await service.due(fixture.owner, {})).due.map((d) => d.taskId)).toContain(ending.result.task.id);
  fixture.clock.now = Date.parse("2026-10-27T04:00:00Z");
  expect((await service.due(fixture.owner, {})).due.map((d) => d.taskId)).not.toContain(ending.result.task.id);
});

test("list and due pages are bounded, ordered and use host-signed cursors bound to their query", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await create(fixture, `page-${i}`, cronDefinition(`${i} * * * *`))).result.task.id);
    fixture.clock.now += 1;
  }
  const first = await service.list(fixture.owner, { limit: "2" });
  expect(first.tasks.map((t) => t.id)).toEqual(ids.slice(0, 2));
  const second = await service.list(fixture.owner, { limit: "2", cursor: first.nextCursor! });
  expect(second).toMatchObject({ nextCursor: null });
  expect(second.tasks.map((t) => t.id)).toEqual(ids.slice(2));
  expect(await code(service.list(fixture.agent, { limit: "2", cursor: first.nextCursor! }))).toBe("invalid_cursor");
  expect(await code(service.list(fixture.owner, { limit: "2", cursor: first.nextCursor!, state: "active" }))).toBe("invalid_cursor");
  expect(await code(service.list(fixture.owner, { cursor: `${first.nextCursor!.slice(0, -2)}xx` }))).toBe("invalid_cursor");
  expect(await code(service.due(fixture.owner, { cursor: first.nextCursor! }))).toBe("invalid_cursor");
  fixture.clock.now += 16 * 60_000;
  expect(await code(service.list(fixture.owner, { limit: "2", cursor: first.nextCursor! }))).toBe("invalid_cursor");
  for (const limit of ["0", "101", "1.5", "-1", "x"]) expect(await code(service.list(fixture.owner, { limit }))).toBe("invalid_request");
  expect(await code(service.list(fixture.owner, { offset: "2" }))).toBe("invalid_request");
  fixture.clock.now = Date.parse("2026-07-12T08:03:00Z");
  const due = await service.due(fixture.owner, { limit: "2" });
  expect(due.due.map((d) => d.taskId)).toEqual(ids.slice(0, 2));
  fixture.clock.now += 60_000; // The cursor keeps the original evaluation instant.
  const rest = await service.due(fixture.owner, { limit: "2", cursor: due.nextCursor! });
  expect(rest).toMatchObject({ evaluatedAt: due.evaluatedAt, nextCursor: null });
  expect(rest.due.map((d) => d.taskId)).toEqual(ids.slice(2));
});

test("interrupted publication fails closed, then reconciles to one published definition on retry or restart", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { proposal } = await service.propose(fixture.owner, { key: "interrupt", definition: cronDefinition() });
  const { approvalId } = await service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const definitions = join(fixture.root, "context/scheduled-tasks/definitions");
  mkdirSync(definitions, { recursive: true });
  chmodSync(definitions, 0o555);
  try {
    expect(await code(service.publish(fixture.owner, { proposalId: proposal.id, approvalId }))).toBe("server_unavailable");
    expect(fixture.db.query("SELECT state, publication FROM schedule_tasks").get()).toEqual({ state: "publishing", publication: "pending" });
    const listed = (await service.list(fixture.owner, {})).tasks[0]!;
    expect(listed).toMatchObject({ state: "publishing", executionAvailable: false, nextDueAt: null, compensationPending: true });
  } finally { chmodSync(definitions, 0o755); }
  // A restarted host reconciles the journal before serving anything.
  const restarted = fixture.service();
  await restarted.ready;
  expect(fixture.db.query("SELECT state, publication FROM schedule_tasks").get()).toEqual({ state: "active", publication: "published" });
  const replay = await restarted.publish(fixture.owner, { proposalId: proposal.id, approvalId });
  expect(replay).toMatchObject({ created: false, task: { state: "active", compensationPending: false } });
});

test("a different file at the definition path is never overwritten; publication quarantines instead", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { proposal } = await service.propose(fixture.owner, { key: "occupied", definition: cronDefinition() });
  const { approvalId } = await service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const definitions = join(fixture.root, "context/scheduled-tasks/definitions");
  mkdirSync(definitions, { recursive: true });
  const path = join(definitions, `${proposal.taskId}.md`);
  writeFileSync(path, "# Penelope's own note\n");
  expect(await code(service.publish(fixture.owner, { proposalId: proposal.id, approvalId }))).toBe("definition_conflict");
  expect(readFileSync(path, "utf8")).toBe("# Penelope's own note\n");
  const task = (await service.list(fixture.owner, {})).tasks[0]!;
  expect(task).toMatchObject({ state: "paused", blockedReason: "definition_drift", executionAvailable: false });
});

test("edited, missing or symlinked definitions quarantine dispatch without rewriting the file", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { result } = await create(fixture, "drift", cronDefinition());
  const path = join(fixture.root, "context/scheduled-tasks/definitions", `${result.task.id}.md`);
  const original = readFileSync(path, "utf8");
  // A widened but otherwise valid definition: an edit cannot grant authority.
  writeFileSync(path, original.replace('"targets":["notes/ithaca.md"]', '"targets":["notes/ithaca.md","notes/palace.md"]'));
  fixture.clock.now = Date.parse("2026-07-13T04:00:30Z");
  expect((await service.due(fixture.owner, {})).due[0]).toMatchObject({ admittable: false, blockedReason: "definition_drift" });
  await service.reconcile();
  expect((await service.list(fixture.owner, {})).tasks[0]).toMatchObject({ state: "paused", blockedReason: "definition_drift" });
  expect(readFileSync(path, "utf8")).not.toBe(original);
  // Restoring the exact bytes does not silently lift the persisted quarantine.
  writeFileSync(path, original);
  await service.reconcile();
  expect((await service.list(fixture.owner, {})).tasks[0]).toMatchObject({ state: "paused", blockedReason: "definition_drift" });
  // Missing file and symlinked directory are both drift for another task.
  const second = await create(fixture, "drift-2", cronDefinition());
  rmSync(join(fixture.root, "context/scheduled-tasks/definitions", `${second.result.task.id}.md`));
  expect((await service.list(fixture.owner, { id: second.result.task.id })).tasks[0]).toMatchObject({ blockedReason: "definition_drift" });
  const third = await create(fixture, "drift-3", cronDefinition());
  const tasks = join(fixture.root, "context/scheduled-tasks");
  renameSync(tasks, join(fixture.root, "moved"));
  symlinkSync(join(fixture.root, "moved"), tasks);
  expect((await service.list(fixture.owner, { id: third.result.task.id })).tasks[0]).toMatchObject({ blockedReason: "definition_drift" });
  expect(await code(create(fixture, "symlinked", cronDefinition()))).toBe("definition_conflict");
});

test("concurrent publication and cancellation keep one receipt and never leave an active cancelled file", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { proposal } = await service.propose(fixture.owner, { key: "race", definition: cronDefinition() });
  const { approvalId } = await service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const results = await Promise.all([1, 2, 3].map(() => fixture!.service().publish(fixture!.owner, { proposalId: proposal.id, approvalId })));
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(new Set(results.map((r) => r.task.id)).size).toBe(1);
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM schedule_tasks").get()).toEqual({ n: 1 });
  const id = results[0]!.task.id;
  const cancels = await Promise.all(["a", "b", "c"].map((key) => fixture!.service().cancel(fixture!.owner, id, { key: `race-${key}` })));
  expect(cancels.filter((c) => c.changed)).toHaveLength(1);
  expect(existsSync(join(fixture.root, "context/scheduled-tasks/definitions", `${id}.md`))).toBe(false);
  expect(existsSync(join(fixture.root, "context/scheduled-tasks/retired", `${id}.md`))).toBe(true);
});

test("the approved snapshot and cancellation are immutable in the database itself", async () => {
  fixture = scheduleFixture();
  const { result } = await create(fixture, "immutable", cronDefinition());
  expect(() => fixture!.db.query("UPDATE schedule_tasks SET definition_json = '{}' WHERE id = ?").run(result.task.id)).toThrow("immutable");
  expect(() => fixture!.db.query("UPDATE schedule_proposals SET fingerprint = ?").run("f".repeat(64))).toThrow("immutable");
  await fixture.service().cancel(fixture.owner, result.task.id, { key: "imm-cancel" });
  expect(() => fixture!.db.query("UPDATE schedule_tasks SET state = 'active', cancelled_at = NULL, retirement = 'none' WHERE id = ?").run(result.task.id)).toThrow("final");
});

test("a publisher that finishes after retirement completed retires its own late file", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { result, proposal, approvalId } = await create(fixture, "late-publisher", cronDefinition());
  const id = result.task.id;
  await service.cancel(fixture.owner, id, { key: "late-cancel" });
  // A delayed publisher's journal: the receipt is retired, yet its write is still due.
  fixture.db.query("UPDATE schedule_tasks SET publication = 'pending' WHERE id = ?").run(id);
  const replay = await service.publish(fixture.owner, { proposalId: proposal.id, approvalId });
  expect(replay.task).toMatchObject({ state: "cancelled", compensationPending: false });
  expect(existsSync(join(fixture.root, "context/scheduled-tasks/definitions", `${id}.md`))).toBe(false);
  expect(existsSync(join(fixture.root, "context/scheduled-tasks/retired", `${id}.md`))).toBe(true);
});

test("journal recovery never writes into a different brain root and keeps live temporaries", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const { proposal } = await service.propose(fixture.owner, { key: "fenced", definition: cronDefinition() });
  const { approvalId } = await service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const definitions = join(fixture.root, "context/scheduled-tasks/definitions");
  mkdirSync(definitions, { recursive: true });
  chmodSync(definitions, 0o555);
  try { expect(await code(service.publish(fixture.owner, { proposalId: proposal.id, approvalId }))).toBe("server_unavailable"); }
  finally { chmodSync(definitions, 0o755); }
  const foreign = join(fixture.root, "..", "foreign");
  mkdirSync(foreign);
  const moved = fixture.service({ brainRoot: foreign });
  await moved.ready;
  const replay = await moved.publish(fixture.owner, { proposalId: proposal.id, approvalId });
  expect(replay.task).toMatchObject({ state: "publishing", blockedReason: null, compensationPending: true });
  expect(existsSync(join(foreign, "context"))).toBe(false);
  // A young temporary belongs to a live writer; only a stale one is reaped.
  const young = join(definitions, `.${proposal.taskId}.md.00000000-0000-4000-8000-000000000001.tmp`);
  const stale = join(definitions, `.${proposal.taskId}.md.00000000-0000-4000-8000-000000000002.tmp`);
  writeFileSync(young, "partial");
  writeFileSync(stale, "partial");
  utimesSync(stale, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));
  fixture.clock.now = Date.now();
  await fixture.service().ready;
  expect(existsSync(young)).toBe(true);
  expect(existsSync(stale)).toBe(false);
});

test("Git exclusion is rechecked when an approved proposal is published", async () => {
  fixture = scheduleFixture();
  const { proposal } = await fixture.service().propose(fixture.owner, { key: "ignored-later", definition: cronDefinition() });
  await fixture.service().approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const ignoring = fixture.service({ gitIgnored: () => true });
  expect(await code(ignoring.publish(fixture.owner, { proposalId: proposal.id }))).toBe("unsupported_capability");
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM schedule_tasks").get()).toEqual({ n: 0 });
});

test("a list page, its cursor included, stays within the 512 KiB response bound", async () => {
  fixture = scheduleFixture();
  const service = fixture.service();
  const prompt = `${PROMPT} ${"Ithaca ".repeat(2300)}`.slice(0, 16_200);
  for (let i = 0; i < 34; i++) {
    const { proposal } = await service.propose(fixture.owner, { key: `big-${i}`, definition: { ...cronDefinition(), prompt } });
    const { approvalId } = await service.approve(fixture.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
    await service.publish(fixture.owner, { proposalId: proposal.id, approvalId });
    fixture.clock.now += 1;
  }
  const first = await service.list(fixture.owner, { limit: "100" });
  expect(first.tasks.length).toBeGreaterThan(0);
  expect(first.tasks.length).toBeLessThan(34);
  expect(first.nextCursor).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
  const second = await service.list(fixture.owner, { limit: "100", cursor: first.nextCursor! });
  expect(first.tasks.length + second.tasks.length).toBe(34);
  expect(second.nextCursor).toBeNull();
});
