import type { Database } from "bun:sqlite";
import type { ActivityTurnLifecycle as Lifecycle, ActivityTurnOpenSubPhase } from "@schlessera/brain-ui-sdk/protocol";
import { lifecycleTiming } from "./turn-lifecycle.js";

interface Samples { values: number[]; open: number; present: number }
const samples = (): Samples => ({ values: [], open: 0, present: 0 });

function stats(sample: Samples, turns: number) {
  const values = sample.values.sort((a, b) => a - b), count = values.length;
  return { count, median: count ? (values[Math.floor((count - 1) / 2)]! + values[Math.floor(count / 2)]!) / 2 : null,
    p90: count ? values[Math.ceil(count * .9) - 1]! : null, max: count ? values[count - 1]! : null,
    open: sample.open, absent: turns - sample.present };
}

const intervals = [
  ["totalElapsedMs", "acceptedAt", "endedAt"], ["queueWaitMs", "acceptedAt", "dequeuedAt"],
  ["timeToFirstFrameMs", "acceptedAt", "firstFrameAt"], ["governedAdmissionMs", "governedStartedAt", "governedAcquiredAt"],
  ["budgetAdmissionMs", "budgetStartedAt", "budgetAdmittedAt"], ["journalBeginMs", "journalStartedAt", "journalBeganAt"],
  ["backendStartupMs", "backendInvokedAt", "firstFrameAt"], ["timeToFirstRelayMs", "backendInvokedAt", "firstRelayRequestAt"],
  ["terminalToRecorderMs", "endedAt", "recorderSettledAt"], ["terminalToIdleMs", "endedAt", "idleEmittedAt"],
] as const;

function summarize(records: Lifecycle[], vocabulary: ReadonlyMap<string, { phase: string; name: string }>) {
  const first = records[0]!;
  const durations = new Map(intervals.map(([key]) => [key, samples()]));
  const steps = new Map<string, Samples>();
  const metrics = new Map<string, Samples>(), frequencies = new Map<string, number>();
  for (const record of records) {
    const seenSteps = new Set<string>(), seenMetrics = new Set<string>();
    const metric = (key: string, value: number | undefined) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      let sample = metrics.get(key);
      if (!sample) { sample = samples(); metrics.set(key, sample); }
      sample.values.push(value);
      if (!seenMetrics.has(key)) { seenMetrics.add(key); sample.present++; }
    };
    const frequency = (key: string) => frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
    for (const [name, from, to] of intervals) {
      const end = record[to], sample = durations.get(name)!;
      // Older records prove they were queued only if they reached dequeue.
      const start = name === "queueWaitMs" ? record.queuedAt ?? (end != null ? record.acceptedAt : undefined) : record[from];
      if (start == null || end === undefined) continue;
      sample.present++;
      if (end == null) sample.open++;
      else sample.values.push(Math.max(0, end - start));
    }
    const observedSteps: ActivityTurnOpenSubPhase[] = [...(record.subPhases ?? []), ...(record.openSubPhases ?? [])];
    for (const step of observedSteps) {
      const key = JSON.stringify([step.phase, step.name]);
      let sample = steps.get(key);
      if (!sample) { sample = samples(); steps.set(key, sample); }
      if (!seenSteps.has(key)) { seenSteps.add(key); sample.present++; }
      if (step.endedAt === null) sample.open++;
      else if (step.timeBase !== "worker") sample.values.push(Math.max(0, step.endedAt - step.startedAt));
      else if (typeof step.workerElapsedMs === "number") sample.values.push(step.workerElapsedMs);
      if (step.aliasScan) {
        metric(step.name + ".scans", step.aliasScan.scans);
        metric(step.name + ".entries", step.aliasScan.entries);
      }
      if (step.queueAhead) {
        metric("hold_wait.countAhead", step.queueAhead.count);
        for (const kind of step.queueAhead.kinds) frequency("hold_wait.ahead." + kind);
      }
      if (step.indexSettle) {
        const index = step.indexSettle;
        metric("index_settle.queuedPaths", index.queuedPaths);
        metric("index_settle.updates", index.updates);
        metric("index_settle.updateMs", index.updateMs);
        frequency("index_settle.firstAlreadyRunning." + index.firstAlreadyRunning);
        if (index.lastOutcome) frequency("index_settle.lastOutcome." + index.lastOutcome);
      }
    }
    for (const mark of ["atDequeue", "atBackendStart"] as const) {
      metric(mark + ".load1", record.admissionLoad?.[mark]?.load1);
      metric(mark + ".cpuCount", record.admissionLoad?.[mark]?.cpuCount);
    }
    metric("eventLoopMaxMs", record.admissionLoad?.eventLoopMaxMs);
    metric("eventLoopP99Ms", record.admissionLoad?.eventLoopP99Ms);
    for (const field of ["totalMs", "intervals", "sharedHolds", "openHolds", "inferenceMs", "noInferenceMs", "unknownMs"] as const)
      metric("stoppedTime." + field, record.stoppedTime?.[field]);
    for (const server of record.backendMcpInit ?? []) {
      frequency("mcp.status." + server.status);
      frequency("mcp.source." + server.source);
    }
  }
  const turns = records.length;
  return { packageVersion: first.packageVersion ?? null, buildRevision: first.buildRevision ?? null, turns,
    intervals: Object.fromEntries([...durations].map(([name, sample]) => [name, stats(sample, turns)])),
    steps: [...vocabulary].map(([key, identity]) => ({ ...identity, ...stats(steps.get(key) ?? samples(), turns) })),
    measurements: Object.fromEntries([...metrics].map(([name, sample]) => [name, stats(sample, turns)])),
    frequencies: Object.fromEntries(frequencies) };
}

export function turnTimingSummary(db: Database, limit: number, since: number, before: number, origin?: string, outcome?: string) {
  // Select a bounded indexed window before decoding records or resolving their origin.
  const rows = db.query(`WITH recent AS MATERIALIZED (
      SELECT record FROM activity_turn_lifecycles WHERE accepted_at >= ? AND accepted_at < ?
      ORDER BY accepted_at DESC, turn_id LIMIT ?)
    SELECT record FROM recent WHERE (? IS NULL OR json_extract(record,'$.outcome') = ?)
    AND (? IS NULL OR ? = COALESCE(
      (SELECT origin FROM activity_run_rollups WHERE run_id=json_extract(record,'$.backendRunId')),
      (SELECT origin FROM activity_spans WHERE run_id=json_extract(record,'$.backendRunId') AND parent_span_id IS NULL LIMIT 1),
      'unknown'))`).all(since, before, limit, outcome ?? null, outcome ?? null, origin ?? null, origin ?? null) as { record: string }[];
  const groups = new Map<string, Lifecycle[]>(), vocabulary = new Map<string, { phase: string; name: string }>();
  for (const row of rows) {
    const record = lifecycleTiming(JSON.parse(row.record));
    const identity = JSON.stringify([record.packageVersion ?? null, record.buildRevision ?? null]);
    let group = groups.get(identity);
    if (!group) { group = []; groups.set(identity, group); }
    group.push(record);
    for (const { phase, name } of [...(record.subPhases ?? []), ...(record.openSubPhases ?? [])])
      vocabulary.set(JSON.stringify([phase, name]), { phase, name });
  }
  return { limit, groups: [...groups.values()].map(group => summarize(group, vocabulary)) };
}
