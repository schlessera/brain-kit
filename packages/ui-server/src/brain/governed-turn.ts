/** Hosted turn admission and reconciliation; no repository code runs here. */
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { prepareWorkerSandbox, workerProfile, type WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import type { HostExecution } from "./host-execution.js";
import { assertReconciled, type Reconciliation } from "./governed-manifest.js";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { createGovernancePolicyReader, type TurnGovernancePolicy } from "./governance-policy.js";

export interface GovernedTurnHold {
  readonly sandbox: WorkerSandbox;
  readonly policy: TurnGovernancePolicy;
  /** Call only once every worker has exited. Quarantine precedes gate release. */
  end(): Reconciliation | null;
}
export interface GovernedTurns {
  begin(turnId: string, signal: AbortSignal, origin?: "interactive" | "voice", preference?: "governed" | "strict"): Promise<GovernedTurnHold>;
  /** Display facts use the same process-local last-valid reader as admission. */
  facts(origin?: "interactive" | "voice"): { policyProfile: "governed" | "strict"; policy: TurnGovernancePolicy };
  /** Deferred maintenance, serialized with application/CLI mutations. */
  refresh(lock: KeyedLock): void;
  /** Stop new deferred refreshes and drain the current worker before state closes. */
  close(): Promise<void>;
}

export function createGovernedTurns(options: {
  brainPath: string; execution: HostExecution; profile: "governed" | "strict";
  maskPaths: readonly string[]; index: (lock: KeyedLock) => Promise<unknown>;
  report: (message: string) => void;
  recordPolicy?: (turnId: string, origin: "interactive" | "voice", profile: "governed" | "strict", policy: TurnGovernancePolicy) => void;
}): GovernedTurns {
  const policyReader = createGovernancePolicyReader(options.brainPath);
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
    facts(origin = "interactive") {
      const policy = policyReader.load();
      return { policyProfile: options.profile === "strict" ? "strict" : policy.policy.profiles[origin], policy };
    },
    async close() { closing = true; again = false; await current; },
    async begin(turnId, signal, origin = "interactive", preference) {
      const availability = options.execution.boundary.governed();
      const gate = options.execution.gate();
      const manifests = options.execution.manifests();
      if (!gate || !manifests) throw new Error("Hosted turns require the writer gate and durable manifests");
      const hold = await gate.acquire("shared", `turn:${turnId}`, { signal, turn: true });
      try {
        const policy = policyReader.load();
        const requested = options.profile === "strict" || (origin === "interactive" && preference === "strict") ? "strict" : policy.policy.profiles[origin];
        const selected = requested === "governed" && !availability.available ? "strict" : requested;
        const resolved = prepareWorkerSandbox(options.brainPath, { profile: selected,
          protectedPaths: protectedPaths(policy.policy),
          maskPaths: options.maskPaths, maintenance: options.execution.boundary.maintenance });
        const commandPolicy = Object.freeze({ hash: policy.hash,
          outwardAllow: Object.freeze(policy.policy.outward.allow.map((rule, index) => Object.freeze({ ...rule, remotes: Object.freeze([...rule.remotes]), index }))),
          deny: Object.freeze(policy.policy.commands.deny.map((rule, index) => Object.freeze({ ...rule, index: policy.commandRuleIndices.deny[index]! }))),
          confirm: Object.freeze(policy.policy.commands.confirm.map((rule, index) => Object.freeze({ ...rule, index: policy.commandRuleIndices.confirm[index]! }))),
        });
        const sandbox = { ...resolved, commandPolicy,
          ...(!availability.available && requested === "governed" ? { fallbackReason: availability.detail } : {}) };
        const governed = workerProfile(sandbox) === "governed";
        options.recordPolicy?.(turnId, origin, governed ? "governed" : "strict", policy);
        if (policy.errors.length) options.report(`Governance policy invalid; using ${policy.source}: ${policy.errors.join("; ")}`);
        for (const warning of policy.warnings) options.report(`Governance policy skipped invalid pattern: ${warning}`);
        if (governed) manifests.begin(turnId, sandbox.protection!.paths.map(path => path.rel));
        let ended = false;
        return { sandbox, policy, end() {
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
