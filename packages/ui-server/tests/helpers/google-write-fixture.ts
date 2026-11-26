import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { GoogleMailApproval, GoogleToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { AdmissionSafetySnapshot } from "@schlessera/brain-ui-sdk/internal";
import type { PreparedGoogleWrite } from "../../src/google/write-engine.js";

export const GOOGLE_MODIFY: GoogleToolCall = { tool: "brain_google_gmail_modify", input: { message_ids: ["19a0c3d2e4f50601"], remove_label_ids: ["INBOX"] } };
export const GOOGLE_CARD: Extract<GoogleMailApproval, { operation: "gmail.modify" }> = { operation: "gmail.modify", effect: "reversible", tainted: false,
  entities: ["archive"], offers: { allow_always: false, allow_for_session: false },
  payload: { message_ids: ["19a0c3d2e4f50601"], add_label_ids: [], remove_label_ids: ["INBOX"] } };
export const GOOGLE_SAFETY: AdmissionSafetySnapshot = { evidenceRevision: "0", trustRevision: "0", authorityEpoch: "0", scope: "ithaca",
  policyHash: "ithaca", restricted: false, recordingAvailable: true, authorityCurrent: true };
export const googlePolicy = (mode: "ask" | "allow" = "ask") => resolveGovernancePolicy({ schema_version: 1,
  google: { enabled: true, account: "ithaca", services: ["gmail"], modes: { reversible: mode, irreversible: "ask" }, gmail: { send_to: ["*@example.com"] } } }).google!;
export function googleModifyPrepared(call: GoogleToolCall = GOOGLE_MODIFY, dispatch: () => void = () => {}): PreparedGoogleWrite {
  if (call.tool !== "brain_google_gmail_modify") throw new Error("Expected modify input");
  return { operation: "gmail.modify", input: call.input, facts: { items: 1, target_label_ids: ["INBOX"] },
    classificationFacts: {}, card: structuredClone(GOOGLE_CARD),
    inverse: { inverse: { message_ids: ["19a0c3d2e4f50601"], add_label_ids: ["INBOX"] },
      precondition: { removed: ["INBOX"] }, snapshot: null, createdAt: Date.now(), expiresAt: Date.now() + 60_000 },
    execute: async finalAdmission => { const error = finalAdmission(); if (error) return { ok: false, error }; dispatch(); return { ok: true, result: structuredClone(GOOGLE_CARD.payload) }; } };
}
export const GOOGLE_SEND: GoogleToolCall = { tool: "brain_google_gmail_send", input: { draft_id: "r123" } };
export function googleSendPrepared(call: GoogleToolCall = GOOGLE_SEND, dispatch: () => void = () => {}): PreparedGoogleWrite {
  if (call.tool !== "brain_google_gmail_send") throw new Error("Expected send input");
  const draftId = call.input.draft_id;
  const sender = { address: "odysseus@example.com", local: "odysseus", domain: "example.com", display_name: null };
  const card: GoogleMailApproval = { operation: "gmail.draft.send", effect: "irreversible", tainted: false, entities: [],
    offers: { allow_always: false, allow_for_session: false }, payload: { draft_id: draftId, thread_id: null, send_as: sender,
      message: { digest: "a".repeat(64), bytes: 123, from: sender, to: [sender], cc: [], bcc: [], reply_to: [], subject: "Ithaca",
        in_reply_to: [], references: [], body_text: "The voyage is over." } } };
  return { operation: "gmail.draft.send", input: call.input, facts: { recipients: [sender.address], self_addresses: [sender.address] },
    classificationFacts: {}, card, sendLock: draftId, execute: async finalAdmission => {
      const error = finalAdmission(); if (error) return { ok: false, error }; dispatch();
      return { ok: true, result: { draft_id: draftId, message_id: "19a0c3d2e4f50601", thread_id: null } };
    } };
}
