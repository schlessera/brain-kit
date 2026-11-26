/** Host-only state. Never serialized into worker initialization or provider history. */
export interface AdmissionSafetySnapshot {
  readonly evidenceRevision: string;
  readonly trustRevision: string;
  readonly authorityEpoch: string;
  readonly scope: string;
  readonly policyHash: string | null;
  readonly restricted: boolean;
  readonly recordingAvailable: boolean;
  /** Pending evidence in scope with no known loss or capacity failure. */
  readonly recordingPending?: boolean;
  /** False only for this turn recorder; true distinguishes shared safety changes. */
  readonly operationRecordingAvailable?: boolean;
  readonly authorityCurrent: boolean;
}

export interface AdmissionSafety {
  /** Host-owned reservations only; exclusions never alter retained evidence or recorder failures. */
  read(excludedPending?:readonly string[]): AdmissionSafetySnapshot;
  /** Wait at most two seconds for in-scope evidence, then recheck in the dispatching continuation. */
  pendingRecording?(before: AdmissionSafetySnapshot | undefined, signal: AbortSignal | undefined,
    excludedPending?: () => readonly string[] | undefined): Iterable<Promise<void>>;
  /** Invalidation is a hint; every commit still reads synchronously. */
  subscribe(changed: () => void): () => void;
}

export const STALE_SAFETY_ADMISSION = "Safety or authority changed before admission. Nothing ran; a fresh attempt needs a fresh decision.";

export function sameSafetyAdmission(a: AdmissionSafetySnapshot, b: AdmissionSafetySnapshot): boolean {
  return a.evidenceRevision === b.evidenceRevision && a.trustRevision === b.trustRevision && a.authorityEpoch === b.authorityEpoch
    && a.scope === b.scope && a.policyHash === b.policyHash && a.restricted === b.restricted
    && a.operationRecordingAvailable === b.operationRecordingAvailable && a.recordingAvailable === b.recordingAvailable && a.authorityCurrent === b.authorityCurrent;
}

export function sameAuthority(now: AdmissionSafetySnapshot, before?: AdmissionSafetySnapshot): boolean {
  return now.authorityCurrent && (!before || now.scope === before.scope &&
    now.policyHash === before.policyHash && now.authorityEpoch === before.authorityEpoch);
}

/** Call in the dispatching continuation, after its last await. */
export function safetyAdmissionRefusal(safety: AdmissionSafety | undefined, before?: AdmissionSafetySnapshot): string | null {
  if (!safety) return null;
  try {
    return safetySnapshotRefusal(safety.read(), before);
  } catch { return STALE_SAFETY_ADMISSION; }
}

export function safetySnapshotRefusal(now: AdmissionSafetySnapshot | undefined, before?: AdmissionSafetySnapshot): string | null {
  if (now && (!now.recordingAvailable || !sameAuthority(now, before))) return STALE_SAFETY_ADMISSION;
  return null;
}

/** The concrete host owns exclusions. A backend cannot invent one. */
export function toolAdmissionSafety(bridge: import("./backend.js").BackendBridge | null | undefined, toolUseId: string, toolName: string): AdmissionSafety | undefined {
  const root=bridge?.admissionSafety;
  return root&&bridge?.inputSafety?.forAdmission?bridge.inputSafety.forAdmission(toolUseId,toolName,root):root;
}

// Concrete host settlement proof only. Never serialized or supplied by a worker.
const settledAdmissions=new WeakMap<AdmissionSafety,Map<string,string>>();
/** The host calls this only after proving that the revision delta consists of
 * the exact sibling occurrences whose recording it awaited. This is no grant;
 * dispatch still checks live recording, authority, trust and recipient policy. */
export function retainSettledAdmission(safety:AdmissionSafety,before:AdmissionSafetySnapshot,after:AdmissionSafetySnapshot):void {
 if(!before.recordingAvailable||!after.recordingAvailable||!sameAuthority(after,before)||after.trustRevision!==before.trustRevision)return;
 let revisions=settledAdmissions.get(safety);if(!revisions){revisions=new Map();settledAdmissions.set(safety,revisions);}
 for(const [prior,next] of revisions)if(next===before.evidenceRevision)revisions.set(prior,after.evidenceRevision);
 if(revisions.size>=64&&!revisions.has(before.evidenceRevision))revisions.delete(revisions.keys().next().value!);
 revisions.set(before.evidenceRevision,after.evidenceRevision);
}

/** Strict outward fence after the last host wait; own input is excluded only by the host view. */
export function outwardAdmissionRefusal(safety: AdmissionSafety | undefined,before?: AdmissionSafetySnapshot): string | null {
  if(!safety)return null;
  try {
    const now=safety.read(),unavailable=safetySnapshotRefusal(now,before);
    return unavailable??(before&&(now.evidenceRevision!==before.evidenceRevision&&settledAdmissions.get(safety)?.get(before.evidenceRevision)!==now.evidenceRevision||now.trustRevision!==before.trustRevision)?STALE_SAFETY_ADMISSION:null);
  }catch{return STALE_SAFETY_ADMISSION;}
}
