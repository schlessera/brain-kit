/** Host-only state. Never serialized into worker initialization or provider history. */
export interface AdmissionSafetySnapshot {
  readonly evidenceRevision: string;
  readonly trustRevision: string;
  readonly authorityEpoch: string;
  readonly scope: string;
  readonly policyHash: string | null;
  readonly restricted: boolean;
  readonly recordingAvailable: boolean;
  readonly authorityCurrent: boolean;
}

export interface AdmissionSafety {
  read(): AdmissionSafetySnapshot;
  /** Invalidation is a hint; every commit still reads synchronously. */
  subscribe(changed: () => void): () => void;
}

export const STALE_SAFETY_ADMISSION = "Safety or authority changed before admission. Nothing ran; a fresh attempt needs a fresh decision.";

export function sameSafetyAdmission(a: AdmissionSafetySnapshot, b: AdmissionSafetySnapshot): boolean {
  return a.evidenceRevision === b.evidenceRevision && a.trustRevision === b.trustRevision && a.authorityEpoch === b.authorityEpoch
    && a.scope === b.scope && a.policyHash === b.policyHash && a.restricted === b.restricted
    && a.recordingAvailable === b.recordingAvailable && a.authorityCurrent === b.authorityCurrent;
}

/** Call in the dispatching continuation, after its last await. */
export function safetyAdmissionRefusal(safety: AdmissionSafety | undefined, before?: AdmissionSafetySnapshot): string | null {
  if (!safety) return null;
  try {
    return safetySnapshotRefusal(safety.read(), before);
  } catch { return STALE_SAFETY_ADMISSION; }
}

export function safetySnapshotRefusal(now: AdmissionSafetySnapshot | undefined, before?: AdmissionSafetySnapshot): string | null {
  if (now && (!now.authorityCurrent || !now.recordingAvailable || before &&
    (now.scope !== before.scope || now.policyHash !== before.policyHash || now.authorityEpoch !== before.authorityEpoch))) return STALE_SAFETY_ADMISSION;
  return null;
}
