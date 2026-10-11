/**
 * The agent worker host gate, with its outcome recorded (#1632).
 *
 * Every turn still runs the real probe before anything is initialized
 * (docs/hosting/agent-workers.md): a known failure never short-circuits it,
 * and a pass is never cached. What this adds is memory of the answer. Each
 * probe, whether at boot, in a turn's gate or from an explicit check,
 * re-records the latest outcome on the runtime status, so `/api/status` and
 * the client say what the newest real probe found.
 */
import { requireWorkerHost, WorkerHostError, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";

import type { RuntimeStatus, WorkerHostMode } from "../activity/runtime-status.js";
import type { WorkerHostCheck } from "@schlessera/brain-ui-sdk/protocol";

type Recorder = Partial<Pick<RuntimeStatus, "recordWorkerHost">> | undefined;

/**
 * Runs the real probe for `mode` and records its outcome. Returns the
 * outcome; never throws.
 */
export function probeWorkerHostRecorded(
  brainPath: string,
  mode: WorkerHostMode,
  runtime: Recorder,
  trigger: WorkerHostCheck["trigger"],
): WorkerHostProbe {
  let probe: WorkerHostProbe;
  try {
    requireWorkerHost(brainPath, { restricted: mode === "restricted" });
    probe = { ok: true };
  } catch (error) {
    // requireWorkerHost refuses only with WorkerHostError; anything else is
    // still a refusal, named by its message.
    probe = { ok: false, requirement: error instanceof WorkerHostError ? error.requirement
      : error instanceof Error ? error.message : String(error) };
  }
  runtime?.recordWorkerHost?.(mode, probe, trigger);
  return probe;
}

/**
 * A turn's own gate: the real probe, recorded, refusing with the same
 * `WorkerHostError` as `requireWorkerHost`.
 */
export function requireWorkerHostRecorded(brainPath: string, mode: WorkerHostMode, runtime: Recorder): void {
  const probe = probeWorkerHostRecorded(brainPath, mode, runtime, "turn");
  if (!probe.ok) throw new WorkerHostError(probe.requirement);
}

/**
 * What the boot log and `/api/status` say while the server runs as uid 0
 * (#1638). Its workers run as uid 0 too, without capabilities and with a
 * read-only `/proc` (#1629), but they keep what root can do without writing.
 */
export const ROOT_SERVER_WARNING = "The server runs as root (uid 0), so its agent workers do too. "
  + "A root-run worker can read root-owned files and connect to root-owned and abstract Unix sockets. "
  + "Run the server as a non-root user for the full worker boundary (docs/hosting/agent-workers.md#running-the-server-as-root).";

/**
 * Whether this process runs as root, by real or effective uid: the same test
 * the worker launcher uses to give a root worker a read-only `/proc` (#1629).
 */
export function serverRunsAsRoot(): boolean {
  return process.getuid?.() === 0 || process.geteuid?.() === 0;
}
