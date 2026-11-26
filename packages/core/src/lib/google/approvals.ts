/** Owner-shell management only: this never grants and never invokes gog. */
import { googleBrainId, googleLedgerPath, openGoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import { resolveEnv } from "../../config/env.js";
import type { GoogleEnvelope } from "./standalone.js";

export function googleApprovals(root: string, operation: "approvals" | "revoke", id?: string): GoogleEnvelope {
  const path = resolveEnv().googleLedger;
  if (!path) return { ok: false, operation, error: { code: "unavailable", reason: "ledger_unset",
    message: "Set BRAIN_GOOGLE_LEDGER to the absolute path of the shared server Google ledger." } };
  try {
    const ledger = openGoogleLedger(googleLedgerPath(path, root));
    try {
      const brain = googleBrainId(root);
      return { ok: true, operation, data: operation === "approvals" ? { approvals: ledger.list(brain) }
        : { id: id!, revoked: ledger.revoke(brain, id!) } };
    } finally { ledger.close(); }
  } catch {
    return { ok: false, operation, error: { code: "unavailable", reason: "ledger_unavailable", message: "Google approval storage is unavailable; retry after repairing its private ledger." } };
  }
}
