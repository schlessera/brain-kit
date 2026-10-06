import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { isoInstant } from "../src/schedules/time.js";
import { atDefinition, cronDefinition, POLICY, scheduleFixture, type ScheduleFixture } from "./helpers/schedule-fixture.js";
import { manualTimers, scheduleRuntime, succeed, type Script } from "./helpers/schedule-runtime.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const worker = join(import.meta.dir, "fixtures/schedule-admission-worker.ts");

let fixture: ScheduleFixture | undefined;
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  fixture?.close(); fixture = undefined;
});

/** Real time, rounded to a minute: the budget lease is checked against the wall clock. */
function start(): ScheduleFixture {
  return scheduleFixture(Math.ceil(Date.now() / MINUTE) * MINUTE);
}

function harness(f: ScheduleFixture, script: Script, options: Parameters<typeof scheduleRuntime>[1] extends infer O ? Partial<O> : never = {}) {
  const h = scheduleRuntime(f.db, { root: f.root, clock: f.clock, script, ...options });
  closers.push(() => h.runtime.close());
  return h;
}

async function create(f: ScheduleFixture, key: string, definition: unknown) {
  const service = f.service({ dispatchAvailable: () => true });
  const { proposal } = await service.propose(f.owner, { key, definition });
  const { approvalId } = await service.approve(f.owner, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  return (await service.publish(f.owner, { proposalId: proposal.id, approvalId })).task;
}

function occurrences(f: ScheduleFixture) {
  return f.db.query("SELECT id, task_id, due_at, state, operations_used, max_operations, run_ids_json, result_state, result_text FROM schedule_occurrences ORDER BY due_at").all() as
    { id: string; task_id: string; due_at: number; state: string; operations_used: number; max_operations: number; run_ids_json: string; result_state: string; result_text: string | null }[];
}
function reservations(f: ScheduleFixture) {
  return f.db.query("SELECT item_id, status, runtime_acquired_at FROM inbox_budget_reservations ORDER BY started_at, id").all() as
    { item_id: string; status: string; runtime_acquired_at: number | null }[];
}

async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(file)).toBe(true);
}

function spawnWorker(f: ScheduleFixture, mode: string, name: string) {
  const ready = join(f.root, "..", name), gate = join(f.root, "..", `${name}.gate`);
  const child = Bun.spawn([process.execPath, worker, mode, f.dbPath, f.root, String(f.clock.now), ready, gate],
    { stdout: "pipe", stderr: "pipe" });
  closers.push(async () => { if (child.exitCode === null) child.kill(9); await child.exited; });
  return { child, ready, gate };
}

test("a one-off is admitted once by concurrent processes, runs once through the Queue and is never due again", async () => {
  const f = fixture = start();
  const at = f.clock.now + 5 * MINUTE;
  const task = await create(f, "ithaca-once", atDefinition(isoInstant(at)));
  const h = harness(f, succeed("Two checks remain at Ithaca."));
  // Not yet due: nothing is admitted and nothing runs.
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.service.due(f.owner, {})).due).toEqual([]);

  f.clock.now = at + MINUTE;
  const due = (await h.service.due(f.owner, {})).due;
  expect(due).toEqual([expect.objectContaining({ taskId: task.id, dueAt: isoInstant(at), admittable: true, blockedReason: null })]);
  // `due` stays read-only: reading it twice admitted nothing.
  expect(occurrences(f)).toEqual([]);

  // Two real processes race the admission boundary for the same instant.
  const a = spawnWorker(f, "admit", "admit-a"), b = spawnWorker(f, "admit", "admit-b");
  await Promise.all([waitFor(a.ready), waitFor(b.ready)]);
  writeFileSync(a.gate, "go"); writeFileSync(b.gate, "go");
  expect(await Promise.all([a.child.exited, b.child.exited])).toEqual([0, 0]);
  const admitted = (await Promise.all([new Response(a.child.stdout).text(), new Response(b.child.stdout).text()]))
    .flatMap((out) => JSON.parse(out) as string[]);
  expect(admitted).toEqual([due[0]!.occurrenceId]);
  // An in-process caller after them finds the occurrence already outstanding.
  expect(await h.admission.admit()).toEqual([]);
  expect(f.db.query("SELECT COUNT(*) AS n FROM schedule_occurrence_items").get()).toEqual({ n: 1 });

  expect(await h.runtime.tick()).toMatchObject({ claimed: 1, dispatchEnabled: true });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.prompt).toBe(atDefinition("").prompt);
  expect(h.calls[0]!.autonomous?.allowedTools).toEqual(["brain_read"]);
  expect(occurrences(f)).toEqual([expect.objectContaining({ id: due[0]!.occurrenceId, state: "completed",
    operations_used: 1, result_state: "available", result_text: "Two checks remain at Ithaca." })]);
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "settled" })]);

  const [listed] = (await h.service.list(f.owner, { id: task.id })).tasks;
  expect(listed).toMatchObject({ state: "completed", nextDueAt: null,
    lastOccurrence: { id: due[0]!.occurrenceId, state: "completed", operationsUsed: 1 } });
  // Ran once, and is never due or admitted again, however much time passes.
  for (const later of [at + 2 * MINUTE, at + 23 * HOUR, at + 3 * 24 * HOUR]) {
    f.clock.now = later;
    expect((await h.service.due(f.owner, {})).due).toEqual([]);
    expect(await h.admission.admit()).toEqual([]);
    expect((await h.runtime.tick()).claimed).toBe(0);
  }
  expect(h.calls).toHaveLength(1);
});

/** A backend that fails its turn (an error terminal) without any effect. */
const fail: Script = async (request) => {
  request.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "error", isError: true, durationMs: 1, numTurns: 1 });
};

test("Budget A: retry, yield and a continuation item share one three-operation counter that never resets", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-budget", atDefinition(isoInstant(at)));
  const scripts: Script[] = [
    fail,
    // A cooperative yield returns the same item to the Queue, attempt counted.
    async (request) => { request.autonomous!.onYield!("path:notes/ithaca.md"); },
  ];
  const h = harness(f, (request, n) => (scripts[n - 1] ?? fail)(request, n));
  f.clock.now = at;
  const [id] = await h.admission.admit();
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(occurrences(f)[0]).toMatchObject({ state: "retrying", operations_used: 1 });
  // The Queue's bounded backoff, not a reset, governs the next attempt.
  f.clock.now += 2 * MINUTE;
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(occurrences(f)[0]).toMatchObject({ state: "retrying", operations_used: 2 });
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "ready", attempts: 2, maxAttempts: 3 });

  // An approved-Action continuation is a new Queue item (#915 wires the
  // Action path). It inherits only what the occurrence has left.
  f.db.query("UPDATE inbox_items SET status = 'dropped' WHERE id = ?").run(`${id}-1`);
  f.db.query("UPDATE schedule_occurrences SET state = 'waiting_for_action' WHERE id = ?").run(id);
  const continuation = h.admission.continueOccurrence(id!);
  expect(continuation).toBe(`${id}-2`);
  expect(createInboxStore(f.db).getItem(continuation!)).toMatchObject({ status: "ready", attempts: 0, maxAttempts: 1 });
  f.clock.now += 2 * MINUTE;
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(3);
  // Three operations across two items: the occurrence is spent and fails.
  expect(occurrences(f)[0]).toMatchObject({ state: "failed", operations_used: 3, max_operations: 3 });
  expect(JSON.parse(occurrences(f)[0]!.run_ids_json)).toEqual([`${id}-1-1`, `${id}-1-2`, `${id}-2-1`]);
  expect(reservations(f).map((r) => r.item_id)).toEqual([`${id}-1`, `${id}-1`, `${id}-2`]);
  // No fourth operation: no item can be claimed and no continuation is possible.
  f.db.query("UPDATE schedule_occurrences SET state = 'waiting_for_action' WHERE id = ?").run(id);
  expect(h.admission.continueOccurrence(id!)).toBeNull();
  f.clock.now += 10 * MINUTE;
  expect((await h.runtime.tick()).claimed).toBe(0);
  expect(h.calls).toHaveLength(3);
  // The one-off ended without success and is not due again.
  expect((await h.service.list(f.owner, {})).tasks[0]).toMatchObject({ state: "failed", nextDueAt: null });
});

test("the host deadline aborts the backend, and the claim and reservation are held until it unwinds", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-deadline", cronDefinition("* * * * *"));
  const clock = manualTimers();
  let release!: () => void, aborted!: () => void;
  const unwound = new Promise<void>((resolve) => { release = resolve; });
  const sawAbort = new Promise<void>((resolve) => { aborted = resolve; });
  const h = harness(f, async (request) => {
    request.bridge.activity?.({ kind: "autonomous_identity", runtimeSessionId: "ephemeral", backendId: "fixture" });
    request.signal.addEventListener("abort", () => aborted(), { once: true });
    await unwound; // A slow backend: abort is requested, it has not returned yet.
    request.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  }, { timers: clock.timers });
  f.clock.now = at;
  const [id] = await h.admission.admit();
  const pass = h.runtime.tick();
  while (h.calls.length === 0) await Bun.sleep(1);
  const attempt = f.db.query("SELECT started_at, deadline_at, outcome FROM schedule_attempts").get();
  // The deadline is the approved 600000 ms, persisted with the attempt.
  expect(attempt).toEqual({ started_at: at, deadline_at: at + 600_000, outcome: null });
  expect(clock.pending.size).toBe(1);
  clock.fireAll();
  await sawAbort;
  expect(h.calls[0]!.signal.aborted).toBe(true);
  expect(occurrences(f)[0]).toMatchObject({ id, state: "unwinding" });
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "claimed" });
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "active" })]);
  // A cancellation now reports the attempt still unwinding; it does not stop it.
  const cancelled = await h.service.cancel(f.owner, occurrences(f)[0]!.task_id, { key: "deadline-cancel" });
  expect(cancelled.runningOccurrences).toEqual([expect.objectContaining({ id, state: "unwinding", operationsUsed: 1 })]);
  release();
  await pass;
  expect(f.db.query("SELECT outcome FROM schedule_attempts").get()).toEqual({ outcome: "timeout" });
  expect(occurrences(f)[0]).toMatchObject({ state: "cancelled", operations_used: 1 });
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "settled" })]);
});

/** Admit in this process, then let a second process claim the work and die. */
async function crash(f: ScheduleFixture, mode: string) {
  const w = spawnWorker(f, mode, mode);
  await waitFor(w.ready);
  writeFileSync(w.gate, "go");
  await w.child.exited;
  expect(w.child.signalCode).toBe("SIGKILL");
}

test("a crash after the claim, before any attempt started, retries with the claim still counted", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-claim-crash", atDefinition(isoInstant(at)));
  f.clock.now = at;
  const h = harness(f, succeed("Checked after a restart."));
  const [id] = await h.admission.admit();
  await crash(f, "crash-after-claim");
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "claimed", attempts: 1 });
  expect(f.db.query("SELECT COUNT(*) AS n FROM schedule_attempts").get()).toEqual({ n: 0 });
  // Inside the lease nothing is recovered: the worker could still be alive.
  expect((await h.runtime.tick()).claimed).toBe(0);
  f.clock.now += 11 * MINUTE;
  await h.runtime.tick(); // lease recovery returns the item with bounded backoff
  f.clock.now += 2 * MINUTE;
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(1);
  // The lost claim's reservation still counts as one of the three operations.
  expect(occurrences(f)[0]).toMatchObject({ state: "completed", operations_used: 2 });
});

test("a crash after the attempt started but before the backend acquired it is retried, never counted as free", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-start-crash", atDefinition(isoInstant(at)));
  f.clock.now = at;
  const h = harness(f, succeed("Checked on the second attempt."));
  const [id] = await h.admission.admit();
  await crash(f, "crash-after-start");
  expect(f.db.query("SELECT outcome FROM schedule_attempts").get()).toEqual({ outcome: null });
  expect(occurrences(f)[0]).toMatchObject({ id, state: "running", operations_used: 1 });
  expect(reservations(f)).toEqual([expect.objectContaining({ runtime_acquired_at: null })]);
  f.clock.now += 11 * MINUTE;
  expect(h.admission.recover()).toBe(1);
  expect(f.db.query("SELECT outcome FROM schedule_attempts").get()).toEqual({ outcome: "interrupted" });
  expect(occurrences(f)[0]).toMatchObject({ state: "retrying" });
  f.clock.now += 2 * MINUTE;
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(occurrences(f)[0]).toMatchObject({ state: "completed", operations_used: 2 });
});

test("a crash after a possible effect, before its receipt, is unknown: never replayed, task paused for the operator", async () => {
  const f = fixture = start();
  const first = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-effect-crash", cronDefinition("*/5 * * * *"));
  f.clock.now = Math.ceil(first / (5 * MINUTE)) * 5 * MINUTE;
  const h = harness(f, succeed("Checked after reconciliation."));
  const [id] = await h.admission.admit();
  await crash(f, "crash-after-effect");
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "active", runtime_acquired_at: expect.any(Number) })]);
  // Lease recovery alone would return the item to the Queue; admission's
  // recovery decides first that the outcome is unknown and drops it.
  f.clock.now += 11 * MINUTE;
  expect(h.admission.recover()).toBe(1);
  expect(f.db.query("SELECT outcome FROM schedule_attempts").get()).toEqual({ outcome: "unknown" });
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "unknown", operations_used: 1 })]);
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "released" })]);
  const [paused] = (await h.service.list(f.owner, { id: task.id })).tasks;
  expect(paused).toMatchObject({ state: "paused", blockedReason: "unknown_effect", executionAvailable: false,
    lastOccurrence: { id, state: "unknown" } });
  // Nothing replays it, and later instants stay blocked while it is paused.
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.runtime.tick()).claimed).toBe(0);
  expect(h.calls).toHaveLength(0);
  for (const candidate of (await h.service.due(f.owner, {})).due)
    expect(candidate).toMatchObject({ admittable: false, blockedReason: "unknown_effect" });

  // Only the operator can state the effect was investigated.
  await expect(h.service.reopen(f.agent, task.id, { key: "agent-reopen", decision: "reopen" })).rejects.toMatchObject({ code: "not_found" });
  const reopened = await h.service.reopen(f.owner, task.id, { key: "effect-reopen", decision: "reopen" });
  expect(reopened).toMatchObject({ ok: true, changed: true, task: { state: "active", blockedReason: null } });
  expect(await h.service.reopen(f.owner, task.id, { key: "effect-reopen", decision: "reopen" }))
    .toMatchObject({ changed: false, task: { state: "active" } });
  // Instants that passed while it was outstanding were busy and stay consumed.
  expect(await h.admission.admit()).toEqual([]);
  // The next fresh instant runs; the unknown one is history, not a backlog.
  f.clock.now += 5 * MINUTE;
  const [next] = await h.admission.admit();
  expect(next).toEqual(expect.stringMatching(/^occ_/));
  expect(next).not.toBe(id);
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(occurrences(f).map((o) => o.state)).toEqual(["unknown", "completed"]);
});

const limited = (at: number, maxOperations: number) =>
  ({ ...atDefinition(isoInstant(at)), limits: { attemptTimeoutMs: 600_000, maxOperations } });

test("a reclaim after a pre-acquisition crash keeps the occurrence's last allowed operation", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-last-retry", limited(at, 2));
  f.clock.now = at;
  const h = harness(f, succeed("Checked on the last allowed operation."));
  await h.admission.admit();
  await crash(f, "crash-after-start");
  // The Queue's own lease recovery returns the item; the next tick reclaims
  // it before admission has looked at the dead attempt.
  f.clock.now += 11 * MINUTE;
  await h.runtime.tick();
  f.clock.now += 2 * MINUTE;
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(occurrences(f)[0]).toMatchObject({ state: "completed", operations_used: 2, max_operations: 2 });
});

test("an occurrence whose claims were all lost before starting is failed, not left outstanding", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-lost-claims", limited(at, 1));
  f.clock.now = at;
  const h = harness(f, succeed("Should not run."));
  const [id] = await h.admission.admit();
  await crash(f, "crash-after-claim");
  f.clock.now += 11 * MINUTE;
  await h.runtime.tick(); // lease recovery: the only attempt is spent, the item dead-letters
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "failed", attempts: 1, maxAttempts: 1 });
  await h.admission.admit();
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "failed", operations_used: 0 })]);
  expect((await h.service.list(f.owner, { id: task.id })).tasks[0]).toMatchObject({ state: "failed" });
  expect(h.calls).toHaveLength(0);
});

test("instants that pass while an occurrence runs are busy even when it finishes between passes", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-busy", cronDefinition("* * * * *"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(f, async (request, n) => { await gate; await succeed("Slow minute.")(request, n); });
  f.clock.now = at;
  await h.admission.admit();
  const pass = h.runtime.tick();
  while (h.calls.length === 0) await Bun.sleep(1);
  f.clock.now = at + 2 * MINUTE + 1000; // two more instants arrive while it runs
  release();
  await pass;
  expect(occurrences(f)).toEqual([expect.objectContaining({ due_at: at, state: "completed" })]);
  expect(await h.admission.admit()).toEqual([]);
  f.clock.now = at + 3 * MINUTE;
  expect(await h.admission.admit()).toHaveLength(1);
  expect(occurrences(f).at(-1)).toMatchObject({ due_at: at + 3 * MINUTE });
});

test("cancel versus start: a cancellation that commits first leaves nothing to start", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-cancel-first", atDefinition(isoInstant(at)));
  f.clock.now = at;
  let cancelled: Awaited<ReturnType<ReturnType<ScheduleFixture["service"]>["cancel"]>> | undefined;
  const h = harness(f, succeed("Should not run."));
  const [id] = await h.admission.admit();
  // The cancellation lands after the claim and after the pre-start file and
  // authority check passed, just before the start transaction.
  const check = h.service.internal.refusal;
  h.service.internal.refusal = async (row) => {
    const refusal = await check(row);
    expect(refusal).toBeNull();
    cancelled = await f.service().cancel(f.owner, task.id, { key: "cancel-first" });
    return refusal;
  };
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(cancelled).toMatchObject({ changed: true, runningOccurrences: [] });
  expect(h.calls).toHaveLength(0);
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "cancelled", operations_used: 0 })]);
  expect(f.db.query("SELECT COUNT(*) AS n FROM schedule_attempts").get()).toEqual({ n: 0 });
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "released", runtime_acquired_at: null })]);
});

test("cancel versus start: a started attempt is reported running and finishes; cancel does not stop it", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-start-first", cronDefinition("* * * * *"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(f, async (request, n) => { await gate; await succeed("Finished despite cancel.")(request, n); });
  f.clock.now = at;
  const [id] = await h.admission.admit();
  const pass = h.runtime.tick();
  while (h.calls.length === 0) await Bun.sleep(1);
  const cancelled = await h.service.cancel(f.owner, task.id, { key: "cancel-later" });
  expect(cancelled).toMatchObject({ changed: true, task: { state: "cancelled" },
    runningOccurrences: [{ id, state: "running", operationsUsed: 1 }] });
  expect(h.calls[0]!.signal.aborted).toBe(false);
  release();
  await pass;
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "completed", result_text: "Finished despite cancel." })]);
  // No further instant is admitted for the cancelled task.
  f.clock.now += 5 * MINUTE;
  expect(await h.admission.admit()).toEqual([]);
});

test("cancel drops unclaimed work, so the Queue never claims it", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-cancel-ready", atDefinition(isoInstant(at)));
  f.clock.now = at;
  const h = harness(f, succeed("Should not run."));
  const [id] = await h.admission.admit();
  await h.service.cancel(f.owner, task.id, { key: "cancel-ready" });
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  expect((await h.runtime.tick()).claimed).toBe(0);
  expect(reservations(f)).toEqual([]);
});

test("Timing A: busy instants are skipped, one latest catch-up runs, and unstarted work expires at 24 hours", async () => {
  const f = fixture = start();
  const hour = Math.ceil((f.clock.now + MINUTE) / HOUR) * HOUR;
  await create(f, "ithaca-hourly", cronDefinition("0 * * * *"));
  const h = harness(f, succeed("Hourly check."));
  f.clock.now = hour;
  const [first] = await h.admission.admit();
  // Two more instants arrive while the first is outstanding: recorded busy.
  f.clock.now = hour + 2 * HOUR + 30 * MINUTE;
  expect(await h.admission.admit()).toEqual([]);
  await h.runtime.tick();
  expect(occurrences(f)).toEqual([expect.objectContaining({ id: first, due_at: hour, state: "completed" })]);
  // The busy instants are not replayed as a hidden backlog.
  f.clock.now += MINUTE;
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.service.due(f.owner, {})).due).toEqual([]);
  // A long outage: of every missed instant, only the latest fresh one is admitted...
  f.clock.now = hour + 9 * HOUR + 10 * MINUTE;
  const [latest] = await h.admission.admit();
  expect(occurrences(f).at(-1)).toMatchObject({ id: latest, due_at: hour + 9 * HOUR, state: "queued" });
  // ...and if it never starts, it expires 24 hours after its original due time.
  f.clock.now = hour + 33 * HOUR;
  await h.admission.admit();
  expect(occurrences(f).find((o) => o.id === latest)).toMatchObject({ state: "expired", operations_used: 0 });
  expect(createInboxStore(f.db).getItem(`${latest}-1`)).toMatchObject({ status: "dropped" });
  expect(occurrences(f).at(-1)).toMatchObject({ due_at: hour + 33 * HOUR, state: "queued" });
});

test("a one-off that was never admitted expires after its freshness window and never runs", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-missed", atDefinition(isoInstant(at)));
  const h = harness(f, succeed("Should not run."));
  f.clock.now = at + 24 * HOUR;
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.service.list(f.owner, { id: task.id })).tasks[0]).toMatchObject({ state: "expired", lastOccurrence: null });
});

test("revoked creator authority refuses admission and start instead of reporting an empty success", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-revoked", cronDefinition("* * * * *"));
  const h = harness(f, succeed("Should not run."), {
    afterClaim: () => { revokePrincipal(f.db, f.owner.id, f.clock.now); },
  });
  f.clock.now = at;
  const [id] = await h.admission.admit();
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(0);
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "failed", operations_used: 0 })]);
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  expect(reservations(f)).toEqual([expect.objectContaining({ status: "released" })]);
  const view = (await h.service.list(f.owner, { id: task.id }).catch((error) => error)) as { code?: string };
  expect(view.code).toBe("unauthorized");
});

test("a changed host execution policy refuses admission and start under the approved one", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  const task = await create(f, "ithaca-policy", cronDefinition("* * * * *"));
  let policy = POLICY;
  const h = harness(f, succeed("Should not run."), { policy: () => policy });
  f.clock.now = at;
  const [id] = await h.admission.admit();
  // The operator switches the host to another profile after approval.
  policy = { ...POLICY, profileId: "fixture-other" };
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(0);
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  // The refused occurrence is explicitly failed, not stranded as queued work.
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "failed", operations_used: 0 })]);
  f.clock.now += 2 * MINUTE;
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.service.list(f.owner, { id: task.id })).tasks[0]).toMatchObject({ executionAvailable: false, blockedReason: "backend_unavailable" });
  // Back on the approved policy, the next due instant runs.
  policy = POLICY;
  expect(await h.admission.admit()).toHaveLength(1);
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(1);
});

test("revoking the approving operator stops a delegated creator's schedule", async () => {
  const f = fixture = start();
  const approver = createPrincipal(f.db, { authMethod: "password", label: "Eurycleia", ttlSeconds: 3600 * 24 });
  const service = f.service({ dispatchAvailable: () => true });
  const { proposal } = await service.propose(f.agent, { key: "agent-schedule", definition: cronDefinition("* * * * *") });
  await service.approve(approver, proposal.id, { fingerprint: proposal.fingerprint, decision: "approve" });
  const { task } = await service.publish(f.agent, { proposalId: proposal.id });
  const h = harness(f, succeed("Agent work."));
  f.clock.now += MINUTE;
  const [id] = await h.admission.admit();
  revokePrincipal(f.db, approver.id, f.clock.now);
  // The creator is still usable; the grant's operator is not.
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(0);
  expect(createInboxStore(f.db).getItem(`${id}-1`)).toMatchObject({ status: "dropped" });
  f.clock.now += 2 * MINUTE;
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.service.list(f.agent, { id: task.id })).tasks[0]).toMatchObject({ blockedReason: "authority_unusable" });
});

test("nothing new starts at or after an approved recurrence end, not even queued work", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE, end = f.clock.now + 3 * MINUTE;
  const task = await create(f, "ithaca-ending", cronDefinition("* * * * *", { endAt: isoInstant(end) }));
  const h = harness(f, succeed("Should not run."));
  f.clock.now = at;
  const [id] = await h.admission.admit();
  f.clock.now = end;
  expect((await h.runtime.tick()).claimed).toBe(1);
  expect(h.calls).toHaveLength(0);
  expect(occurrences(f)).toEqual([expect.objectContaining({ id, state: "expired", operations_used: 0 })]);
  expect(await h.admission.admit()).toEqual([]);
  expect((await h.service.list(f.owner, { id: task.id })).tasks[0]).toMatchObject({ state: "expired", nextDueAt: null });
  // A continuation cannot start after the end either.
  f.db.query("UPDATE schedule_occurrences SET state = 'waiting_for_action' WHERE id = ?").run(id);
  expect(h.admission.continueOccurrence(id!)).toBeNull();
});

test("a deadline never runs past the occurrence's 24-hour freshness bound", async () => {
  const f = fixture = start();
  const at = f.clock.now + MINUTE;
  await create(f, "ithaca-late", atDefinition(isoInstant(at)));
  const h = harness(f, succeed("Late but within bounds."));
  f.clock.now = at + 24 * HOUR - 2 * MINUTE;
  await h.admission.admit();
  await h.runtime.tick();
  expect(f.db.query("SELECT deadline_at FROM schedule_attempts").get()).toEqual({ deadline_at: at + 24 * HOUR });
});
