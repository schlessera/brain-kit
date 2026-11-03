/** #3355: governed admission and journal begin attribute their time to named steps. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createGovernedTurns } from "../src/brain/governed-turn.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { replaceNativeStartupAcquisitionForFixture } from "./helpers/fixture-native-startup.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

type Step = NonNullable<ActivityTurnLifecycle["subPhases"]>[number];
const names = (steps: Step[], phase: Step["phase"]) => steps.filter(step => step.phase === phase).map(step => step.name);
/** Every step finished, and lies within the phase's own paired milestones. */
function expectWithin(steps: Step[], phase: Step["phase"], startedAt: number, endedAt: number) {
  for (const step of steps.filter(item => item.phase === phase)) {
    expect(step.endedAt, `SUB_PHASE_ENDED ${step.name}`).not.toBeNull();
    expect(step.startedAt, `SUB_PHASE_STARTS_IN_PHASE ${step.name}`).toBeGreaterThanOrEqual(startedAt);
    expect(step.endedAt!, `SUB_PHASE_ENDS_IN_PHASE ${step.name}`).toBeLessThanOrEqual(endedAt);
    expect(step.elapsedMs, `SUB_PHASE_ELAPSED ${step.name}`).toBe(step.endedAt! - step.startedAt);
  }
}

test("steps persist with the next milestone and follow the phase failure rules", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    lifecycle.mark("governedStartedAt");
    const governed = lifecycle.timer("governed");
    const gate = governed("gate_acquire"); now = 1200; gate();
    expect(store.lifecycle("turn-ithaca")!.subPhases, "SUB_PHASE_ADDS_NO_TURN_PATH_WRITE").toEqual([]);
    governed("startup_checkpoint"); now = 1500; lifecycle.mark("failureObservedAt"); now = 1550; lifecycle.finish("error", "Checkpoint refused");
    governed("late_step")();
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.subPhases, "UNFINISHED_STEP_MEASURES_TO_FAILURE_BOUNDARY").toEqual([
      { phase: "governed", name: "gate_acquire", startedAt: 1000, endedAt: 1200, elapsedMs: 200 },
      { phase: "governed", name: "startup_checkpoint", startedAt: 1200, endedAt: null, elapsedMs: 300 },
    ]);
    expect(record.governedAdmissionMs).toBe(500);
  } finally { db.close(); }
});

test("real governed admission records each step inside governedAdmissionMs", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-admission-steps-"));
  writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
  // The shared stand-in copies the startup view and admits it at the managed-storage
  // refusal only (#3314); that refusal keeps its own tests.
  const restore = replaceNativeStartupAcquisitionForFixture();
  const execution = { boundary: { async prepare() { return { available: true }; }, maintenance: {} },
    gate() { return { async acquire() { return { release() {} }; } }; }, manifests() { return {}; } };
  const turns = createGovernedTurns({ nativeManager: {} as never, brainPath: brain, execution: execution as never, profile: "strict", maskPaths: [], async index() {}, report() {} });
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", Date.now(), () => {});
    lifecycle.mark("governedStartedAt");
    const hold = await turns.begin("turn-ithaca", new AbortController().signal, "interactive", undefined, undefined, lifecycle.timer("governed"));
    lifecycle.mark("governedAcquiredAt");
    try {
      const record = store.lifecycle("turn-ithaca")!;
      // A first strict admission refreshes its checkpoint once host scratch exists.
      expect(names(record.subPhases!, "governed"), "GOVERNED_ADMISSION_STEPS").toEqual(["gate_acquire", "startup_checkpoint", "boundary_prepare",
        "exposure_settle", "folder_retention", "sandbox_resolve", "startup_checkpoint_refresh", "sandbox_resolve_refresh", "data_tree", "record_policy", "exposure_records"]);
      expectWithin(record.subPhases!, "governed", record.governedStartedAt!, record.governedAcquiredAt!);
    } finally { await hold.end(); }
  } finally {
    await turns.close(); restore(); db.close();
    rmSync(brain, { recursive: true, force: true });
  }
});

test("real journal begin records each step inside journalBeginMs", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-journal-steps-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes", "ithaca.md"), "# Ithaca\n");
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects") });
  const store = createActivityStore(createUiDb(":memory:"));
  try {
    await journal.ready;
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", Date.now(), () => {});
    lifecycle.mark("journalStartedAt");
    await journal.begin("turn-ithaca", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null },
      error => { throw error; }, undefined, lifecycle.timer("journal"));
    lifecycle.mark("journalBeganAt");
    const record = store.lifecycle("turn-ithaca")!;
    expect(names(record.subPhases!, "journal"), "JOURNAL_BEGIN_STEPS").toEqual(["hold_wait", "initialize", "observe", "observe_checkpoint", "observe_delta",
      "observe_metadata", "observe_capture", "observe_record", "observe_commit", "expiry", "turn_insert", "policy"]);
    expectWithin(record.subPhases!, "journal", record.journalStartedAt!, record.journalBeganAt!);
    const observe = record.subPhases!.find(step => step.name === "observe")!;
    expectWithin(record.subPhases!.filter(step => step.name.startsWith("observe_")), "journal", observe.startedAt, observe.endedAt!);
    await journal.finish("turn-ithaca");
  } finally { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
