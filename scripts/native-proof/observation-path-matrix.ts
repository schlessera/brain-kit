/** Actual governed worker, kernel-confirmed holds, and the existing journal timers (#4294). */
import assert from "node:assert/strict";
import { watchdogMs } from "../test-deadlines.js";
import { createInterface } from "node:readline";
import { launchAgentWorker } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import type { TurnJournal } from "../../packages/ui-server/src/brain/turn-journal.js";
import type { GovernedTurns } from "../../packages/ui-server/src/brain/governed-turn.js";

export async function observationPathMatrix(brain: string, journal: TurnJournal, governed: GovernedTurns,
  event: (kind: string, data: object) => void) {
  const turnId = `odysseus-path-matrix-${crypto.randomUUID()}`, signal = AbortSignal.timeout(watchdogMs(900_000));
  const admission: { name: string; ms: number }[] = [];
  const hold = await governed.begin(turnId, signal, "interactive", "governed", undefined, name => {
    const start = performance.now(); return () => { admission.push({ name, ms: performance.now() - start }); };
  });
  let worker: ReturnType<typeof launchAgentWorker> | undefined, detach: (() => boolean) | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  const samples: { changedPaths: number; sample: number; toolUseId: string; frozenMs: number }[] = [];
  let frozenAt: number | undefined, frozenMs = 0;
  const abort = () => worker?.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
  try {
    assert.equal(hold.sandbox.profile, "governed", "PATH_MATRIX_REAL_GOVERNED_ADMISSION");
    await journal.begin(turnId, { sessionId: null, actor: "interactive", model: null, profile: "governed", policyHash: hold.policy.hash }, error => { worker?.kill("SIGKILL"); throw error; }, signal);
    worker = launchAgentWorker({ brainPath: brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
      'echo ready; while read -r count sample; do i=0; while [ "$i" -lt "$count" ]; do echo "Odysseus sample $sample path $i" > "notes/ithaca-matrix-$count-$i.md"; i=$((i+1)); done; echo written; done'] });
    worker.stderr.resume();
    lines = createInterface({ input: worker.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, "ready", "PATH_MATRIX_WORKER_READY");
    detach = journal.onObservation(() => {}, {
      before() { worker!.freeze(); frozenAt = performance.now(); },
      after(completed) {
        if (frozenAt !== undefined) { frozenMs = performance.now() - frozenAt; frozenAt = undefined; }
        if (completed) worker!.resume(); else worker!.kill("SIGKILL");
      },
    });
    for (const changedPaths of [0, 1, 20, 200]) for (let sample = 0; sample < 12; sample++) {
      signal.throwIfAborted();
      worker.stdin.write(`${changedPaths} ${sample}\n`);
      assert.equal((await iterator.next()).value, "written", "PATH_MATRIX_WRITES_ACKNOWLEDGED_BEFORE_HOLD");
      const toolUseId = `path-matrix-${changedPaths}-${sample}`;
      journal.toolStarted(turnId, toolUseId, "Bash", true);
      await journal.toolEnded(turnId, toolUseId);
      samples.push({ changedPaths, sample, toolUseId, frozenMs });
    }
    event("observation_path_matrix", { turnId, samples, admission });
    assert.equal(samples.length, 48, "PATH_MATRIX_ALL_48_SAMPLES");
    return { turnId, samples, admission };
  } finally {
    signal.removeEventListener("abort", abort); detach?.(); lines?.close(); worker?.kill("SIGKILL");
    if (worker) { await worker.exited; await worker.released(); worker.turnTemp?.close(); }
    try { await journal.finish(turnId); } finally { await hold.end(); }
  }
}
