/** One read-only Git query; no stage publication or repository execution on the host. */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareNativeWorkerStartupView, runMaintenanceWorker, type MaintenanceHost } from "@schlessera/brain-ui-sdk/internal";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";

export function createScratchIgnoreQuery(input: {
  brainPath: string;
  nativeManager?: Parameters<typeof prepareNativeWorkerStartupView>[1];
  maintenance: MaintenanceHost;
  lock: Pick<KeyedLock, "withLock">;
}): NonNullable<MaintenanceHost["scratchIgnoreQuery"]> {
  const brain = realpathSync(input.brainPath);
  return signal => input.lock.withLock(brain, async () => {
    signal?.throwIfAborted();
    if (!input.nativeManager) throw new Error("Scratch verification requires the configured native manager.");
    const git = Bun.which("git");
    if (!git) throw new Error("Scratch verification requires Git in the maintenance worker.");
    let parent: string | undefined;
    for (let dir = dirname(brain); !parent && !existsSync(join(brain, ".git")); dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) parent = dir;
      if (dir === "/") break;
    }
    const safe = ["-c", `safe.directory=${brain}`, ...(parent ? ["-c", `safe.directory=${parent}`] : [])];
    const args = [...safe, "check-ignore", "-q", "--no-index", "--", ".brain/scratch"];
    const command = existsSync(join(brain, ".git")) || parent ? [git, ...args]
      : ["/bin/sh", "-c", 'r=/tmp/brain-mask-empty-repository; "$0" init -q --bare "$r" >/dev/null 2>&1 && exec "$0" --git-dir="$r" --work-tree=. "$@"', git, ...args];
    const view = await prepareNativeWorkerStartupView(brain, input.nativeManager, signal);
    try {
      // Read-only consumers still share the maintenance temporary budget.
      // Serialize with its existing owner, without creating or publishing a stage.
      const result = await runMaintenanceWorker({ ...input.maintenance, brainPath: brain, startupView: view,
        command, env: { PATH: `${dirname(git)}:/usr/bin:/bin`, GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" },
        credentials: false, readPaths: [git, ...(parent ? [parent] : [])], signal, timeoutMs: 10_000 });
      return { exitCode: result.exitCode, killed: result.killed };
    } finally { await view.cleanup(); }
  }, { signal });
}
