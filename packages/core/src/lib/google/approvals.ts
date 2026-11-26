/** Owner-shell management only: this never grants and never invokes gog. */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { openGoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import { checkGoogleHome, selectGoogleHome } from "./home.js";
import { resolveEnv } from "../../config/env.js";
import type { GoogleEnvelope } from "./standalone.js";

export function googleApprovals(root: string, operation: "approvals" | "revoke", id?: string): GoogleEnvelope {
  const env = resolveEnv(), selection = selectGoogleHome(env.google);
  const home = checkGoogleHome(selection.path, root, { rootUid: env.google.rootUid });
  if (!home.ok) return { ok: false, operation, error: { code: "unavailable", reason: home.reason, message: home.detail } };
  try {
    const ledger = openGoogleLedger(join(home.path, "approvals.db"));
    try {
      const brain = realpathSync(root);
      return { ok: true, operation, data: operation === "approvals" ? { approvals: ledger.list(brain) }
        : { id: id!, revoked: ledger.revoke(brain, id!) } };
    } finally { ledger.close(); }
  } catch {
    return { ok: false, operation, error: { code: "unavailable", reason: "ledger_unavailable", message: "Google approval storage is unavailable; retry after repairing its private home." } };
  }
}
