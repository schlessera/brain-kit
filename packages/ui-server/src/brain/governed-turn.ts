/** Hosted turn admission and reconciliation; no repository code runs here. */
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { prepareWorkerSandbox, workerProfile, type WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import type { HostExecution } from "./host-execution.js";
import { assertReconciled, type Reconciliation } from "./governed-manifest.js";

export interface GovernedTurnHold {
  readonly sandbox: WorkerSandbox;
  /** Call only once every worker has exited. Quarantine precedes gate release. */
  end(): Reconciliation | null;
}
export interface GovernedTurns {
  begin(turnId: string, signal: AbortSignal): Promise<GovernedTurnHold>;
  /** Deferred maintenance, serialized with application/CLI mutations. */
  refresh(lock: KeyedLock): void;
  /** Stop new deferred refreshes and drain the current worker before state closes. */
  close(): Promise<void>;
}

export function createGovernedTurns(options: {
  brainPath: string; execution: HostExecution; profile: "governed" | "strict";
  maskPaths: readonly string[]; index: (lock: KeyedLock) => Promise<unknown>;
  report: (message: string) => void;
}): GovernedTurns {
  let current: Promise<unknown> | undefined;
  let again = false;
  let closing = false;
  const refresh = (lock: KeyedLock): void => {
    if (closing) return;
    if (current) { again = true; return; }
    again = false;
    current = options.index(lock).catch(error => options.report(`governed index refresh failed: ${String(error)}`))
      .finally(() => { current = undefined; if (again) refresh(lock); });
  };
  return {
    refresh,
    async close() { closing = true; again = false; await current; },
    async begin(turnId, signal) {
      const availability = options.execution.boundary.governed();
      const gate = options.execution.gate();
      const manifests = options.execution.manifests();
      if (!gate || !manifests) throw new Error("Hosted turns require the writer gate and durable manifests");
      const hold = await gate.acquire("shared", `turn:${turnId}`, { signal });
      try {
        const selected = options.profile === "governed" && !availability.available ? "strict" : options.profile;
        const resolved = prepareWorkerSandbox(options.brainPath, { profile: selected,
          maskPaths: options.maskPaths });
        const sandbox = !availability.available && options.profile === "governed"
          ? { ...resolved, fallbackReason: availability.detail } : resolved;
        const governed = workerProfile(sandbox) === "governed";
        if (governed) manifests.begin(turnId, sandbox.protection!.paths.map(path => path.rel));
        let ended = false;
        return { sandbox, end() {
          if (ended) return null;
          ended = true;
          try {
            const result = governed ? manifests.end(turnId) : null;
            if (result) assertReconciled([result]);
            return result;
          } finally { hold.release(); }
        } };
      } catch (error) { hold.release(); throw error; }
    },
  };
}
