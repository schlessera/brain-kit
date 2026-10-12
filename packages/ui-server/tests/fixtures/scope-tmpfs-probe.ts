/** Offline supported lifecycle proof, inside a disposable fixture mount namespace. */
import { readdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeFixture } from "../helpers/scope-fixture.js";
const brain = process.argv[2]!;
const fs = statfsSync(brain);
if (fs.type !== 0x01021994 || fs.bavail * fs.bsize <= 2 * 1024 ** 3) throw Error("Fixture must start on tmpfs above the approved 2 GiB floor");
const pausedFloor = process.argv[3] === "pausedFloor";
const f = scopeFixture(pausedFloor ? { max_tool_calls: 1 } : {}, undefined, brain); let child: ReturnType<typeof f.worker> | undefined;
try {
  f.begin(); child = f.worker('i=0; while [ "$i" -lt 200 ]; do i=$((i+1)); head -c 1048576 /dev/zero > .brain/scratch/sail-$i; sleep 0.2; done; printf done > finished');
  if (pausedFloor) {
    f.scope.toolCall("voyage", "loom");
    const previous = f.message("continue");
    if (f.receipt().dimension !== "tool_calls" || f.receipt().newCap !== 2) throw Error("Fixture did not pause at its tool cap");
    writeFileSync(join(brain, ".brain/scratch/disk-pressure"), Buffer.alloc(33 * 1024 ** 2));
    // Fresh Continue admission itself observes the floor, without waiting for a new interval.
    if (f.scope.decide(previous, true).state !== "refused") throw Error("SCOPE_PAUSED_CONTINUE_BYPASSED_FLOOR");
  }
  const deadline = Date.now() + 18_000;
  while (!f.journal.summary("voyage").scope!.receipts.length) { if (Date.now() > deadline) throw Error("Disk-floor fixture did not pause within the observation interval"); await Bun.sleep(20); }
  const receipt = f.receipt(), count = readdirSync(join(brain, ".brain/scratch")).length;
  if (receipt.dimension !== "free_space_floor" || receipt.state !== "paused" || !receipt.frozen || receipt.newCap !== undefined) throw Error(JSON.stringify(receipt));
  await Bun.sleep(200);
  if (readdirSync(join(brain, ".brain/scratch")).length !== count) throw Error("SCOPE_TMPFS_LOOP_NOT_FROZEN");
  if (f.scope.decide(f.message("continue"), true).state !== "refused") throw Error("SCOPE_TMPFS_FLOOR_GRANTED");
  f.scope.decide(f.message("stop"), true); await child.exited;
  console.log(JSON.stringify({ proof: "supported tmpfs worker freeze/Stop", receipt: f.receipt(), retainedFiles: count }));
} finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
