/** Admission state machine for the private actual-skill driver; imports dispatch nothing. */
import { observeTree, type TreeEvidence } from "./observer";
import { assessEffects, type EffectApproval } from "./effects";

export const phases = ["dry-run", "apply", "repeat"] as const;
export type Phase = typeof phases[number];
export interface PhysicalCall {
  requestedModel: string;
  servedModel: string;
  route: "native-claude-subscription";
  subscriptionAuthenticated: boolean;
  status: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  completed: boolean;
  rawUsage: unknown;
}
export interface NativeEvidence {
  model: string;
  exitCode: number;
  naturalStdoutEof: boolean;
  ownedChildDrained: boolean;
  overage: "reported inactive" | "unknown" | "active";
  calls: PhysicalCall[];
  failure: string | null;
}
const known = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function assertNativeEvidence(receipt: NativeEvidence) {
  if (receipt.model !== "claude-sonnet-5-5" || receipt.exitCode !== 0 ||
    !receipt.naturalStdoutEof || !receipt.ownedChildDrained || receipt.overage !== "reported inactive" ||
    receipt.failure || !receipt.calls.length || receipt.calls.length > 24) throw Error("Native model/route/usage/closure evidence is incomplete");
  for (const call of receipt.calls) {
    if (call.requestedModel !== "claude-sonnet-5-5" || call.servedModel !== "claude-sonnet-5-5" ||
      call.route !== "native-claude-subscription" || !call.subscriptionAuthenticated ||
      call.status !== 200 || !call.completed || !call.rawUsage ||
      !known(call.inputTokens) || !known(call.outputTokens) ||
      (call.cacheReadTokens !== null && !known(call.cacheReadTokens)) ||
      (call.cacheWriteTokens !== null && !known(call.cacheWriteTokens))) throw Error("Physical native evidence is incomplete");
  }
}

export interface PhaseObservation {
  phase: Phase;
  before: TreeEvidence;
  after: TreeEvidence | null;
  native: NativeEvidence;
  durationMs: number;
  effects: ReturnType<typeof assessEffects> | null;
}

/** The concrete native driver must be separately proven; a fake is only a guard control. */
export async function collectNativePhases(root: string,
  expected: Record<Phase, EffectApproval>,
  driver: (phase: Phase) => Promise<NativeEvidence>,
  save: (rows: PhaseObservation[], failure: string | null) => void) {
  const rows: PhaseObservation[] = [];
  for (const phase of phases) {
    const before = observeTree(root), started = performance.now();
    let native: NativeEvidence;
    try { native = await driver(phase); }
    catch (error) { save(rows, String(error)); throw error; }
    // Keep the receipt before validation. Unknown usage or a failed process
    // must never vanish merely because no answer entered the accuracy table.
    if (!native.ownedChildDrained) {
      rows.push({ phase, before, after: null, native, effects: null, durationMs: performance.now() - started });
      save(rows, "Owned writer has not drained; no safe post-write snapshot");
      throw Error("Owned native writer did not drain");
    }
    const after = observeTree(root), effects = assessEffects(before, after, expected[phase]);
    rows.push({ phase, before, after, native, durationMs: performance.now() - started, effects });
    save(rows, null);
    try {
      assertNativeEvidence(native);
      if (!effects.accepted) throw Error(`Unapproved ${phase} effects: ${effects.problems.join("; ")}`);
    } catch (error) { save(rows, String(error)); throw error; }
  }
  return rows;
}
