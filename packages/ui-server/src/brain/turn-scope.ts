/** Concrete per-turn scope monitor; shared journal observations drive filesystem and lifetime checks. */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { ClientScopeDecision, ServerScopeDecisionReceipt, ScopeCapReceipt, ScopeDimension, TurnScopeSummary } from "@schlessera/brain-ui-sdk/protocol";
import { recordTurnRoadblocks } from "../governance/roadblocks.js";
import { recordGovernanceEvent } from "../governance/events.js";
import { processAlive } from "./writer-gate.js";
import type { TurnJournal } from "./turn-journal.js";

type Worker = Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0];
type Live = { sessionId: string | null; principalId: string; origin: "interactive" | "voice"; profile: "strict" | "governed";
  startedAt: number; summary: TurnScopeSummary; workers: Set<Worker>; calls: Set<string>; disconnectedAt?: number;
  checking?: boolean; source: "policy" | "default"; stop: (reason: string) => void; current: () => boolean };
export const SCOPE_DISCONNECTED_MS = 30 * 60_000;
export const SCOPE_FREE_BYTES = 2 * 1024 ** 3;
export function scopeLimits(policy: EffectiveGovernancePolicy) {
  return { files_changed: policy.scope.max_files_changed, minutes: policy.scope.max_minutes,
    tool_calls: policy.scope.max_tool_calls, turn_bytes: policy.scope.max_bytes_written };
}
export function createTurnScope(db: Database, options: { brainPath: string; journal: TurnJournal;
  connected: (sessionId: string | null) => boolean; changed: (turnId: string, sessionId: string) => void;
  now?: () => number; space?: () => { total: number; free: number } }) {
  const now = options.now ?? Date.now;
  const space = options.space ?? (() => { const fs = statfsSync(options.brainPath); return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize }; });
  const active = new Map<string, Live>();
  const save = (turnId: string, turn: Live) => {
    db.query("UPDATE turn_scope SET session_id=?,summary=? WHERE turn_id=?").run(turn.sessionId, JSON.stringify(turn.summary), turnId);
    if (turn.sessionId) options.changed(turnId, turn.sessionId);
  };
  // A restart cannot resume a kernel process or turn whose authority ended.
  for (const row of db.query("SELECT s.turn_id,s.session_id,s.summary,j.actor,j.profile,j.started_at,j.pid,j.pid_start FROM turn_scope s LEFT JOIN turn_journal_turns j ON j.turn_id=s.turn_id WHERE s.ended_at IS NULL").all() as { turn_id: string; session_id: string | null; summary: string; actor: "interactive" | "voice" | "user" | null; profile: "strict" | "governed" | null; started_at: number | null; pid: number | null; pid_start: string | null }[]) {
    if (row.pid !== null && row.pid_start !== null && processAlive(row.pid, row.pid_start)) continue;
    const summary = JSON.parse(row.summary) as TurnScopeSummary;
    for (const receipt of summary.receipts) if (receipt.state === "paused") {
      receipt.state = "ended_before_answer"; receipt.reason = "Host restarted; the turn was interrupted.";
    }
    if (summary.receipts.some(receipt => receipt.state === "ended_before_answer")) recordTurnRoadblocks(db, { turnId: row.turn_id, sessionId: row.session_id, actor: row.actor ?? "interactive", model: null, profile: row.profile },
      { startedAt: row.started_at ?? summary.observedAt, endedAt: now(), calls: [], usage: [], finalUsage: null, outcomeDetail: null });
    db.query("UPDATE turn_scope SET summary=?,ended_at=? WHERE turn_id=?").run(JSON.stringify(summary), now(), row.turn_id);
  }
  function stop(turnId: string, turn: Live, receipt: ScopeCapReceipt, state: "stopped" | "voice_stopped" | "ended_before_answer", reason: string) {
    receipt.state = state; receipt.reason = reason;
    save(turnId, turn);
    for (const worker of turn.workers) worker.kill("SIGKILL");
    turn.stop(reason);
  }
  function check(turnId: string, turn: Live) {
    if (!turn.current()) return;
    turn.summary.minutes = Math.max(0, (now() - turn.startedAt) / 60_000);
    const fs = space(), floor = Math.max(fs.total * .05, SCOPE_FREE_BYTES);
    const pending = turn.summary.receipts.findLast(receipt => receipt.state === "paused");
    if (pending) {
      if (pending.dimension !== "free_space_floor" && fs.free < floor) {
        const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension: "free_space_floor", count: fs.free, cap: floor,
          overshoot: floor - fs.free, frozen: pending.frozen, observedAt: now(), state: "paused", reason: "Free space fell below its floor while this turn was paused. Stop only." };
        turn.summary.receipts.push(receipt);
        recordGovernanceEvent(db, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: null, profile: turn.profile,
          dedupeKey: receipt.eventId, payload: { cap: receipt.dimension, limit: floor, observed: fs.free, overshoot: receipt.overshoot,
            frozen: receipt.frozen, outcome: "paused", source: "default" } });
      }
      if (options.connected(turn.sessionId)) turn.disconnectedAt = undefined;
      else turn.disconnectedAt ??= now();
      if (turn.disconnectedAt !== undefined && now() - turn.disconnectedAt >= SCOPE_DISCONNECTED_MS)
        stop(turnId, turn, pending, "ended_before_answer", "No authorized client was connected for 30 minutes.");
      save(turnId, turn); return;
    }
    if (turn.checking) return;
    const counts: [ScopeDimension, number | null][] = [["free_space_floor", fs.free], ["tool_calls", turn.summary.calls],
      ["minutes", turn.summary.minutes], ["files_changed", turn.summary.changedPaths], ["turn_bytes", turn.summary.observedBytes]];
    for (const [dimension, count] of counts) {
      const cap = dimension === "free_space_floor" ? floor : turn.summary.limits[dimension];
      if (count === null || (dimension === "free_space_floor" ? count >= cap : count < cap)) continue;
      const granted = turn.summary.receipts.some(receipt => receipt.dimension === dimension && receipt.state === "continued");
      let frozen = false, freezeFailure: string | undefined;
      try { for (const worker of turn.workers) worker.freeze(); frozen = turn.workers.size > 0; }
      catch (error) { freezeFailure = `Scope freeze failed; the turn stopped: ${String(error)}`; for (const worker of turn.workers) worker.kill("SIGKILL"); }
      // No worker means no proven pause; fail closed, never claim nothing is running.
      // A periodic snapshot was already taken after our confirmed hold.
      if (frozen && !periodicHeld.has(turnId)) {
        turn.checking = true;
        void options.journal.observe().catch(error => {
          for (const worker of turn.workers) worker.kill("SIGKILL");
          if (turn.current()) turn.stop(`Scope observation failed; the turn stopped. ${String(error)}`);
        }).finally(() => { turn.checking = false; });
      }
      turn.summary.minutes = Math.max(0, (now() - turn.startedAt) / 60_000);
      const measured = dimension === "tool_calls" ? turn.summary.calls : dimension === "minutes" ? turn.summary.minutes
        : dimension === "files_changed" ? turn.summary.changedPaths : dimension === "turn_bytes" ? turn.summary.observedBytes : space().free;
      const observed = measured ?? count;
      const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension, count: observed, cap,
        overshoot: Math.max(0, dimension === "free_space_floor" ? cap - observed : observed - cap), frozen, observedAt: now(), state: "paused",
        ...(frozen && dimension !== "free_space_floor" && !granted && cap > 0 && Number.isFinite(cap * 2) && turn.origin !== "voice" ? { newCap: cap * 2 } : {}) };
      turn.summary.receipts.push(receipt);
      recordGovernanceEvent(db, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: null, profile: turn.profile,
        dedupeKey: receipt.eventId, payload: { cap: dimension, limit: cap, observed, overshoot: receipt.overshoot,
          frozen, outcome: turn.origin === "voice" ? "voice_stopped" : frozen ? "paused" : "stopped", source: turn.source } });
      if (turn.origin === "voice") stop(turnId, turn, receipt, "voice_stopped", `I stopped because this turn reached its limit of ${cap} ${dimension === "tool_calls" ? "tool calls" : dimension === "minutes" ? "wall minutes" : dimension === "files_changed" ? "distinct changed paths" : "bytes"}${dimension === "free_space_floor" ? " of free space" : ""}. Ask again to carry on.`);
      else if (!frozen) stop(turnId, turn, receipt, "stopped", freezeFailure ?? "The host could not confirm a running worker to freeze; the turn stopped.");
      else { turn.disconnectedAt = options.connected(turn.sessionId) ? undefined : now(); save(turnId, turn); }
      return;
    }
    save(turnId, turn);
  }
  // Capture asynchronously retains changed versions. Hold productive
  // workers at the periodic deadline, before that cost, rather than freezing
  // only after retention completes. Actual cap pauses stay held for user input.
  const periodicHeld = new Map<string, { turn: Live; workers: Worker[] }>();
  let observationHolds = 0;
  let observationFailed = false;
  const periodic = {
    before() {
      if (observationHolds++ > 0) return;
      observationFailed = false;
      for (const [turnId, turn] of active) {
        if (!turn.current() || turn.summary.receipts.some(receipt => receipt.state === "paused")) continue;
        const held: Worker[] = []; periodicHeld.set(turnId, { turn, workers: held });
        for (const worker of turn.workers) { held.push(worker); worker.freeze(); }
      }
    },
    after(completed: boolean) {
      observationFailed ||= !completed;
      if (--observationHolds > 0) return;
      completed &&= !observationFailed;
      for (const { turn, workers } of periodicHeld.values()) {
        // Storage/reporting may itself fail before the journal's stop callback.
        // A failed capture never resumes a productive temporary hold.
        if (!completed) {
          for (const worker of workers) worker.kill("SIGKILL");
          if (turn.current()) turn.stop("Scope observation failed; the turn stopped. Partial work remains.");
          continue;
        }
        if (turn.summary.receipts.some(receipt => receipt.state === "paused") && turn.current()) continue;
        if (!turn.current()) { for (const worker of workers) worker.kill("SIGKILL"); continue; }
        try { for (const worker of workers) worker.resume(); }
        catch (error) {
          for (const worker of turn.workers) worker.kill("SIGKILL");
          turn.stop(`The host could not resume the worker after scope observation; it stopped. Partial work remains. ${String(error)}`);
        }
      }
      periodicHeld.clear();
    },
  };
  const unsubscribe = options.journal.onObservation((turnId, facts) => {
    const turn = active.get(turnId); if (!turn) return;
    turn.summary.changedPaths = facts.partial ? null : facts.changedPaths;
    turn.summary.observedBytes = facts.partial ? null : facts.observedBytes;
    turn.summary.coverage = facts.partial ? "partial" : "observed_versions";
    turn.summary.observedAt = now(); check(turnId, turn);
  }, periodic);
  return {
    begin(turnId: string, input: { sessionId: string | null; principalId: string; origin: Live["origin"]; profile: Live["profile"];
      policy: EffectiveGovernancePolicy; source: Live["source"]; hardTimeoutMs: number; current: () => boolean; stop: Live["stop"] }) {
      const summary: TurnScopeSummary = { policySource: input.source, limits: scopeLimits(input.policy), hardTimeoutMs: input.hardTimeoutMs, calls: 0, minutes: 0,
        changedPaths: null, observedBytes: null, coverage: "partial", observedAt: now(), receipts: [] };
      const turn: Live = { ...input, startedAt: now(), summary, workers: new Set(), calls: new Set() };
      db.query("INSERT INTO turn_scope(turn_id,session_id,principal_id,summary) VALUES (?,?,?,?)").run(turnId, input.sessionId, input.principalId, JSON.stringify(summary));
      active.set(turnId, turn);
    },
    workerStarted(turnId: string, worker: Worker) {
      const turn = active.get(turnId); if (!turn || !turn.current()) { worker.kill("SIGKILL"); return; }
      turn.workers.add(worker);
      void worker.exited.finally(() => turn.workers.delete(worker)).catch(() => {});
      if (turn.summary.receipts.some(receipt => receipt.state === "paused") || observationHolds > 0) {
        worker.freeze();
        if (observationHolds > 0) {
          const held = periodicHeld.get(turnId) ?? { turn, workers: [] };
          held.workers.push(worker); periodicHeld.set(turnId, held);
        }
      }
    },
    bindSession(turnId: string, sessionId: string) { const turn = active.get(turnId); if (turn) { turn.sessionId = sessionId; save(turnId, turn); } },
    toolCall(turnId: string, toolUseId: string) {
      const turn = active.get(turnId); if (!turn || turn.calls.has(toolUseId)) return;
      turn.calls.add(toolUseId); turn.summary.calls = turn.calls.size; check(turnId, turn);
    },
    isPaused(turnId: string) { return active.get(turnId)?.summary.receipts.some(receipt => receipt.state === "paused") ?? false; },
    decide(msg: ClientScopeDecision, authorized: boolean): ServerScopeDecisionReceipt {
      const response = (state: ServerScopeDecisionReceipt["state"], reason?: string): ServerScopeDecisionReceipt => ({ ...msg, type: "scope_decision_receipt", state, ...(reason ? { reason } : {}) });
      if (!authorized) return response("refused", "Current authenticated authority is required.");
      const row = db.query("SELECT session_id,summary,ended_at FROM turn_scope WHERE turn_id=?").get(msg.turnId) as { session_id: string | null; summary: string; ended_at: number | null } | null;
      if (!row || row.session_id !== msg.sessionId) return response("refused", "This decision does not match the turn and session.");
      const summary = JSON.parse(row.summary) as TurnScopeSummary, receipt = summary.receipts.find(receipt => receipt.eventId === msg.eventId);
      if (!receipt) return response("refused", "This cap event is not recognized.");
      if (receipt.state === "ended_before_answer" || row.ended_at !== null && receipt.state === "paused") return response("ended_before_answer", receipt.reason);
      if (receipt.submissionId === msg.submissionId) return response("accepted");
      if (receipt.state !== "paused") return response("answered_elsewhere");
      const turn = active.get(msg.turnId);
      if (!turn || !turn.current()) return response("ended_before_answer");
      if (msg.action === "readback") return response("pending");
      // A grant cannot bypass a floor that another writer crossed while this worker waited.
      if (msg.action === "continue") check(msg.turnId, turn);
      if (!turn.current()) return response("ended_before_answer");
      const latestPause = turn.summary.receipts.findLast(receipt => receipt.state === "paused");
      if (msg.action === "continue" && latestPause?.eventId !== msg.eventId) return response("refused", "The free-space floor now requires Stop only.");
      const liveReceipt = turn.summary.receipts.find(receipt => receipt.eventId === msg.eventId)!;
      if (msg.action === "continue" && liveReceipt.newCap === undefined) return response("refused", "This limit permits Stop only.");
      try {
        if (msg.action === "continue") {
          // Grant is consumed before resumption; a failed resume cannot issue another increment.
          turn.summary.limits[liveReceipt.dimension as Exclude<ScopeDimension,"free_space_floor">] = liveReceipt.newCap!;
          liveReceipt.state = "continued"; liveReceipt.submissionId = msg.submissionId; save(msg.turnId, turn);
          if (observationHolds === 0) for (const worker of turn.workers) worker.resume();
        } else { liveReceipt.submissionId = msg.submissionId; stop(msg.turnId, turn, liveReceipt, "stopped", "You stopped the turn at its scope limit."); }
        return response("accepted");
      } catch (error) {
        stop(msg.turnId, turn, liveReceipt, "ended_before_answer", "The host could not resume the worker; it stopped. Partial work remains.");
        return response("failed", String(error));
      }
    },
    finish(turnId: string) {
      const turn = active.get(turnId); if (!turn) return;
      for (const receipt of turn.summary.receipts) if (receipt.state === "paused") { receipt.state = "ended_before_answer"; receipt.reason = "The turn ended before an answer."; }
      save(turnId, turn); db.query("UPDATE turn_scope SET ended_at=? WHERE turn_id=?").run(now(), turnId); active.delete(turnId);
    },
    close() { unsubscribe(); for (const [id, turn] of active) { for (const worker of turn.workers) worker.kill("SIGKILL"); turn.stop("Host closed; the turn was interrupted."); this.finish(id); } },
  };
}
export type TurnScope = ReturnType<typeof createTurnScope>;
