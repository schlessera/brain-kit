/**
 * A host whose safety state goes stale during the pending wait that follows the
 * dispatch ticket (#4767): `prepareDispatch` arms one pending recording, and
 * settling it revokes the turn's authority. The ticket's `commit` does not
 * validate, so only the backend's own check after that wait can refuse the call.
 */
import type { AdmissionSafety, AdmissionSafetySnapshot } from "@schlessera/brain-ui-sdk/internal";

export function staleAfterTicket() {
  const log: string[] = [];
  let armed = false, stale = false;
  const admissionSafety: AdmissionSafety = {
    read: (): AdmissionSafetySnapshot => ({ evidenceRevision: "1", trustRevision: "1", authorityEpoch: "1", scope: "ithaca", policyHash: null,
      restricted: false, recordingAvailable: true, authorityCurrent: !stale }),
    *pendingRecording() {
      if (!armed) return;
      armed = false;
      yield Promise.resolve().then(() => { stale = true; log.push("stale"); });
    },
    subscribe: () => () => {},
  };
  const inputSafety = {
    ready: async () => {}, begin: async () => {}, result: async () => {},
    refused: async (id: string, denied?: boolean) => { log.push(`refused ${id} ${denied}`); },
    allowed: async (id: string) => { log.push(`allowed ${id}`); },
    prepareDispatch: async (id: string) => {
      log.push(`prepare ${id}`);
      armed = true;
      return { commit: () => { log.push("commit"); }, cancel: async () => { log.push("cancel"); } };
    },
  };
  return { admissionSafety, inputSafety, log };
}
