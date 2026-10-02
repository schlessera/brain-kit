import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apply, eventSchema, inspect, type Event, type Lab } from "./prototype";
import { cases, DAY, prepare, schedule } from "./fixtures";
import { getMarkdownFiles, indexAll } from "../../../packages/core/src/lib/indexer";
import { openDatabase } from "../../../packages/core/src/lib/db";
import { generateBriefing } from "../../../packages/core/src/cli/commands/briefing";

export function sequence(entity: string): Event[] {
  const first = schedule(entity);
  return [
    first,
    { ...first, id: "move-screen", kind: "rebooked", startsAt: "2026-07-22T10:00:00+02:00" },
    { ...schedule(entity, "technical", "book-technical"), round: "Technical", startsAt: "2026-07-25T14:00:00+02:00" },
    { id: "cancel-screen", kind: "cancelled", opportunity: entity, on: DAY, roundId: "screen", reason: "Screening no longer needed", resumeStage: "applied" },
    { id: "offer", kind: "offer", opportunity: entity, on: DAY, nextStep: "Review written offer", deadline: "2026-08-01" },
    { id: "close", kind: "closed", opportunity: entity, on: DAY, reason: "Offer declined" },
  ];
}
export function snapshot(lab: Lab): Record<string, string> {
  return Object.fromEntries(getMarkdownFiles(lab.root, lab.taxonomy).sort().map(path => [path, readFileSync(join(lab.root, path), "utf8")]));
}
export async function runCase(c: typeof cases[number]) {
  const { lab, dir, focus, focusBefore } = prepare(c.entity, c.custom, c.prep, c.fallback);
  const checkpoints: Record<string, string>[] = [];
  const samples: number[] = [];
  let deadlineErrors = 0, briefingErrors = 0, unintendedEdits = 0, replayWrites = 0;
  const initial = snapshot(lab);
  const dates = ["2026-07-20", "2026-07-22", "2026-07-22", "2026-07-25", "2026-08-01", null];
  try {
    for (const [i, event] of sequence(c.entity).entries()) {
      const started = performance.now();
      const oldFocus = i === 0 ? focusBefore : readFileSync(join(lab.root, focus), "utf8").split("\n").find(l => l.startsWith("- [["))!;
      const inspection = inspect(lab, event, oldFocus);
      if (inspection.outcome !== "planned") throw new Error(`${c.id}: ${inspection.reason}`);
      const result = apply(lab, inspection.plan, true);
      if (result.outcome !== "applied") throw new Error(`${c.id}: ${result.outcome}`);
      const dbPath = join(lab.root, "brain.db");
      const db = openDatabase(dbPath);
      let actual: Array<{ path: string; deadline: string }>;
      try {
        await indexAll(db, { root: lab.root, taxonomy: lab.taxonomy, quiet: true, embeddings: false, force: true });
        actual = db.query("SELECT path, deadline FROM documents WHERE deadline IS NOT NULL ORDER BY path").all() as typeof actual;
      } finally { db.close(); }
      const status = `${dir}/${c.entity}/status.md`, prep = `${dir}/${c.entity}/interview-prep.md`;
      const expected = dates[i] === null ? [] : (event.kind === "offer" ? [status] : [prep, status]).map(path => ({ path, deadline: dates[i] }));
      deadlineErrors += Number(JSON.stringify(actual) !== JSON.stringify(expected));
      const briefing = await generateBriefing({ root: lab.root, dbPath, config: lab.config, configPath: null, modules: [], taxonomy: lab.taxonomy }, 15, { now: new Date(`${DAY}T12:00:00Z`) });
      const upcoming = briefing.includes("## Upcoming Deadlines") ? briefing.split("## Upcoming Deadlines")[1]!.split("\n## ")[0]! : "";
      briefingErrors += Number(expected.some(row => !upcoming.includes(`${row.deadline} | ${row.path}`)) || actual.length === 0 && upcoming !== "");
      samples.push(performance.now() - started);
      const files = snapshot(lab);
      const allowed = new Set([status, prep, focus, `${dir}/_index.md`]);
      unintendedEdits += Object.keys(files).filter(path => !allowed.has(path) && files[path] !== initial[path]).length;
      checkpoints.push(files);
      // Replay each event, not just closure. It must have no file writes.
      const replay = inspect(lab, event, oldFocus);
      if (replay.outcome !== "planned") throw new Error(`${c.id}: replay ${replay.reason}`);
      replayWrites += apply(lab, replay.plan, true).written.length;
    }
    return { checkpoints, samples, deadlineErrors, briefingErrors, unintendedEdits, replayWrites };
  } finally { lab.close(); }
}
type Expected = Record<string, Record<string, string>[]>;
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! * 100) / 100;
}
export async function controlReport(repetitions = 5) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("repeat must be an integer from 1 to 20");
  const expectedText = readFileSync(join(import.meta.dir, "expected.json"), "utf8");
  const expected = JSON.parse(expectedText) as Expected;
  const samples: number[] = [];
  const results: Array<{ id: string; split: string; repetitions: number; exactDiffMismatchedFiles: number; deadlineErrors: number; briefingErrors: number; unintendedEdits: number; replayWrites: number }> = [];
  for (const c of cases) {
    let exactDiffMismatchedFiles = 0, deadlineErrors = 0, briefingErrors = 0, unintendedEdits = 0, replayWrites = 0;
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const result = await runCase(c); samples.push(...result.samples);
      deadlineErrors += result.deadlineErrors; briefingErrors += result.briefingErrors;
      unintendedEdits += result.unintendedEdits; replayWrites += result.replayWrites;
      for (const [i, files] of result.checkpoints.entries()) {
        const wanted = expected[c.id]?.[i];
        if (!wanted) throw new Error(`missing proposed golden ${c.id}/${i}`);
        exactDiffMismatchedFiles += [...new Set([...Object.keys(files), ...Object.keys(wanted)])].filter(path => files[path] !== wanted[path]).length;
      }
    }
    results.push({ id: c.id, split: c.split, repetitions, exactDiffMismatchedFiles, deadlineErrors, briefingErrors, unintendedEdits, replayWrites });
  }
  const fixtureSha256 = createHash("sha256").update(readFileSync(join(import.meta.dir, "fixtures.ts"))).update(JSON.stringify(cases.map(c => sequence(c.entity)))).digest("hex");
  return {
    mode: "keyless controls; proposed goldens are not independently reviewed",
    fixtureSha256, expectedSha256: createHash("sha256").update(expectedText).digest("hex"),
    schemaSha256: createHash("sha256").update(JSON.stringify(zodJson())).digest("hex"),
    prototypeSha256: createHash("sha256").update(readFileSync(join(import.meta.dir, "prototype.ts"))).digest("hex"),
    runtime: `Bun ${Bun.version}`, sequences: cases.length, eventsPerSequence: 6, repetitions,
    observations: samples.length, results,
    localMs: { scope: "inspect + apply + pipeline + index + briefing; excludes lab setup and replay", p50: quantile(samples, .5), p95: quantile(samples, .95), min: quantile(samples, 0.01), max: quantile(samples, 1), throughputEventsPerSecond: Math.round(samples.length / (samples.reduce((a, b) => a + b, 0) / 1000) * 100) / 100 },
    deterministic: { inferenceCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedCostUsd: 0, classifierThresholds: null },
    today: { skillExecutionCalls: null, tokens: null, billedCostUsd: null, p50Ms: null, p95Ms: null },
    hybrid: { naturalLanguageMapping: "not run; explicit structured input uses the deterministic lane", model: null, quality: null, costUsd: null },
    live: { callsSaved: null, timeSavedMs: null, costSavedUsd: null, coldWarmCacheComparison: null, modelSensitivity: null },
    adoption: "unresolved; keyless controls do not establish comparative savings or unattended safety",
  };
}
function zodJson() { return eventSchema.toJSONSchema(); }
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--repeat")) throw new Error("usage: bun scripts/evals/opportunity-lifecycle/run.ts [--repeat 1..20]");
  const report = await controlReport(args.length ? Number(args[1]) : 5);
  console.log(JSON.stringify(report, null, 2));
  if (report.results.some(r => r.exactDiffMismatchedFiles || r.deadlineErrors || r.briefingErrors || r.unintendedEdits || r.replayWrites)) process.exitCode = 1;
}
