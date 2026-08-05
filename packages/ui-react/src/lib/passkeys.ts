import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from "@simplewebauthn/browser";
import { api } from "./api-client.js";

/**
 * Thin ceremony wrappers around @simplewebauthn/browser. All server calls go
 * through api-client; success means the server set the session cookie.
 */

export function supportsPasskeys(): boolean {
  return browserSupportsWebAuthn();
}

export function supportsAutofill(): Promise<boolean> {
  return browserSupportsWebAuthnAutofill();
}

/** True for the user dismissing/cancelling the OS passkey prompt. */
export function isUserCancel(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "NotAllowedError" || err.name === "AbortError")
  );
}

/**
 * Full login ceremony. With `useBrowserAutofill`, resolves only if the user
 * picks a passkey from the input's autofill suggestions (conditional UI).
 */
export async function loginWithPasskey(opts?: {
  useBrowserAutofill?: boolean;
}): Promise<void> {
  const optionsJSON = await api.passkeyLoginOptions();
  const response = await startAuthentication({
    optionsJSON,
    useBrowserAutofill: opts?.useBrowserAutofill ?? false,
  });
  await api.passkeyLoginVerify(response);
}

/** Full registration ceremony (requires an authenticated session). */
export async function registerPasskey(label?: string): Promise<void> {
  const optionsJSON = await api.passkeyRegisterOptions();
  const response = await startRegistration({ optionsJSON });
  await api.passkeyRegisterVerify(response, label);
}
