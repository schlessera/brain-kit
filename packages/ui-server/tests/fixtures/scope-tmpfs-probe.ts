import { watchdogMs } from "../../../../scripts/test-deadlines";
/** Offline supported lifecycle proof, inside a disposable fixture mount namespace. */
import { readdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeFixture } from "../helpers/scope-fixture.js";
import { registeredInterval } from "../helpers/registered-interval.js";
const brain = process.argv[2]!;
const fs = statfsSync(brain);
if (fs.type !== 0x01021994 || fs.bavail * fs.bsize <= 2 * 1024 ** 3) throw Error("Fixture must start on tmpfs above the approved 2 GiB floor");
const pausedFloor = process.argv[3] === "pausedFloor";
const f = scopeFixture(pausedFloor ? { max_tool_calls: 1 } : {}, undefined, brain); let child: ReturnType<typeof f.worker> | undefined;
const clock = pausedFloor ? undefined : registeredInterval();
const started = performance.now();
const timings: Record<string, number> = {};
try {
  await f.begin(); clock?.finishRegistration();
  if (clock && (clock.registrations.length !== 1 || clock.registrations[0]!.delay !== 15_000)) throw Error("SCOPE_TMPFS_PRODUCTION_INTERVAL_IS_15000_MS");
  child = f.worker(["/usr/bin/python3", "-I", "-S", "-c", `import pathlib,time
block=bytes(1048576)
for i in range(1,201):
    pathlib.Path(".brain/scratch/sail-"+str(i)).write_bytes(block)
    time.sleep(0.2)
pathlib.Path("finished").write_text("done")`]);
  timings.workerLaunchedMs = performance.now() - started;
  if (pausedFloor) {
    f.scope.toolCall("voyage", "loom");
    const previous = f.message("continue");
    if (f.receipt().dimension !== "tool_calls" || f.receipt().newCap !== 2) throw Error("Fixture did not pause at its tool cap");
    writeFileSync(join(brain, ".brain/scratch/disk-pressure"), Buffer.alloc(33 * 1024 ** 2));
    // Fresh Continue admission itself observes the floor, without waiting for a new interval.
    if ((await f.scope.decide(previous, true)).state !== "refused") throw Error("SCOPE_PAUSED_CONTINUE_BYPASSED_FLOOR");
  }
  const deadline = Date.now() + watchdogMs(32_000);
  if (clock) {
    let samples = 0;
    for (;;) {
      const sample = statfsSync(brain); samples++;
      if (timings.firstWriteMs === undefined && readdirSync(join(brain, ".brain/scratch")).length) timings.firstWriteMs = performance.now() - started;
      if (sample.bavail * sample.bsize < 2 * 1024 ** 3) break;
      if (Date.now() > deadline) throw Error("SCOPE_TMPFS_WRITER_DID_NOT_CROSS_FLOOR");
      await Bun.sleep(20);
    }
    timings.floorCrossedMs = performance.now() - started; timings.statfsSamples = samples;
    clock.advanceTo(14_999); await f.journal.idle();
    if (clock.dispatches || f.journal.summary("voyage").scope!.receipts.length) throw Error("SCOPE_TMPFS_NO_OBSERVATION_BEFORE_DEADLINE");
    timings.observationTickMs = performance.now() - started;
    // A dispatched tick is not its completed native observation. Join the
    // registered tick's actual publication before inspecting its receipt.
    const observed = Promise.withResolvers<void>();
    const unsubscribe = f.journal.onObservation(turnId => { if (turnId === "voyage") observed.resolve(); });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      clock.advanceTo(15_000);
      await Promise.race([observed.promise, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(Error("SCOPE_TMPFS_REGISTERED_TICK_MUST_PUBLISH_RECEIPT "+JSON.stringify({ dispatches: clock.dispatches, stopped: f.stopped }))), watchdogMs(16_000));
      })]);
      await f.journal.idle();
    } finally { clearTimeout(watchdog); unsubscribe(); }
    if (clock.dispatches !== 1 || !f.journal.summary("voyage").scope!.receipts.length) throw Error("SCOPE_TMPFS_REGISTERED_TICK_MUST_PUBLISH_RECEIPT "+JSON.stringify({dispatches:clock.dispatches,registrations:clock.registrations.map(({delay,due,cancelled})=>({delay,due,cancelled})),stopped:f.stopped,scope:f.journal.summary("voyage").scope}));
  }
  while (!f.journal.summary("voyage").scope!.receipts.length) { if (Date.now() > deadline) throw Error("Disk-floor fixture did not pause within the observation interval"); await Bun.sleep(20); }
  timings.receiptMs = performance.now() - started;
  const receipt = f.receipt(), count = readdirSync(join(brain, ".brain/scratch")).length;
  if (receipt.dimension !== "free_space_floor" || receipt.state !== "paused" || !receipt.frozen || receipt.newCap !== undefined) throw Error(JSON.stringify(receipt));
  await Bun.sleep(200);
  if (readdirSync(join(brain, ".brain/scratch")).length !== count) throw Error("SCOPE_TMPFS_LOOP_NOT_FROZEN");
  if ((await f.scope.decide(f.message("continue"), true)).state !== "refused") throw Error("SCOPE_TMPFS_FLOOR_GRANTED");
  (await f.scope.decide(f.message("stop"), true)); await child.exited;
  console.log(JSON.stringify({ proof: "supported tmpfs worker freeze/Stop", receipt: f.receipt(), retainedFiles: count, timings }));
} finally {
  const cleanup = [async () => { child?.kill("SIGKILL"); if (child) await child.exited; }, () => f.close()];
  if (clock) await clock.cleanup(cleanup);
  else { try { await cleanup[0]!(); } finally { await cleanup[1]!(); } }
}
