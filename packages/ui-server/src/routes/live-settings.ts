/**
 * The owner-only write guard for `PUT /api/settings/voice` (#3616 §3). It is
 * enforced on that route itself rather than assumed from another one: only the
 * owner's human session (password or passkey) or the ambient human principal
 * passes. Delegated agent principals and anything else get 403 with an empty
 * body, before the body is read.
 */
import { isUsablePrincipal, type Principal } from "../db/principals.js";

/** The owner-only write guard (#3616 §3): a human owner session, never a delegated principal. */
export function isLiveSettingsWriter(principal: Principal | undefined, now: number): boolean {
  if (!principal || !isUsablePrincipal(principal, now)) return false;
  if (principal.kind === "ambient") return principal.authMethod === "ambient";
  return principal.kind === "owner" && (principal.authMethod === "password" || principal.authMethod === "passkey");
}

