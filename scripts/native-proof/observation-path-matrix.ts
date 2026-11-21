import { observationCursor, observationSample, observationSampleAccepted } from "./observation-sample.js";
import type { Database } from "bun:sqlite";
import { INDEX_OBSERVATION_CAP_BYTES, type TurnScope } from "../../packages/ui-server/src/brain/turn-scope.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
/** Actual governed worker, kernel-confirmed holds, and the existing journal timers (#4294). */
import { observationHold } from "./observation-hold.js";
import assert from "node:assert/strict";
import { watchdogMs } from "../test-deadlines.js";
import { createInterface } from "node:readline";
import { launchAgentWorker } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import type { TurnJournal } from "../../packages/ui-server/src/brain/turn-journal.js";
import type { GovernedTurns } from "../../packages/ui-server/src/brain/governed-turn.js";

export async function observationPathMatrix(brain: string, journal: TurnJournal, governed: GovernedTurns,
  event: (kind: string, data: object) => void, scope: TurnScope, principalId: string, db: Database) {
  const turnId = `odysseus-path-matrix-${crypto.randomUUID()}`, signal = AbortSignal.timeout(watchdogMs(3_600_000));
  const admission: { name: string; ms: number }[] = [];
  const hold = await governed.begin(turnId, signal, "interactive", "governed", undefined, name => {
    const start = performance.now(); return () => { admission.push({ name, ms: performance.now() - start }); };
  });
  let scoped = false;
  const indexCopy = `.brain-index/.maintenance-${crypto.randomUUID()}`;
  let worker: ReturnType<typeof launchAgentWorker> | undefined, detach: (() => boolean) | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  const samples: { changedPaths: number; requestedPaths: number; sample: number; toolUseId: string; frozenMs: number; sharedHold: boolean }[] = [];

  const abort = () => worker?.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
  try {
    assert.equal(hold.sandbox.profile, "governed", "PATH_MATRIX_REAL_GOVERNED_ADMISSION");
    await journal.begin(turnId, { sessionId: "odysseus-path-matrix", actor: "interactive", model: null, profile: "governed", policyHash: hold.policy.hash }, error => { worker?.kill("SIGKILL"); throw error; }, signal);
    worker = launchAgentWorker({ brainPath: brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
      `echo ready; while read -r count sample; do if [ "$count" = index ]; then /usr/bin/truncate -s "$sample" "${indexCopy}" || exit 1; echo written; continue; fi; i=0; while [ "$i" -lt "$count" ]; do echo "Odysseus sample $sample path $i" > "notes/ithaca-matrix-$count-$i.md"; i=$((i+1)); done; echo written; done`] });
    worker.stderr.resume();
    lines = createInterface({ input: worker.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, "ready", "PATH_MATRIX_WORKER_READY");
    let beforeSequence = 0;
    const holds = observationHold({ freeze() {
      beforeSequence = observationCursor(db, turnId);
      worker!.freeze();
    }, resume() { worker!.resume(); }, kill(signal) { worker!.kill(signal); } });
    const rejectedSamples: typeof samples = [];
    async function samplePaths(requestedPaths: number, label: string, sample: number) {
      for (let attempt = 0; attempt < 60; attempt++) {
        signal.throwIfAborted(); worker!.stdin.write(`${requestedPaths} ${label}-${sample}-${attempt}\n`);
        assert.equal((await iterator.next()).value, "written", "PATH_MATRIX_WRITES_ACKNOWLEDGED_BEFORE_HOLD");
        const toolUseId = `path-matrix-${label}-${requestedPaths}-${sample}-${attempt}`;
        journal.toolStarted(turnId, toolUseId, "Bash", true);
        await journal.toolEnded(turnId, toolUseId); await holds.idle();
        const result = observationSample(db, turnId, beforeSequence, requestedPaths, sample, toolUseId, holds.sample());
        if (observationSampleAccepted(result)) return result;
        rejectedSamples.push(result);
      }
      throw new Error(`PATH_MATRIX_NO_MATCHING_${requestedPaths}_PATH_SAMPLE`);
    }
    detach = journal.onObservation(() => {}, holds);
    for (const changedPaths of [0, 1, 20, 200]) for (let sample = 0; sample < 12; sample++)
      samples.push(await samplePaths(changedPaths, "warm", sample));
    // The same real worker creates committed versions until this active
    // turn has over 10,000 rows. No test-only row or sequence is injected.
    for (let sample = 12; sample < 50; sample++) {
      signal.throwIfAborted(); worker.stdin.write(`200 ${sample}\n`);
      assert.equal((await iterator.next()).value, "written", "PATH_MATRIX_HISTORY_WRITES_ACKNOWLEDGED");
      const toolUseId = `path-matrix-history-${sample}`;
      journal.toolStarted(turnId, toolUseId, "Bash", true); await journal.toolEnded(turnId, toolUseId); await holds.idle();
    }
    const historyRows = journal.details("odysseus-path-matrix", turnId)!.changes.length;
    assert.ok(historyRows >= 10_000, "PATH_MATRIX_TEN_THOUSAND_COMMITTED_ROWS");
    const loadedSamples: typeof samples = [];
    for (let sample = 0; sample < 12; sample++) loadedSamples.push(await samplePaths(1, "loaded", sample));
    event("observation_path_matrix", { turnId, samples, admission, historyRows, loadedSamples, rejectedSamples });
    assert.equal(samples.length, 48, "PATH_MATRIX_ALL_48_SAMPLES");
    assert.equal(loadedSamples.length, 12, "PATH_MATRIX_ALL_LOADED_SAMPLES");
    // After timing, prove the observation-time cap using a real writable
    // governed worker and a sparse publication copy: no giant content capture.
    detach(); detach = undefined;
    await scope.begin(turnId, { sessionId: null, principalId, origin: "interactive", profile: "governed", policy: hold.policy.policy,
      source: "default", hardTimeoutMs: 3600000, current: () => true, stop: () => worker?.kill("SIGKILL") }); scoped = true;
    scope.workerStarted(turnId, worker);
    let indexBytes: number | null | undefined;
    const off = journal.onObservation((id, facts) => { if (id === turnId) indexBytes = facts.indexBytes; });
    try {
      await journal.observe();
      assert.ok(typeof indexBytes === "number" && indexBytes < INDEX_OBSERVATION_CAP_BYTES, "INDEX_PROBE_BASELINE_FITS");
      const baseline = indexBytes;
      worker.stdin.write(`index ${INDEX_OBSERVATION_CAP_BYTES - baseline - 1}\n`);
      assert.equal((await iterator.next()).value, "written", "INDEX_PROBE_WORKER_CAN_WRITE_INDEX");
      await journal.observe(); assert.equal(scope.isPaused(turnId), false, "INDEX_UNDER_CAP_CONTINUES");
      worker.stdin.write(`index ${INDEX_OBSERVATION_CAP_BYTES - baseline + 1}\n`);
      assert.equal((await iterator.next()).value, "written", "INDEX_PROBE_WORKER_CAN_GROW_INDEX");
      await journal.observe(); assert.equal(scope.isPaused(turnId), true, "INDEX_OVER_CAP_PAUSES");
      await scope.finish(turnId); scoped = false;
      const receipt = journal.summary(turnId).scope!.receipts.at(-1)!;
      assert.equal(receipt.result, "index_capacity", "INDEX_CAP_HAS_NAMED_RESULT");
      event("observation_index_capacity", { turnId, receipt, indexBytes });
    } finally { off(); }
    return { turnId, samples, admission, historyRows, loadedSamples, rejectedSamples };
  } finally {
    signal.removeEventListener("abort", abort); detach?.(); lines?.close(); worker?.stdout.resume(); worker?.kill("SIGKILL");
    if (worker) { await worker.exited; await worker.released(); worker.turnTemp?.close(); }
    try {
      if (scoped) await scope.finish(turnId);
      rmSync(join(brain, indexCopy), { force: true });
      await journal.finish(turnId);
    } finally { await hold.end(); }
  }
}
