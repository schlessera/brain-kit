import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from "@simplewebauthn/browser";
import type { BrainApi } from "./api-client.js";

/**
 * Thin ceremony wrappers around @simplewebauthn/browser. All server calls go
 * through the supplied API. Cancellation prevents starting a stale prompt or
 * submitting its result; the browser library owns the page-wide prompt itself.
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
export async function loginWithPasskey(api: BrainApi, opts?: {
  signal?: AbortSignal;
  useBrowserAutofill?: boolean;
}): Promise<void> {
  opts?.signal?.throwIfAborted();
  const optionsJSON = await api.passkeyLoginOptions();
  opts?.signal?.throwIfAborted();
  const response = await startAuthentication({
    optionsJSON,
    useBrowserAutofill: opts?.useBrowserAutofill ?? false,
  });
  opts?.signal?.throwIfAborted();
  await api.passkeyLoginVerify(response);
}

/** Full registration ceremony (requires an authenticated session). */
export async function registerPasskey(api: BrainApi, label?: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const optionsJSON = await api.passkeyRegisterOptions();
  signal?.throwIfAborted();
  const response = await startRegistration({ optionsJSON });
  signal?.throwIfAborted();
  await api.passkeyRegisterVerify(response, label);
}
