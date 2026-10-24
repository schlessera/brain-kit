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
import { requireWorkerHost, requireWorkerHostAsync, WorkerHostError, workerLimitsStatus, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";

import type { RuntimeStatus, WorkerHostMode } from "../activity/runtime-status.js";
import type { WorkerHostCheck } from "@schlessera/brain-ui-sdk/protocol";

import { workerIdentitySentinelDirectory, type WorkerProbeState } from "../brain/operational-state.js";

type Recorder = Partial<Pick<RuntimeStatus, "recordWorkerHost" | "recordWorkerLimits">> | undefined;

/**
 * Runs the real probe for `mode` and records its outcome, with the resource
 * limits workers run under (#1660). Returns the outcome; never throws.
 */
export function probeWorkerHostRecorded(
  brainPath: string,
  mode: WorkerHostMode,
  runtime: Recorder,
  trigger: WorkerHostCheck["trigger"],
  /**
   * The Claude worker's runtime-state allowance, while the Claude backend is
   * active: the probe then also mounts its private size-limited tmpfs (#1625),
   * so a host whose bubblewrap lacks `--size` is reported, not only refused.
   */
  stateBytes?: number,
  /** Every agent worker's turn-temp allowance: the probe also mounts its size-limited /tmp (#1703). */
  turnTempBytes?: number,
  state?: WorkerProbeState,
): WorkerHostProbe {
  let probe: WorkerHostProbe;
  try { probe = requireWorkerHost(brainPath, probeOptions(brainPath, mode, stateBytes, turnTempBytes, state)); }
  catch (error) { probe = refusal(error); }
  return recorded(probe, mode, runtime, trigger);
}

/**
 * `probeWorkerHostRecorded`, awaiting the probe worker so the server keeps
 * answering while a loaded host starts it (#2416).
 */
export async function probeWorkerHostRecordedAsync(brainPath: string, mode: WorkerHostMode, runtime: Recorder, trigger: WorkerHostCheck["trigger"],
  stateBytes?: number, turnTempBytes?: number, state?: WorkerProbeState): Promise<WorkerHostProbe> {
  let probe: WorkerHostProbe;
  try { probe = await requireWorkerHostAsync(brainPath, probeOptions(brainPath, mode, stateBytes, turnTempBytes, state)); }
  catch (error) { probe = refusal(error); }
  return recorded(probe, mode, runtime, trigger);
}

function probeOptions(brainPath: string, mode: WorkerHostMode, stateBytes?: number, turnTempBytes?: number, state?: WorkerProbeState) {
  const directory = workerIdentitySentinelDirectory(brainPath, state);
  return { restricted: mode === "restricted", ...(directory ? { identitySentinelDirectory: directory } : {}), ...(stateBytes !== undefined ? { stateBytes } : {}),
    ...(turnTempBytes !== undefined ? { turnTempBytes } : {}) };
}

// requireWorkerHost refuses only with WorkerHostError; anything else is
// still a refusal, named by its message.
const refusal = (error: unknown): WorkerHostProbe => ({ ok: false, requirement: error instanceof WorkerHostError ? error.requirement
  : error instanceof Error ? error.message : String(error) });

function recorded(probe: WorkerHostProbe, mode: WorkerHostMode, runtime: Recorder, trigger: WorkerHostCheck["trigger"]): WorkerHostProbe {
  runtime?.recordWorkerHost?.(mode, probe, trigger);
  runtime?.recordWorkerLimits?.(workerLimitsStatus());
  return probe;
}

/**
 * A turn's own gate: the real probe, recorded, refusing with the same
 * `WorkerHostError` as `requireWorkerHost`. It awaits the probe worker, so
 * the server keeps answering while a loaded host starts it (#2416).
 */
export async function requireWorkerHostRecorded(brainPath: string, mode: WorkerHostMode, runtime: Recorder, state?: WorkerProbeState): Promise<Extract<WorkerHostProbe, { ok: true }>> {
  const probe = await probeWorkerHostRecordedAsync(brainPath, mode, runtime, "turn", undefined, undefined, state);
  if (!probe.ok) throw new WorkerHostError(probe.requirement);
  return probe;
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
