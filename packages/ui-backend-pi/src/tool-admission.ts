/** Host-only per-use provenance retained across rewrite and lock waits. */
import { commitOutwardPlan, prepareOutwardPlan, STALE_SAFETY_ADMISSION, type AdmissionSafetySnapshot } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { TurnContext } from "./turn-context.js";

type Admission = { input: string; before?: AdmissionSafetySnapshot; approved: boolean };
const admissions = new WeakMap<TurnContext, { bridge: BackendBridge | null; calls: Map<string, Admission> }>();
const key = (tool: string, id: string) => JSON.stringify([tool, id]);

export function rememberPiAdmission(turn: TurnContext, tool: string, id: string, input: unknown, before: AdmissionSafetySnapshot | undefined, approved: boolean): void {
  let state = admissions.get(turn);
  if (!state || state.bridge !== turn.bridge) { state = { bridge: turn.bridge, calls: new Map() }; admissions.set(turn, state); }
  const identity = key(tool, id);
  if (!state.calls.has(identity) && state.calls.size >= 2000) throw new Error("Pi tool admission capacity exceeded");
  state.calls.set(identity, { input: JSON.stringify(input), before, approved });
}

/** No approval or replay: re-evaluate only the authority this exact call already obtained. */
export function revalidatePiAdmission(turn: TurnContext, tool: string, id: string, input: unknown, consume = false): string | null {
  const state = admissions.get(turn), admitted = state?.calls.get(key(tool, id));
  if (state?.bridge !== turn.bridge || !admitted || admitted.input !== JSON.stringify(input))
    return turn.bridge?.admissionSafety ? STALE_SAFETY_ADMISSION : null;
  const plan = prepareOutwardPlan({ toolName: tool, shellToolName: "bash", input, allow: turn.commandPolicy?.outwardAllow,
    taint: turn.commandPolicy?.taint, safety: turn.bridge?.admissionSafety, autonomous: !!turn.autonomous,
    voice: turn.posture === "voice", configurationRoot: turn.configurationRoot, maintenance: turn.maintenance });
  const refused = commitOutwardPlan(plan, { bridge: turn.bridge, before: admitted.before, approved: admitted.approved, signal: turn.signal });
  if (!refused && consume) state!.calls.delete(key(tool, id));
  return refused;
}
