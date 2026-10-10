/** Full complementary artifacts only; no live calibration or semantic quality follows. */
import { validateReviewEvidence, type EvidenceReference, type RuntimeIdentity } from "./review-evidence";
import {type ReviewBinding} from "../native-pricing";
export interface ReviewReceipt {
  key: string; freezeSha: string; promptSha: string; approved: boolean; model: string;
  finished: boolean; drained: boolean; stdoutComplete: boolean; callsComplete: boolean;
  overage: string; actualCli: string; actualProvider: boolean; scope: string; authorFamily: string; reviewerFamily: string; evidence?: EvidenceReference;
}
/** Admission over freshly rebuilt packets, never a cached claimed hash list. */
export function admitExactPackets(expected: Array<{ key: string; freezeSha: string; promptSha: string; runtime: RuntimeIdentity;binding?:ReviewBinding }>, receipts: ReviewReceipt[]) {
  if (expected.length === 0 || new Set(expected.map(p=>p.key)).size !== expected.length || receipts.length !== expected.length) return false;
  return expected.every(p => {
    const matches = receipts.filter(r => r.key === p.key);
    return matches.length === 1 && matches[0]!.freezeSha === p.freezeSha && matches[0]!.promptSha === p.promptSha && matches[0]!.approved === true &&
      matches[0]!.model === "claude-sonnet-5-5" && matches[0]!.actualCli === "2.1.293" && matches[0]!.finished === true && matches[0]!.drained === true && matches[0]!.stdoutComplete === true && matches[0]!.callsComplete === true && ["inactive observed","active"].includes(matches[0]!.overage) &&
      matches[0]!.actualProvider === true && matches[0]!.scope === "complementary-semantic-review" && matches[0]!.authorFamily === "gpt" && matches[0]!.reviewerFamily === "claude" && validateReviewEvidence({...p,overage:matches[0]!.overage}, matches[0]!.evidence);
  });
}
