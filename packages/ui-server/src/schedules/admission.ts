/**
 * Occurrence admission through the existing Queue (Execution A, Budget A,
 * Timing A in docs/decisions/scheduled-tasks.md).
 *
 * `admit` turns a due instant into one durable occurrence and its first Queue
 * item. The Queue runtime claims that item through the shared budget
 * reservation and calls `dispatch`, which starts at most one bounded attempt
 * through `runAutonomousTurn`. Nothing here wires a production tick: #915 owns
 * that, and #689 gates its enablement. There is no route, CLI command or core
 * runner that reaches this module.
 */
import type { Database } from "bun:sqlite";
import type { AgentBackend, InboxQueueItem, ServerMessage } from "@schlessera/brain-ui-sdk/server";

import { createInboxStore } from "../inbox/store.js";
import { failInboxWork } from "../inbox/actions.js";
import { reconcileInboxBudgets, type InboxBudgetOperation } from "../inbox/budget.js";
import { inboxRunIsLive } from "../inbox/lifetime.js";
import { runAutonomousTurn, type AutonomousTurnDeps } from "../inbox/autonomous-turn.js";
import type { StoredDefinition } from "./definition.js";
import { dropUnstartedItems } from "./queue-items.js";
import { occurrenceId, type ExecutionPolicy, type OccurrenceRow, type ScheduleService, type TaskRow } from "./service.js";
import { SCHEDULE_FRESHNESS_MS } from "./time.js";

/** Result text kept on the occurrence: bounded, inert, never authority. */
export const MAX_RESULT_BYTES = 4096;
/** Tools whose repetition cannot repeat an effect, so a failed attempt may retry. */
const SAFE_READ_TOOLS = new Set(["brain_read"]);

type Timer = ReturnType<typeof setTimeout>;
export interface AdmissionTimers {
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface ScheduleAdmissionDeps extends Pick<AutonomousTurnDeps, "store" | "runtime" | "onWrite" | "log"> {
  service: ScheduleService;
  /** The backend the approved execution policy names. */
  backend: AgentBackend;
  now?: () => number;
  timers?: AdmissionTimers;
  /** Server-selected model/billing bounds for one operation under this policy. */
  operation(policy: ExecutionPolicy): Pick<InboxBudgetOperation, "model" | "billingMode" | "pricingRoute" | "maximumTokens">;
  /** Host mapping from approved canonical tool names to the backend's own names. */
  allowedTools(definition: StoredDefinition): string[];
}

interface LinkRow { item_id: string; occurrence_id: string; sequence: number }
interface AttemptRow { run_id: string; occurrence_id: string; item_id: string; started_at: number; deadline_at: number }

const OUTSTANDING = "('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying')";

function clipUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  for (let end = limit; end >= limit - 3; end--) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch { /* earlier boundary */ }
  }
  return "";
}

export function createScheduleAdmission(db: Database, deps: ScheduleAdmissionDeps) {
  const now = deps.now ?? Date.now;
  const timers: AdmissionTimers = deps.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const { internal } = deps.service;
  const store = () => createInboxStore(db, { now });

  const linkOf = (itemId: string) =>
    db.query("SELECT * FROM schedule_occurrence_items WHERE item_id = ?").get(itemId) as LinkRow | null;
  const occurrenceRow = (id: string) =>
    db.query("SELECT * FROM schedule_occurrences WHERE id = ?").get(id) as OccurrenceRow | null;
  const policyOf = (task: TaskRow) => JSON.parse(task.execution_policy_json) as ExecutionPolicy;
  const readOnly = (task: TaskRow) => internal.definitionOf(task).scope.tools.every((tool) => SAFE_READ_TOOLS.has(tool.name));
  /** Every admitted operation is one budget reservation, committed by the claim itself. */
  const operationsAdmitted = (occurrence: string) => (db.query(`SELECT COUNT(*) AS n FROM inbox_budget_reservations r
    JOIN schedule_occurrence_items l ON l.item_id = r.item_id WHERE l.occurrence_id = ?`).get(occurrence) as { n: number }).n;

  function setOccurrence(id: string, state: OccurrenceRow["state"], at: number, extra: { result?: string } = {}): void {
    db.query(`UPDATE schedule_occurrences SET state = ?, updated_at = ?,
      result_state = CASE WHEN ? IS NULL THEN result_state ELSE 'available' END, result_text = COALESCE(?, result_text)
      WHERE id = ?`).run(state, at, extra.result ?? null, extra.result ?? null, id);
  }

  /** Past its freshness bound or its task's approved end: no new attempt may start. */
  const over = (occurrence: OccurrenceRow, task: TaskRow, at: number) =>
    at >= occurrence.expires_at || internal.ended(task, at);

  /** A one-off ends with its occurrence; a recurring task keeps its configuration. */
  function settleTask(task: TaskRow, state: OccurrenceRow["state"], at: number): void {
    if (state === "unknown") {
      db.query("UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'unknown_effect', updated_at = ? WHERE id = ? AND state = 'active'")
        .run(at, task.id);
      return;
    }
    if (internal.definitionOf(task).when.kind !== "at") return;
    const final = state === "completed" ? "completed" : state === "expired" ? "expired" : state === "failed" ? "failed" : null;
    if (final) db.query("UPDATE schedule_tasks SET state = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(final, at, task.id);
  }

  /** Release a claimed item that will not run, in the caller's transaction. */
  function dropClaim(itemId: string): void {
    const item = store().getItem(itemId);
    if (item?.queue === "queue" && ["claimed", "ready", "failed", "scheduled"].includes(item.status))
      store().commit([{ kind: "transition", itemId, expectedVersion: item.version, to: "dropped" }]);
  }

  /**
   * End attempts whose worker is gone. An attempt whose backend never
   * acquired its reservation could not have had an effect, so its occurrence
   * may retry within its remaining operations. Once the backend acquired it,
   * an effect may have happened without a receipt: the occurrence becomes
   * `unknown`, is never replayed, and pauses its task for investigation.
   */
  function recover(): number {
    const at = now();
    const recovered = db.transaction(() => {
      const open = db.query("SELECT * FROM schedule_attempts WHERE outcome IS NULL ORDER BY started_at, run_id").all() as AttemptRow[];
      let count = 0;
      for (const attempt of open) {
        const item = store().getItem(attempt.item_id) as InboxQueueItem | null;
        if (inboxRunIsLive(db, attempt.run_id)) continue;
        // A claim inside its lease may belong to a worker still starting up.
        if (item?.status === "claimed" && item.runId === attempt.run_id && (item.leaseUntil ?? 0) > at) continue;
        const occurrence = occurrenceRow(attempt.occurrence_id)!;
        const task = internal.taskRow(occurrence.task_id)!;
        const acquired = db.query("SELECT runtime_acquired_at FROM inbox_budget_reservations WHERE run_id = ?")
          .get(attempt.run_id) as { runtime_acquired_at: number | null } | null;
        const effectPossible = acquired?.runtime_acquired_at != null;
        db.query("UPDATE schedule_attempts SET outcome = ?, ended_at = ? WHERE run_id = ? AND outcome IS NULL")
          .run(effectPossible ? "unknown" : "interrupted", at, attempt.run_id);
        count++;
        if (occurrence.state !== "running" && occurrence.state !== "unwinding") continue;
        if (effectPossible) {
          setOccurrence(occurrence.id, "unknown", at);
          settleTask(task, "unknown", at);
          dropClaim(attempt.item_id);
          continue;
        }
        // The item may still hold the dead claim, or the Queue's own lease
        // recovery may already have returned it, or even reclaimed it.
        const alive = item !== null && ["scheduled", "ready", "claimed"].includes(item.status);
        const retry = alive && operationsAdmitted(occurrence.id) < occurrence.max_operations &&
          !over(occurrence, task, at) && task.state === "active";
        if (retry) {
          setOccurrence(occurrence.id, "retrying", at);
          if (item!.status === "claimed" && item!.runId === attempt.run_id) failInboxWork(db, item!.id, item!.version, at);
        } else {
          const final = over(occurrence, task, at) ? "expired" : task.state === "cancelled" ? "cancelled" : "failed";
          setOccurrence(occurrence.id, final, at);
          settleTask(task, final, at);
          dropClaim(attempt.item_id);
        }
      }
      return count;
    }).immediate();
    reconcileInboxBudgets(db, at);
    return recovered;
  }

  /**
   * Expire unstarted work at its 24-hour freshness bound or the approved
   * recurrence end (a started attempt may still finish), and finished tasks.
   */
  function expire(at: number): void {
    db.transaction(() => {
      const unstarted = db.query(`SELECT * FROM schedule_occurrences
        WHERE state IN ('queued', 'retrying', 'waiting_for_action')`).all() as OccurrenceRow[];
      const stale = unstarted.filter((occurrence) => over(occurrence, internal.taskRow(occurrence.task_id)!, at));
      for (const occurrence of stale) {
        setOccurrence(occurrence.id, "expired", at);
        const task = internal.taskRow(occurrence.task_id)!;
        dropUnstartedItems(db, task.id, at);
        settleTask(task, "expired", at);
      }
      const active = db.query(`SELECT * FROM schedule_tasks t WHERE state = 'active'
        AND NOT EXISTS (SELECT 1 FROM schedule_occurrences o WHERE o.task_id = t.id AND o.state IN ${OUTSTANDING})`).all() as TaskRow[];
      for (const task of active) {
        if (internal.finished(task, at) && !(internal.definitionOf(task).when.kind === "at" &&
            db.query("SELECT 1 FROM schedule_occurrences WHERE task_id = ? LIMIT 1").get(task.id)))
          db.query("UPDATE schedule_tasks SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'active'").run(at, task.id);
      }
    }).immediate();
  }

  /**
   * Create the occurrence for each task's latest fresh due instant, with its
   * first Queue item, in one immediate transaction per task. The deterministic
   * occurrence ID, UNIQUE(task, due) and the one-outstanding index make
   * concurrent callers in any process admit it once. A due instant arriving
   * while work is outstanding is recorded as busy: the evaluated cursor moves
   * past it, so it is never replayed later.
   */
  async function admit(): Promise<string[]> {
    recover();
    expire(now());
    const created: string[] = [];
    const tasks = db.query("SELECT * FROM schedule_tasks WHERE state = 'active' ORDER BY created_at, id").all() as TaskRow[];
    for (const task of tasks) {
      const refusal = await internal.refusal(task);
      if (refusal === "definition_drift") {
        db.query("UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'definition_drift', updated_at = ? WHERE id = ? AND state = 'active'")
          .run(now(), task.id);
        continue;
      }
      if (refusal) continue;
      const id = db.transaction(() => {
        const at = now();
        const current = internal.taskRow(task.id)!;
        if (current.state !== "active" || current.updated_at !== task.updated_at || internal.restorePending() ||
            !internal.authorized(current)) return null;
        const outstanding = db.query(`SELECT 1 FROM schedule_occurrences WHERE task_id = ? AND state IN ${OUTSTANDING}`).get(current.id);
        const dueAt = outstanding ? null : internal.latestDue(current, at);
        db.query("UPDATE schedule_tasks SET evaluated_through = MAX(evaluated_through, ?) WHERE id = ?").run(at, current.id);
        if (dueAt === null) return null;
        const definition = internal.definitionOf(current);
        const occurrence = occurrenceId(current.id, dueAt);
        const inserted = db.query(`INSERT OR IGNORE INTO schedule_occurrences (id, task_id, due_at, expires_at, state,
          operations_used, max_operations, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`)
          .run(occurrence, current.id, dueAt, dueAt + SCHEDULE_FRESHNESS_MS, definition.limits.maxOperations, at, at);
        if (inserted.changes === 0) return null;
        const itemId = `${occurrence}-1`;
        store().openTrustedWork({ threadId: `schedule-${occurrence}`, item: {
          id: itemId, dedupKey: itemId, threadId: `schedule-${occurrence}`, queue: "queue", type: "execute",
          status: "ready", attempts: 0, maxAttempts: definition.limits.maxOperations, version: 1,
          createdAt: at, updatedAt: at, expiresAt: dueAt + SCHEDULE_FRESHNESS_MS,
          // The approved snapshot is the instruction; the item only names it.
          payload: { instruction: `Scheduled task ${current.id}, occurrence ${occurrence}.` },
        } });
        db.query("INSERT INTO schedule_occurrence_items (item_id, occurrence_id, sequence, created_at) VALUES (?, ?, 1, ?)")
          .run(itemId, occurrence, at);
        return occurrence;
      }).immediate();
      if (id) created.push(id);
    }
    return created;
  }

  /**
   * A continuation for an occurrence waiting on a resolved Action: a new
   * Queue item that can only spend the occurrence's remaining operations.
   * Returns null when nothing remains or the occurrence cannot continue.
   */
  function continueOccurrence(id: string): string | null {
    return db.transaction(() => {
      const at = now();
      const occurrence = occurrenceRow(id);
      if (!occurrence || occurrence.state !== "waiting_for_action") return null;
      const task = internal.taskRow(occurrence.task_id)!;
      if (over(occurrence, task, at) || task.state !== "active" || !internal.authorized(task)) return null;
      const live = db.query(`SELECT 1 FROM schedule_occurrence_items l JOIN inbox_items i ON i.id = l.item_id
        WHERE l.occurrence_id = ? AND i.status IN ('scheduled', 'ready', 'claimed', 'blocked') LIMIT 1`).get(id);
      if (live) return null;
      const remaining = occurrence.max_operations - operationsAdmitted(id);
      if (remaining <= 0) {
        setOccurrence(id, "failed", at);
        settleTask(task, "failed", at);
        return null;
      }
      const { sequence } = db.query("SELECT MAX(sequence) AS sequence FROM schedule_occurrence_items WHERE occurrence_id = ?").get(id) as { sequence: number };
      const itemId = `${id}-${sequence + 1}`;
      store().commit([{ kind: "item", item: {
        id: itemId, dedupKey: itemId, threadId: `schedule-${id}`, queue: "queue", type: "execute", status: "ready",
        attempts: 0, maxAttempts: remaining, version: 1, createdAt: at, updatedAt: at, expiresAt: occurrence.expires_at,
        payload: { instruction: `Scheduled task ${task.id}, occurrence ${id}, continuation ${sequence + 1}.` },
      } }]);
      db.query("INSERT INTO schedule_occurrence_items (item_id, occurrence_id, sequence, created_at) VALUES (?, ?, ?, ?)")
        .run(itemId, id, sequence + 1, at);
      setOccurrence(id, "retrying", at);
      return itemId;
    }).immediate();
  }

  /** The budget operation for a claim: the creator's authority, the policy's model. */
  function operation(item: InboxQueueItem): InboxBudgetOperation {
    const link = linkOf(item.id);
    if (!link) throw new Error("Not scheduled work");
    const task = internal.taskRow(occurrenceRow(link.occurrence_id)!.task_id)!;
    return { ...deps.operation(policyOf(task)), runId: `${item.id}-${item.attempts + 1}`,
      principalId: task.creator_principal_id, purpose: item.attempts > 0 ? "retry" : "execute" };
  }

  /**
   * Start one attempt for a claimed item. The start transaction is the
   * cancel-versus-start boundary: a cancellation committed first leaves
   * nothing to start, and one committed later finds a running attempt it
   * reports and does not stop. The attempt's deadline is fixed at start, and
   * the claim is released only after the backend has unwound.
   */
  async function dispatch(item: InboxQueueItem, signal: AbortSignal): Promise<void> {
    const link = linkOf(item.id);
    if (!link) throw new Error("Not scheduled work");
    // A dead earlier attempt is settled first, so this claim sees its outcome.
    recover();
    const task = internal.taskRow(occurrenceRow(link.occurrence_id)!.task_id)!;
    const refusal = await internal.refusal(task);
    const runId = item.runId!;
    const started = db.transaction(() => {
      const at = now();
      const occurrence = occurrenceRow(link.occurrence_id)!;
      const current = internal.taskRow(task.id)!;
      const claim = store().getItem(item.id) as InboxQueueItem | null;
      if (claim?.status !== "claimed" || claim.runId !== runId) return null;
      const admitted = operationsAdmitted(occurrence.id);
      const startable = ["queued", "retrying"].includes(occurrence.state) && current.state === "active" &&
        refusal === null && !internal.restorePending() && internal.authorized(current) &&
        !over(occurrence, current, at) && admitted <= occurrence.max_operations;
      if (!startable) {
        if (["queued", "retrying"].includes(occurrence.state)) {
          const final = over(occurrence, current, at) ? "expired" : current.state === "cancelled" ? "cancelled"
            : admitted > occurrence.max_operations ? "failed" : null;
          if (final) { setOccurrence(occurrence.id, final, at); settleTask(current, final, at); }
        }
        // Refused for now (authority, drift, restore): the claim is dropped,
        // the occurrence stays as it is and the reservation is released.
        dropClaim(item.id);
        return null;
      }
      const { attemptTimeoutMs } = internal.definitionOf(current).limits;
      const deadline = Math.min(at + attemptTimeoutMs, occurrence.expires_at);
      db.query("INSERT INTO schedule_attempts (run_id, occurrence_id, item_id, started_at, deadline_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, occurrence.id, item.id, at, deadline);
      const runs = [...(JSON.parse(occurrence.run_ids_json) as string[]), runId];
      db.query(`UPDATE schedule_occurrences SET state = 'running', operations_used = ?, run_ids_json = ?,
        attempt_deadline_at = ?, updated_at = ? WHERE id = ?`).run(admitted, JSON.stringify(runs), deadline, at, occurrence.id);
      return { deadline, definition: internal.definitionOf(current), policy: policyOf(current), creator: current.creator_principal_id };
    }).immediate();
    if (!started) { reconcileInboxBudgets(db, now()); return; }

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    const timer = timers.setTimeout(() => {
      timedOut = true;
      // Visible while the backend unwinds; the claim is still held.
      db.query("UPDATE schedule_occurrences SET state = 'unwinding', updated_at = ? WHERE id = ? AND state = 'running'")
        .run(now(), link.occurrence_id);
      controller.abort();
    }, Math.max(0, started.deadline - now()));
    let text = "";
    let result: Awaited<ReturnType<typeof runAutonomousTurn>> | null = null;
    try {
      result = await runAutonomousTurn({
        db, backend: deps.backend, store: deps.store, runtime: deps.runtime, onWrite: deps.onWrite, log: deps.log,
        // No durable decision path is wired for scheduled work yet: a run that
        // needs one fails closed instead of waiting on a live promise.
        checkpoint: () => { throw new Error("Scheduled work cannot request a decision."); },
        emit: (frame: ServerMessage) => {
          if (frame.type === "text_delta") text = clipUtf8(text + frame.text, MAX_RESULT_BYTES);
        },
      }, {
        turnId: runId, principalId: started.creator, prompt: started.definition.prompt,
        profileId: started.policy.profileId ?? undefined, allowedTools: deps.allowedTools(started.definition),
        systemPromptAppend: "This is approved scheduled work. Use only the approved tools and targets; do not change files or use the network.",
        signal: controller.signal, billingMode: deps.operation(started.policy).billingMode,
      });
    } catch { result = null; }
    finally {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }

    // The backend has returned (unwound). Record the outcome, then release.
    db.transaction(() => {
      const at = now();
      const outcome = timedOut ? "timeout" : result === null ? "error" : result.outcome;
      db.query("UPDATE schedule_attempts SET outcome = ?, ended_at = ? WHERE run_id = ? AND outcome IS NULL").run(outcome, at, runId);
      const occurrence = occurrenceRow(link.occurrence_id)!;
      const current = internal.taskRow(task.id)!;
      const claim = store().getItem(item.id) as InboxQueueItem | null;
      const claimed = claim?.status === "claimed" && claim.runId === runId;
      if (outcome === "success" && !result!.yielded) {
        setOccurrence(occurrence.id, "completed", at, { result: text });
        settleTask(current, "completed", at);
        if (claimed) store().commit([{ kind: "transition", itemId: item.id, expectedVersion: claim!.version, to: "done" }]);
        return;
      }
      const remaining = operationsAdmitted(occurrence.id) < occurrence.max_operations;
      const retry = remaining && !over(occurrence, current, at) && current.state === "active" && readOnly(current);
      if (retry) {
        setOccurrence(occurrence.id, "retrying", at);
        // A yield already returned the item to the Queue with its attempt counted.
        if (claimed) failInboxWork(db, item.id, claim!.version, at);
        return;
      }
      const final = over(occurrence, current, at) ? "expired" : current.state === "cancelled" ? "cancelled" : "failed";
      setOccurrence(occurrence.id, final, at);
      settleTask(current, final, at);
      if (claimed && final === "failed" && !remaining) failInboxWork(db, item.id, claim!.version, at);
      else dropClaim(item.id);
    }).immediate();
    reconcileInboxBudgets(db, now());
  }

  return {
    admit, recover, dispatch, operation, continueOccurrence,
    /** Whether a Queue item is scheduled work this module dispatches. */
    owns: (item: InboxQueueItem) => linkOf(item.id) !== null,
  };
}

export type ScheduleAdmission = ReturnType<typeof createScheduleAdmission>;
