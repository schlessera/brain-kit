/** Concrete per-turn scope monitor; shared journal observations drive filesystem and lifetime checks. */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { ClientScopeDecision, ServerScopeDecisionReceipt, ScopeCapReceipt, ScopeDimension, TurnScopeSummary } from "@schlessera/brain-ui-sdk/protocol";
import type { Logger } from "@opentelemetry/api-logs";
import type { GovernanceEventInput } from "../governance/events.js";
import { createGovernanceWrites, type GovernanceWrites } from "../governance/event-writes.js";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import { setup, url } from "./turn-scope-writes.js";
import { CODE_CHECKOUT_BYTES } from "./code-change-worker.js";
import type { ActivityTurnHold } from "@schlessera/brain-ui-sdk/protocol";
import type { JournalHold, TurnJournal } from "./turn-journal.js";

type Worker = Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0];
type Live = { unrecorded?: boolean; sessionId: string | null; principalId: string; origin: "interactive" | "voice"; profile: "strict" | "governed";
  startedAt: number; summary: TurnScopeSummary;
  /** What `files_changed` counts: changed paths outside `workspaces/` (#3793); null while unknown. */
  filesChanged: number | null; workers: Set<Worker>; calls: Set<string>; disconnectedAt?: number;
  checkoutBytes?: number; checkoutReceipt?: ScopeCapReceipt; checking?: boolean; liveIndexWritable: boolean; source: "policy" | "default"; stop: (reason: string) => void; current: () => boolean; model?: () => string | null };
export const SCOPE_DISCONNECTED_MS = 30 * 60_000;
/** Matches the former default byte scope without charging generated versions. */
export const INDEX_OBSERVATION_CAP_BYTES = 4 * 1024 ** 3;
export const SCOPE_FREE_BYTES = 2 * 1024 ** 3;
export function scopeLimits(policy: EffectiveGovernancePolicy) {
  return { files_changed: policy.scope.max_files_changed, minutes: policy.scope.max_minutes,
    tool_calls: policy.scope.max_tool_calls, turn_bytes: policy.scope.max_bytes_written };
}
export function createTurnScope(db: Database, options: { brainPath: string; journal: TurnJournal;
  connected: (sessionId: string | null) => boolean; changed: (turnId: string, sessionId: string) => void;
  now?: () => number; space?: () => { total: number; free: number };
  /** Where scope rows and their governance events commit: the write worker (#2850). Absent: on `db`, at once. */
  writer?: SqliteWriter; governance?: Pick<GovernanceWrites, "record">; log?: Logger }) {
  const now = options.now ?? Date.now;
  const space = options.space ?? (() => { const fs = statfsSync(options.brainPath); return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize }; });
  const active = new Map<string, Live>();
  const submit = procedureCaller(db, { url, setup }, undefined, options.writer);
  // Each turn's latest scope write, until it settles: a decision reads the
  // turn's row only once every write submitted before it has committed.
  const tails = new Map<string, Promise<unknown>>();
  const call = (turnId: string, name: string, ...args: unknown[]): Promise<unknown> => {
    const done = submit(name, turnId, ...args);
    const tail = done.then(() => {}, () => {});
    tails.set(turnId, tail);
    void tail.then(() => { if (tails.get(turnId) === tail) tails.delete(turnId); });
    return done;
  };

  const governance = options.governance ?? createGovernanceWrites(db, options.writer);
  /**
   * A scope record that cannot be kept stops its turn: its caps could no
   * longer be decided against what was recorded.
   */
  const unrecorded = (turnId: string, error: unknown) => {
    options.log?.emit({ severityText: "WARN", body: `turn scope not recorded: ${error instanceof Error ? error.message : String(error)}`, attributes: { "turn.id": turnId } });
    const turn = active.get(turnId);
    if (!turn || turn.unrecorded || !turn.current()) return;
    turn.unrecorded = true;
    for (const worker of turn.workers) worker.kill("SIGKILL");
    turn.stop("The turn's scope could not be recorded; the turn stopped. Partial work remains.");
  };
  // The summary is taken now; the client hears of it once the row has
  // committed, because the journal summary it is sent with reads it back.
  const save = (turnId: string, turn: Live): Promise<boolean> => {
    const sessionId = turn.sessionId;
    return call(turnId, "save", sessionId, JSON.stringify(turn.summary)).then(stored => { if (sessionId) options.changed(turnId, sessionId); return stored === true; }, error => { unrecorded(turnId, error); return false; });
  };
  const scopeEvent = (turnId: string, input: GovernanceEventInput<"scope_cap">) => {
    try { governance.record(input).catch(error => unrecorded(turnId, error)); } catch (error) { unrecorded(turnId, error); }
  };
  void submit("recover", now()).catch(error => options.log?.emit({ severityText: "WARN", body: `turn scope recovery failed: ${error instanceof Error ? error.message : String(error)}` }));
  function stop(turnId: string, turn: Live, receipt: ScopeCapReceipt, state: "stopped" | "voice_stopped" | "ended_before_answer", reason: string) {
    receipt.state = state; receipt.reason = reason;
    save(turnId, turn);
    for (const worker of turn.workers) worker.kill("SIGKILL");
    turn.stop(reason);
  }
  function refreshHeadroom(turn: Live, receipt: ScopeCapReceipt) {
    if (receipt.dimension === "free_space_floor") return;
    if (receipt === turn.checkoutReceipt) {
      receipt.count = turn.checkoutBytes ?? receipt.count; receipt.overshoot = Math.max(0, receipt.count - receipt.cap); receipt.observedAt = now();
      delete receipt.newCap;
      receipt.reason = "Checkout content has a fixed 16 MiB ceiling. Stop only; repair or reduce the checkout before starting another code turn.";
      return;
    }
    const dimension = receipt.dimension;
    const index = receipt.result === "index_capacity";
    const observed = index ? turn.summary.indexBytes ?? null : dimension === "tool_calls" ? turn.summary.calls : dimension === "minutes" ? turn.summary.minutes
      : dimension === "files_changed" ? turn.filesChanged : turn.summary.observedBytes;
    if (index && observed === null) { receipt.measurement = "unknown"; receipt.count = 0; receipt.overshoot = 0; }
    else delete receipt.measurement;
    // Incomplete captures retain the last reliable receipt, never imply headroom.
    if (observed !== null && Number.isFinite(observed)) {
      receipt.count = observed; receipt.overshoot = Math.max(0, observed - receipt.cap); receipt.observedAt = now();
    }
    delete receipt.newCap;
    const granted = turn.summary.receipts.some(previous => previous.dimension === dimension && previous.result === receipt.result && previous.state === "continued");
    const newCap = receipt.cap * 2;
    if (!receipt.frozen || turn.origin === "voice" || granted || receipt.cap <= 0 || !Number.isFinite(newCap) || (index ? turn.summary.indexLimitBytes : turn.summary.limits[dimension]) !== receipt.cap) return;
    if (observed === null || !Number.isFinite(observed)) {
      receipt.reason = "Latest scope observation is incomplete; continuation headroom is unknown. Stop only.";
    } else if (observed >= newCap) {
      const unit = dimension === "files_changed" ? "distinct paths" : dimension === "turn_bytes" ? "bytes" : dimension === "minutes" ? "min" : "tool calls";
      receipt.reason = `The finite continuation ceiling of ${newCap.toLocaleString("en-US")} ${unit} is already exhausted. Stop only.`;
    } else { receipt.newCap = newCap; delete receipt.reason; }
  }
  const timing = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };
  const stamp = () => timing(now) ?? null;
  const overlap = (record: ActivityTurnHold, read: () => boolean | null | undefined) => {
    const value = timing(read);
    record.inferenceInFlight = record.inferenceInFlight === true || value === true ? true : value == null ? null : record.inferenceInFlight;
  };
  const scopeCapRecords = new Map<string, ActivityTurnHold>();
  const confirmedStops = new WeakMap<Worker, number | null>();
  const stoppedWorkers = new WeakMap<ActivityTurnHold, Set<Worker>>();
  const attachStopped = (record: ActivityTurnHold, workers: Worker[], at: number | null) => {
    if (!workers.length) return;
    record.stoppedAt ??= at;
    const owned = stoppedWorkers.get(record) ?? new Set<Worker>();
    for (const worker of workers) owned.add(worker);
    stoppedWorkers.set(record, owned);
  };
  const confirmed = (worker: Worker) => confirmedStops.has(worker);
  const freeze = (worker: Worker) => {
    const result = worker.freeze();
    if (result === true) confirmedStops.set(worker, stamp()); else confirmedStops.delete(worker);
    return result !== false; // Preserve legacy void control semantics without a timing mark.
  };
  function check(turnId: string, turn: Live, cause: { toolUseId?: string; changedPaths?: number } = {}) {
    if (!turn.current()) return;
    turn.summary.minutes = Math.max(0, (now() - turn.startedAt) / 60_000);
    if ((turn.checkoutBytes ?? 0) > CODE_CHECKOUT_BYTES) {
      if (!turn.checkoutReceipt) {
        let frozen = false;
        try { for (const worker of turn.workers) worker.freeze(); frozen = turn.workers.size > 0; }
        catch { for (const worker of turn.workers) worker.kill("SIGKILL"); }
        const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension: "turn_bytes", count: turn.checkoutBytes!, cap: CODE_CHECKOUT_BYTES,
          overshoot: turn.checkoutBytes! - CODE_CHECKOUT_BYTES, frozen, observedAt: now(), state: "paused" };
        turn.checkoutReceipt = receipt; refreshHeadroom(turn, receipt); turn.summary.receipts.push(receipt);
        scopeEvent(turnId, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: turn.model?.() ?? null, profile: turn.profile,
          dedupeKey: receipt.eventId, payload: { cap: "turn_bytes", limit: receipt.cap, observed: receipt.count, overshoot: receipt.overshoot, frozen,
            outcome: turn.origin === "voice" ? "voice_stopped" : frozen ? "paused" : "stopped", source: "default" } });
        if (turn.origin === "voice" || !frozen) stop(turnId, turn, receipt, turn.origin === "voice" ? "voice_stopped" : "stopped", receipt.reason!);
      }
      refreshHeadroom(turn, turn.checkoutReceipt!); save(turnId, turn); return;
    }
    const fs = space(), floor = Math.max(fs.total * .05, SCOPE_FREE_BYTES);
    const pending = turn.summary.receipts.findLast(receipt => receipt.state === "paused");
    if (pending) {
      refreshHeadroom(turn, pending);
      if (pending.dimension !== "free_space_floor" && fs.free < floor) {
        const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension: "free_space_floor", count: fs.free, cap: floor,
          overshoot: floor - fs.free, frozen: pending.frozen, observedAt: now(), state: "paused", reason: "Free space fell below its floor while this turn was paused. Stop only." };
        turn.summary.receipts.push(receipt);
        scopeEvent(turnId, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: turn.model?.() ?? null, profile: turn.profile,
          dedupeKey: receipt.eventId, payload: { cap: receipt.dimension, limit: floor, observed: fs.free, overshoot: receipt.overshoot,
            frozen: receipt.frozen, outcome: "paused", source: "default" } });
      }
      // A pending content grant cannot bypass an independently breached or
      // unmeasurable index cap from this same observation.
      if (fs.free >= floor && pending.dimension !== "free_space_floor" && pending.result !== "index_capacity" && !turn.summary.receipts.some(item => item.state === "paused" && item.result === "index_capacity") && turn.summary.indexBytes !== undefined &&
          (turn.summary.indexBytes === null || turn.summary.indexBytes > turn.summary.indexLimitBytes!)) {
        const cap = turn.summary.indexLimitBytes!, count = turn.summary.indexBytes ?? 0;
        const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension: "turn_bytes", result: "index_capacity", count, cap,
          overshoot: Math.max(0, count - cap), frozen: pending.frozen, observedAt: now(), state: "paused" };
        refreshHeadroom(turn, receipt); turn.summary.receipts.push(receipt);
        scopeEvent(turnId, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: turn.model?.() ?? null, profile: turn.profile,
          dedupeKey: receipt.eventId, payload: { cap: "turn_bytes", result: "index_capacity", limit: cap, observed: count, ...(receipt.measurement ? { measurement: receipt.measurement } : {}), overshoot: receipt.overshoot,
            frozen: receipt.frozen, outcome: "paused", source: "default" } });
      }
      // A peer can add shared content while an index-paused worker is frozen.
      // Discover that independent limit before granting the index continuation.
      if (fs.free >= floor && pending.result === "index_capacity") {
        const content: [Exclude<ScopeDimension, "free_space_floor">, number | null][] = [["tool_calls", turn.summary.calls], ["minutes", turn.summary.minutes],
          ["files_changed", turn.filesChanged], ["turn_bytes", turn.summary.observedBytes]];
        for (const [dimension, count] of content) {
          const cap = turn.summary.limits[dimension];
          if (count === null || count < cap || turn.summary.receipts.some(item => item.state === "paused" && item.dimension === dimension && !item.result)) continue;
          const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension, count, cap, overshoot: Math.max(0, count - cap), frozen: pending.frozen, observedAt: now(), state: "paused" };
          refreshHeadroom(turn, receipt); turn.summary.receipts.push(receipt);
          scopeEvent(turnId, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: turn.model?.() ?? null, profile: turn.profile,
            dedupeKey: receipt.eventId, payload: { cap: dimension, limit: cap, observed: count, ...(receipt.measurement ? { measurement: receipt.measurement } : {}), overshoot: receipt.overshoot, frozen: receipt.frozen, outcome: "paused", source: turn.source } });
          break;
        }
      }
      if (options.connected(turn.sessionId)) turn.disconnectedAt = undefined;
      else turn.disconnectedAt ??= now();
      if (turn.disconnectedAt !== undefined && now() - turn.disconnectedAt >= SCOPE_DISCONNECTED_MS)
        stop(turnId, turn, pending, "ended_before_answer", "No authorized client was connected for 30 minutes.");
      save(turnId, turn); return;
    }
    if (turn.checking) return;
    const counts: [ScopeDimension, number | null, "index_capacity"?][] = [["free_space_floor", fs.free], ["tool_calls", turn.summary.calls],
      ["minutes", turn.summary.minutes], ["files_changed", turn.filesChanged], ["turn_bytes", turn.summary.observedBytes],
      ...(turn.summary.indexBytes !== undefined ? [["turn_bytes", turn.summary.indexBytes, "index_capacity"] as [ScopeDimension, number | null, "index_capacity"]] : [])];
    for (const [dimension, count, result] of counts) {
      const cap = result ? turn.summary.indexLimitBytes! : dimension === "free_space_floor" ? floor : turn.summary.limits[dimension];
      if (result ? count !== null && count <= cap : count === null || (dimension === "free_space_floor" ? count >= cap : count < cap)) continue;
      const hold = timing(() => options.journal.scopeHold?.(turnId, stamp() ?? Date.now(), cause.toolUseId, cause.changedPaths ?? null));
      if (hold) scopeCapRecords.set(turnId, hold);
      let frozen = false, freezeFailure: string | undefined;
      try { const results = [...turn.workers].map(worker => {
        const result = freeze(worker);
        if (hold && confirmed(worker)) timing(() => { attachStopped(hold, [worker], confirmedStops.get(worker) ?? null); overlap(hold, () => options.journal.inferenceInFlight?.(turnId)); });
        return result;
      }); frozen = results.some(Boolean); }
      catch (error) { freezeFailure = `Scope freeze failed; the turn stopped: ${String(error)}`; for (const worker of turn.workers) worker.kill("SIGKILL"); }
      // No worker means no proven pause; fail closed, never claim nothing is running.
      // A periodic snapshot was already taken after our confirmed hold.
      if (frozen && !periodicHeld.has(turnId)) {
        turn.checking = true;
        void options.journal.observe({ turnId, ...(cause.toolUseId ? { toolUseId: cause.toolUseId } : {}), ...(hold ? { hold } : {}) }).catch(error => {
          for (const worker of turn.workers) worker.kill("SIGKILL");
          if (turn.current()) turn.stop(`Scope observation failed; the turn stopped. ${String(error)}`);
        }).finally(() => { turn.checking = false; });
      }
      turn.summary.minutes = Math.max(0, (now() - turn.startedAt) / 60_000);
      const measured = result ? turn.summary.indexBytes : dimension === "tool_calls" ? turn.summary.calls : dimension === "minutes" ? turn.summary.minutes
        : dimension === "files_changed" ? turn.filesChanged : dimension === "turn_bytes" ? turn.summary.observedBytes : space().free;
      const observed = result ? measured ?? 0 : measured ?? count ?? cap;
      const receipt: ScopeCapReceipt = { eventId: randomUUID(), dimension, ...(result ? { result } : {}), count: observed, cap,
        overshoot: Math.max(0, dimension === "free_space_floor" ? cap - observed : observed - cap), frozen, observedAt: now(), state: "paused" };
      refreshHeadroom(turn, receipt);
      turn.summary.receipts.push(receipt);
      scopeEvent(turnId, { kind: "scope_cap", turnId, sessionId: turn.sessionId, actor: turn.origin, model: turn.model?.() ?? null, profile: turn.profile,
        dedupeKey: receipt.eventId, payload: { cap: dimension, ...(result ? { result } : {}), limit: cap, observed, ...(receipt.measurement ? { measurement: receipt.measurement } : {}), overshoot: receipt.overshoot,
          frozen, outcome: turn.origin === "voice" ? "voice_stopped" : frozen ? "paused" : "stopped", source: result ? "default" : turn.source } });
      if (turn.origin === "voice") stop(turnId, turn, receipt, "voice_stopped", receipt.measurement === "unknown" ? "I stopped because the index size could not be measured. Ask again once it can be confirmed." : `I stopped because this turn reached its limit of ${cap} ${dimension === "tool_calls" ? "tool calls" : dimension === "minutes" ? "wall minutes" : dimension === "files_changed" ? "distinct changed paths" : "bytes"}${dimension === "free_space_floor" ? " of free space" : ""}. Ask again to carry on.`);
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
  const holdRecords = new Map<string, ActivityTurnHold[]>();
  const intervals = new Set<JournalHold>();
  function recordStop(hold: JournalHold, turnId: string, workers: Worker[]) {
    if (!workers.length) return;
    hold.stoppedTurns.add(turnId);
    const record = hold.participant(turnId);
    if (record) {
      for (const worker of workers) attachStopped(record, [worker], confirmedStops.get(worker) ?? null);
      overlap(record, () => hold.inferenceInFlight(turnId));
      const records = holdRecords.get(turnId) ?? [];
      if (!records.includes(record)) records.push(record);
      holdRecords.set(turnId, records);
    }
    for (const [id, item] of hold.records) item.otherTurnsStopped = [...hold.stoppedTurns].filter(other => other !== id).length;
  }
  function recordStops(hold?: JournalHold) {
    if (!hold) return;
    for (const [id, entry] of periodicHeld) recordStop(hold, id, entry.workers.filter(worker => entry.turn.workers.has(worker) && confirmed(worker)));
  }
  function resumeWorkers(turnId: string, workers: Worker[]) {
    for (const worker of workers) {
      const acknowledged = worker.resume();
      confirmedStops.delete(worker);
      if (acknowledged !== true) continue;
      timing(() => {
        const at = stamp();
        for (const record of new Set([...(holdRecords.get(turnId) ?? []), ...(scopeCapRecords.has(turnId) ? [scopeCapRecords.get(turnId)!] : [])])) {
          if (record.stoppedAt !== null && stoppedWorkers.get(record)?.has(worker)) record.resumedAt ??= at;
        }
      });
    }
    holdRecords.delete(turnId); scopeCapRecords.delete(turnId);
  }
  const periodic = {
    before(hold?: JournalHold) {
      if (hold) intervals.add(hold);
      if (observationHolds++ > 0) { timing(() => recordStops(hold)); return; }
      observationFailed = false;
      for (const [turnId, turn] of active) {
        if (!turn.current() || turn.summary.receipts.some(receipt => receipt.state === "paused")) continue;
        const held: Worker[] = []; periodicHeld.set(turnId, { turn, workers: held });
        for (const worker of turn.workers) { held.push(worker); freeze(worker); }
        if (hold) timing(() => recordStop(hold, turnId, held.filter(confirmed)));
      }
    },
    after(completed: boolean, hold?: JournalHold) {
      if (hold) intervals.delete(hold);
      observationFailed ||= !completed;
      if (--observationHolds > 0) return;
      completed &&= !observationFailed;
      for (const [turnId, { turn, workers }] of periodicHeld) {
        // Storage/reporting may itself fail before the journal's stop callback.
        // A failed capture never resumes a productive temporary hold.
        if (!completed) {
          for (const worker of workers) worker.kill("SIGKILL");
          if (turn.current()) turn.stop("Scope observation failed; the turn stopped. Partial work remains.");
          continue;
        }
        if (turn.summary.receipts.some(receipt => receipt.state === "paused") && turn.current()) continue;
        if (!turn.current()) { for (const worker of workers) worker.kill("SIGKILL"); continue; }
        try {
          const live = workers.filter(worker => turn.workers.has(worker));
          resumeWorkers(turnId, live);
        }
        catch (error) {
          for (const worker of turn.workers) worker.kill("SIGKILL");
          turn.stop(`The host could not resume the worker after scope observation; it stopped. Partial work remains. ${String(error)}`);
        }
      }
      periodicHeld.clear();
      intervals.clear();
    },
  };
  const unsubscribe = options.journal.onObservation((turnId, facts) => {
    const turn = active.get(turnId); if (!turn) return;
    // The summary discloses every changed path; files_changed leaves out the
    // workspaces/ scratch, which turn_bytes and the free-space floor still bound.
    turn.summary.changedPaths = facts.partial ? null : facts.changedPaths;
    turn.filesChanged = facts.partial ? null : facts.changedPaths - facts.workspacePaths;
    turn.summary.observedBytes = facts.partial ? null : facts.observedBytes;
    turn.checkoutBytes = facts.checkoutBytes;
    if (turn.liveIndexWritable && facts.indexBytes !== undefined) turn.summary.indexBytes = facts.indexBytes;
    turn.summary.coverage = facts.partial ? "partial" : "observed_versions";
    turn.summary.observedAt = now(); check(turnId, turn, { toolUseId: facts.observationToolUseId, changedPaths: facts.observationChangedPaths });
  }, periodic);
  return {
    begin(turnId: string, input: { sessionId: string | null; principalId: string; origin: Live["origin"]; profile: Live["profile"];
      policy: EffectiveGovernancePolicy; source: Live["source"]; liveIndexWritable?: boolean; hardTimeoutMs: number; current: () => boolean; model?: () => string | null; stop: Live["stop"] }) {
      const liveIndexWritable = input.liveIndexWritable ?? input.profile === "governed";
      const summary: TurnScopeSummary = { ...(liveIndexWritable ? { indexLimitBytes: INDEX_OBSERVATION_CAP_BYTES } : {}), policySource: input.source, limits: scopeLimits(input.policy), hardTimeoutMs: input.hardTimeoutMs, calls: 0, minutes: 0,
        changedPaths: null, observedBytes: null, coverage: "partial", observedAt: now(), receipts: [] };
      const turn: Live = { ...input, liveIndexWritable, startedAt: now(), summary, filesChanged: null, workers: new Set(), calls: new Set() };
      active.set(turnId, turn);
      // The turn starts only once its row has committed; refused, it never runs.
      return call(turnId, "insert", input.sessionId, input.principalId, JSON.stringify(summary)).then(() => {}, (error: unknown) => {
        if (active.get(turnId) === turn) active.delete(turnId);
        throw error;
      });
    },
    workerStarted(turnId: string, worker: Worker) {
      const turn = active.get(turnId); if (!turn || !turn.current()) { worker.kill("SIGKILL"); return; }
      turn.workers.add(worker);
      void worker.exited.finally(() => { turn.workers.delete(worker); confirmedStops.delete(worker); }).catch(() => {});
      if (turn.summary.receipts.some(receipt => receipt.state === "paused") || observationHolds > 0) {
        freeze(worker);
        const cap = scopeCapRecords.get(turnId);
        if (cap && confirmed(worker)) timing(() => { attachStopped(cap, [worker], confirmedStops.get(worker) ?? null); overlap(cap, () => options.journal.inferenceInFlight?.(turnId)); });
        if (observationHolds > 0) {
          const held = periodicHeld.get(turnId) ?? { turn, workers: [] };
          held.workers.push(worker); periodicHeld.set(turnId, held);
          if (confirmed(worker)) for (const interval of intervals) timing(() => recordStop(interval, turnId, [worker]));
        }
      }
    },
    bindSession(turnId: string, sessionId: string) { const turn = active.get(turnId); if (turn) { turn.sessionId = sessionId; save(turnId, turn); } },
    toolCall(turnId: string, toolUseId: string) {
      const turn = active.get(turnId); if (!turn || turn.calls.has(toolUseId)) return;
      turn.calls.add(toolUseId); turn.summary.calls = turn.calls.size; check(turnId, turn, { toolUseId });
    },
    isPaused(turnId: string) { return active.get(turnId)?.summary.receipts.some(receipt => receipt.state === "paused") ?? false; },
    /**
     * Settles once every scope write the turn made before the decision has
     * committed, the decision has run against its committed row, and the
     * writes the decision made have committed too (#2850).
     */
    async decide(msg: ClientScopeDecision, authorized: boolean): Promise<ServerScopeDecisionReceipt> {
      if (!authorized) return { ...msg, type: "scope_decision_receipt", state: "refused", reason: "Current authenticated authority is required." };
      // Checked again after every wait, with nothing awaited between the last
      // check and the decision: a concurrent one waits for this one's writes.
      for (let tail = tails.get(msg.turnId); tail; tail = tails.get(msg.turnId)) await tail;
      const receipt = decideCommitted(msg);
      for (let tail = tails.get(msg.turnId); tail; tail = tails.get(msg.turnId)) await tail;
      return receipt;
    },
    /** Settles once the turn's final summary and end have committed. */
    finish(turnId: string): Promise<boolean> {
      const turn = active.get(turnId); if (!turn) return Promise.resolve(false);
      for (const receipt of turn.summary.receipts) if (receipt.state === "paused") { receipt.state = "ended_before_answer"; receipt.reason = "The turn ended before an answer."; }
      const saved = save(turnId, turn), ended = call(turnId, "end", now()).then(stored => stored === true, error => { unrecorded(turnId, error); return false; });
      active.delete(turnId);
      holdRecords.delete(turnId);
      scopeCapRecords.delete(turnId);
      return Promise.all([saved, ended]).then(results => results.every(Boolean));
    },
    close() { unsubscribe(); for (const [id, turn] of active) { for (const worker of turn.workers) worker.kill("SIGKILL"); turn.stop("Host closed; the turn was interrupted."); this.finish(id); } },
  };
  /** A decision, synchronous from its read of the committed row through the writes it submits. */
  function decideCommitted(msg: ClientScopeDecision): ServerScopeDecisionReceipt {
    const response = (state: ServerScopeDecisionReceipt["state"], reason?: string): ServerScopeDecisionReceipt => ({ ...msg, type: "scope_decision_receipt", state, ...(reason ? { reason } : {}) });
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
    if (msg.action === "continue" && receipt.newCap !== turn.summary.receipts.find(item => item.eventId === msg.eventId)?.newCap)
      return response("refused", "This continuation offer no longer matches the live turn.");
    // A grant cannot bypass a floor that another writer crossed while this worker waited.
    if (msg.action === "continue") check(msg.turnId, turn);
    if (!turn.current()) return response("ended_before_answer");
    const latestPause = turn.summary.receipts.findLast(receipt => receipt.state === "paused");
    if (msg.action === "continue" && latestPause?.eventId !== msg.eventId) return response("refused", "Another independent scope limit must be answered first.");
    const liveReceipt = turn.summary.receipts.find(receipt => receipt.eventId === msg.eventId)!;
    if (msg.action === "continue" && (liveReceipt.newCap === undefined || turn.checking || observationHolds > 0))
      return response("refused", liveReceipt.reason ?? "This limit permits Stop only while continuation headroom is unconfirmed.");
    try {
      if (msg.action === "continue") {
        // Grant is consumed before resumption; a failed resume cannot issue another increment.
        if (liveReceipt.result === "index_capacity") turn.summary.indexLimitBytes = liveReceipt.newCap!;
        else turn.summary.limits[liveReceipt.dimension as Exclude<ScopeDimension,"free_space_floor">] = liveReceipt.newCap!;
        liveReceipt.state = "continued"; liveReceipt.submissionId = msg.submissionId; save(msg.turnId, turn);
        if (observationHolds === 0 && !turn.summary.receipts.some(item => item.state === "paused")) {
          const workers = [...turn.workers];
          resumeWorkers(msg.turnId, workers);
        }
      } else { liveReceipt.submissionId = msg.submissionId; stop(msg.turnId, turn, liveReceipt, "stopped", "You stopped the turn at its scope limit."); }
      return response("accepted");
    } catch (error) {
      stop(msg.turnId, turn, liveReceipt, "ended_before_answer", "The host could not resume the worker; it stopped. Partial work remains.");
      return response("failed", String(error));
    }
  }
}
export type TurnScope = ReturnType<typeof createTurnScope>;
