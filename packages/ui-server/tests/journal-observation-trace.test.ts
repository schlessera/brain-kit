/** #2915: a held observation reports every step to its diagnostic trace, on one clock, inside its hold. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createTurnJournal, type JournalTraceKind } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

interface Step { name: string; startedAt: number; endedAt: number | null }
interface Trace { kind: JournalTraceKind; turnId: string | null; toolUseId?: string; steps: Step[]; done: boolean }
/** Steps that contain others; every other step is a leaf, and leaves never overlap. */
const CONTAINERS = new Set(["hold", "observe"]);
const OBSERVE = ["observe_reserve", "observe_checkpoint", "observe_delta", "observe_metadata", "observe_capture"];
const RECORD = ["observe_record", "observe_publish", "observe_facts"];

function expectNested(trace: Trace) {
  const hold = trace.steps.find(step => step.name === "hold")!;
  expect(trace.steps[0]?.name, `TRACE_HOLD_STARTS_FIRST ${trace.kind}`).toBe("hold");
  expect(trace.done, `TRACE_HOLD_ENDS_LAST ${trace.kind}`).toBe(true);
  let previous = hold.startedAt;
  for (const step of trace.steps.filter(item => !CONTAINERS.has(item.name))) {
    expect(step.endedAt, `TRACE_STEP_ENDED ${trace.kind} ${step.name}`).not.toBeNull();
    // Sequential leaves: their sum never counts one interval twice.
    expect(step.startedAt, `TRACE_LEAVES_DO_NOT_OVERLAP ${trace.kind} ${step.name}`).toBeGreaterThanOrEqual(previous);
    expect(step.endedAt!, `TRACE_STEP_INSIDE_HOLD ${trace.kind} ${step.name}`).toBeLessThanOrEqual(hold.endedAt!);
    previous = step.endedAt!;
  }
}

test("admission, a writer's result and finish trace each step inside the hold; the lifecycle never sees the hold", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-observation-trace-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes", "ithaca.md"), "# Ithaca\n");
  const traces: Trace[] = [];
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"),
    observationTrace(kind, turnId, toolUseId) {
      const trace: Trace = { kind, turnId, ...(toolUseId ? { toolUseId } : {}), steps: [], done: false };
      traces.push(trace);
      return name => {
        const step: Step = { name, startedAt: performance.now(), endedAt: null };
        trace.steps.push(step);
        return () => { step.endedAt = performance.now(); if (name === "hold") trace.done = true; };
      };
    } });
  const store = createActivityStore(createUiDb(":memory:"));
  const metadata = { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null } as const;
  try {
    await journal.ready;
    await journal.begin("turn-telemachus", metadata, error => { throw error; });
    // A second admission records the active turn's observation, so its record steps apply.
    const lifecycle = createTurnLifecycle(store, "turn-penelope", "ithaca", Date.now(), () => {});
    lifecycle.mark("journalStartedAt");
    await journal.begin("turn-penelope", metadata, error => { throw error; }, undefined, lifecycle.timer("journal"));
    lifecycle.mark("journalBeganAt");
    writeFileSync(join(brain, "notes", "loom.md"), "Penelope weaves.\n");
    journal.toolStarted("turn-penelope", "write-1", "write_file", true);
    journal.toolExecuted("turn-penelope", "write-1", "worker_write");
    await journal.toolEnded("turn-penelope", "write-1");
    await journal.finish("turn-penelope");
    await journal.finish("turn-telemachus");

    expect(traces.map(trace => trace.kind), "TRACE_EVERY_HELD_OBSERVATION").toEqual(["begin", "begin", "tool", "finish", "finish"]);
    const begin = traces.find(trace => trace.kind === "begin" && trace.turnId === "turn-penelope")!;
    const names = (trace: Trace) => trace.steps.map(step => step.name);
    expect(names(begin), "TRACE_BEGIN_STEPS").toEqual(["hold", "hold_wait", "initialize", "observe", ...OBSERVE, ...RECORD, "observe_commit", "expiry", "turn_insert", "policy"]);
    const steps = (store.lifecycle("turn-penelope")!.subPhases ?? []) as NonNullable<ActivityTurnLifecycle["subPhases"]>;
    // The lifecycle keeps its own vocabulary: every traced step but the hold.
    expect(steps.map(step => step.name), "LIFECYCLE_SEES_EVERY_STEP_BUT_THE_HOLD").toEqual(names(begin).slice(1));

    const writer = traces.find(trace => trace.kind === "tool" && trace.toolUseId === "write-1")!;
    expect(writer?.turnId, "TRACE_NAMES_THE_CALL").toBe("turn-penelope");
    expect(names(writer), "TRACE_WRITER_STEPS").toEqual(["hold", "hold_wait", ...OBSERVE, ...RECORD, ...RECORD, "observe_commit"]);

    const finish = traces.find(trace => trace.kind === "finish" && trace.turnId === "turn-penelope")!;
    expect(names(finish), "TRACE_FINISH_STEPS").toEqual(["hold", "hold_wait", ...OBSERVE, ...RECORD, ...RECORD, "observe_commit",
      "finish_record", "finish_collect", "finish_publish"]);
    for (const trace of traces) expectNested(trace);
  } finally { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
