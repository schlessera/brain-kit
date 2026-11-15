/**
 * #2915: attribute a journal observation's hold, and journal begin and finish,
 * to their steps on one clock. The app child stamps its journal trace and the
 * fixture's manager stamps its spans with `performance.timeOrigin +
 * performance.now()`; a manager request counts toward an app step only when
 * it arrived inside that step, and each pairing's slack is kept as the proof
 * that the two processes' clocks agree.
 */

export interface TraceStep { name: string; startedAt: number; endedAt: number | null }
export interface ObservationTrace { kind: string; turnId: string | null; toolUseId?: string; steps: TraceStep[] }
export interface ManagerSpan { request: number; operation: string; phase: string; startedAt: number; endedAt: number; holder?: string | null }

/** Steps that contain other steps; every other step is a leaf, and leaves never overlap. */
const CONTAINERS = new Set(["hold", "observe"]);
/** The manager operation an app step calls, for its finer breakdown. */
const NATIVE_STEPS: Record<string, string> = { observe_checkpoint: "checkpoint", observe_delta: "delta" };

export interface ObservationPhases {
  /** The traced hold, `hold` itself. */
  holdMs: number;
  /** Leaf steps, a repeated name summed. */
  phases: Record<string, number>;
  /** Each app step's manager request: its spans by phase, `transport` outside the manager and `other` inside it but in no span. */
  native: Record<string, number>;
  /** The operation that held the manager lock when each native request began to wait, with the time waited. */
  lockWaits: { step: string; holder: string | null; ms: number }[];
  attributedMs: number;
  incomplete: string[];
  clock: { paired: number; unpaired: string[]; minStartSlackMs: number | null; minEndSlackMs: number | null };
}

const duration = (step: { startedAt: number; endedAt: number | null }) => step.endedAt === null ? 0 : Math.max(0, step.endedAt - step.startedAt);
const add = (into: Record<string, number>, key: string, ms: number) => { into[key] = (into[key] ?? 0) + ms; };

export function observationPhases(trace: ObservationTrace, spans: readonly ManagerSpan[]): ObservationPhases {
  const hold = trace.steps.find(step => step.name === "hold");
  if (!hold || hold.endedAt === null) throw Error(`OBSERVATION_TRACE_HAS_NO_ENDED_HOLD ${trace.kind} ${trace.turnId}`);
  const phases: Record<string, number> = {}, native: Record<string, number> = {}, incomplete: string[] = [], unpaired: string[] = [];
  const lockWaits: ObservationPhases["lockWaits"] = [];
  let minStartSlackMs: number | null = null, minEndSlackMs: number | null = null, paired = 0;
  const requests = new Map<number, ManagerSpan[]>();
  for (const span of spans) requests.set(span.request, [...(requests.get(span.request) ?? []), span]);
  for (const step of trace.steps) {
    if (CONTAINERS.has(step.name)) continue;
    if (step.endedAt === null) { incomplete.push(step.name); continue; }
    add(phases, step.name, duration(step));
    const operation = NATIVE_STEPS[step.name];
    if (!operation) continue;
    // The one request of that operation which arrived inside this step.
    const matches = [...requests.values()].filter(request => {
      const wait = request.find(span => span.phase === "lock_wait");
      return request[0]!.operation === operation && wait && wait.startedAt >= step.startedAt && wait.startedAt <= step.endedAt!;
    });
    if (matches.length !== 1) { unpaired.push(`${step.name}:${matches.length}`); continue; }
    const request = matches[0]!, wait = request.find(span => span.phase === "lock_wait")!, lock = request.find(span => span.phase === "held");
    paired++;
    const startSlack = wait.startedAt - step.startedAt;
    minStartSlackMs = minStartSlackMs === null ? startSlack : Math.min(minStartSlackMs, startSlack);
    lockWaits.push({ step: step.name, holder: wait.holder ?? null, ms: duration(wait) });
    let inside = 0;
    for (const span of request) {
      if (span.phase === "held") continue;
      add(native, `${operation}.${span.phase}`, duration(span));
      if (span.phase !== "lock_wait") inside += duration(span);
    }
    if (lock) {
      add(native, `${operation}.other`, Math.max(0, duration(lock) - inside));
      // A control response returns before its step ends; a streamed send may end with it.
      if (operation === "checkpoint") {
        const endSlack = step.endedAt! - lock.endedAt;
        minEndSlackMs = minEndSlackMs === null ? endSlack : Math.min(minEndSlackMs, endSlack);
      }
      add(native, `${operation}.transport`, Math.max(0, duration(step) - (lock.endedAt - wait.startedAt)));
    }
  }
  const attributedMs = Object.values(phases).reduce((sum, ms) => sum + ms, 0);
  return { holdMs: duration(hold), phases, native, lockWaits, attributedMs, incomplete, clock: { paired, unpaired, minStartSlackMs, minEndSlackMs } };
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
export const median = (values: number[]) => values.length ? sorted(values)[Math.floor(values.length / 2)]! : null;
export const p95 = (values: number[]) => values.length ? sorted(values)[Math.ceil(values.length * 0.95) - 1]! : null;
const round = (value: number | null) => value === null ? null : Math.round(value * 10) / 10;

export interface PhaseSample { phases: ObservationPhases; /** The independently measured hold or call: freeze to resume, or the journal method's own time. */ measuredMs: number | null }

/**
 * Per-phase medians over the samples, a phase absent from a sample counting as
 * zero, and the coverage of each sample: attributed leaf time over its measured
 * time (the traced hold when nothing else measured it).
 */
export function summarizePhases(samples: readonly PhaseSample[]) {
  const names = (pick: (sample: PhaseSample) => Record<string, number>) => [...new Set(samples.flatMap(sample => Object.keys(pick(sample))))];
  const table = (pick: (sample: PhaseSample) => Record<string, number>) => Object.fromEntries(names(pick).map(name => {
    const values = samples.map(sample => pick(sample)[name] ?? 0);
    return [name, { medianMs: round(median(values)), p95Ms: round(p95(values)), present: samples.filter(sample => name in pick(sample)).length }];
  }));
  const coverage = samples.map(sample => sample.phases.attributedMs / (sample.measuredMs ?? sample.phases.holdMs));
  const holders: Record<string, number> = {};
  for (const sample of samples) for (const wait of sample.phases.lockWaits) if (wait.ms >= 1) holders[`${wait.step}:${wait.holder ?? "none"}`] = (holders[`${wait.step}:${wait.holder ?? "none"}`] ?? 0) + 1;
  const measured = samples.map(sample => sample.measuredMs).filter((value): value is number => value !== null);
  const startSlacks = samples.map(sample => sample.phases.clock.minStartSlackMs).filter((value): value is number => value !== null);
  const endSlacks = samples.map(sample => sample.phases.clock.minEndSlackMs).filter((value): value is number => value !== null);
  return {
    samples: samples.length,
    measured: { medianMs: round(median(measured)), p95Ms: round(p95(measured)), samples: measured.length },
    hold: { medianMs: round(median(samples.map(sample => sample.phases.holdMs))), p95Ms: round(p95(samples.map(sample => sample.phases.holdMs))) },
    attributed: { medianMs: round(median(samples.map(sample => sample.phases.attributedMs))) },
    unattributed: { medianMs: round(median(samples.map(sample => (sample.measuredMs ?? sample.phases.holdMs) - sample.phases.attributedMs))) },
    coverage: { medianPct: round(median(coverage) === null ? null : median(coverage)! * 100), minPct: round(coverage.length ? Math.min(...coverage) * 100 : null) },
    phases: table(sample => sample.phases.phases),
    native: table(sample => sample.phases.native),
    /** Native requests that waited at least 1 ms, by step and the operation they waited behind. */
    lockWaitsBehind: holders,
    incomplete: samples.filter(sample => sample.phases.incomplete.length).length,
    clock: { paired: samples.reduce((sum, sample) => sum + sample.phases.clock.paired, 0), unpaired: samples.flatMap(sample => sample.phases.clock.unpaired),
      minStartSlackMs: round(startSlacks.length ? Math.min(...startSlacks) : null), minEndSlackMs: round(endSlacks.length ? Math.min(...endSlacks) : null) },
  };
}
