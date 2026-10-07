import { useBrainUiRoot } from "../../root-context.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordingTime } from "../../lib/recordings.js";
import { LoginForm } from "./login-form.js";
import {
  isUserCancel,
  loginWithPasskey,
  supportsAutofill,
  supportsPasskeys,
} from "../../lib/passkeys.js";

/**
 * Login CONTAINER, shown when the server is in `password` auth mode and no
 * valid session cookie is present (the /api/vpn-check probe returns 401). It
 * owns the methods probe, the conditional-autofill passkey ceremony, the two
 * sign-in requests and the lifetime guard that keeps any of them from acting
 * on a superseded root; `LoginForm` owns the surface (S6). Password is always
 * offered; a passkey button appears when the server reports registered
 * passkeys and the browser supports WebAuthn. On success the browser has the
 * HttpOnly session cookie; a reload boots the authenticated app.
 */
export function LoginScreen({ reauth }: { reauth?: { revoked: boolean; snapshotFailed: boolean; savedThroughMs: number | null } } = {}) {
  const root = useBrainUiRoot();
  const api = root.api;
  const uiConfig = root.config;
  const lifetime = useRef(new AbortController());
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  // Fail-open: if the methods probe fails, keep the password form — the
  // server enforces the real policy, and hiding the only working method on a
  // transient error would be a self-inflicted lockout.
  const [passwordAvailable, setPasswordAvailable] = useState(true);

  const isReauth = reauth !== undefined;
  const signedIn = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    if (isReauth) {
      // The cookie alone does not identify an account. Confirm through the
      // existing authenticated route, before opening any account partition.
      const response = await root.request(root.backendUrl("/api/vpn-check"), { signal });
      const body = response.ok ? await response.json() as { accountKey?: unknown } : null;
      const key = typeof body?.accountKey === "string" ? body.accountKey : null;
      if (signal.aborted) return;
      if (await root.authLock.signedIn(key)) { root.recheckVpn(); return; }
    }
    if (!signal.aborted) window.location.reload();
  }, [root, isReauth]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    lifetime.current = controller;
    setPassword("");
    setError(null);
    setSubmitting(false);
    setPasskeyAvailable(false);
    setPasswordAvailable(true);
    api
      .authMethods()
      .then(async (methods) => {
        if (signal.aborted) return;
        if (methods.passkey && !methods.password) setPasswordAvailable(false);
        if (!methods.passkey || !supportsPasskeys()) return;
        setPasskeyAvailable(true);
        // Conditional UI (progressive enhancement): surface passkeys in the
        // password input's autofill. Runs once; a user cancel is not an error.
        if (!(await supportsAutofill()) || signal.aborted) return;
        try {
          await loginWithPasskey(api, { useBrowserAutofill: true, signal });
          await signedIn(signal);
        } catch (err) {
          if (!signal.aborted && !isUserCancel(err)) {
            console.warn("[passkeys] conditional UI failed:", err);
          }
        }
      })
      .catch(() => {
        // Methods probe failing degrades to password-only — unchanged behavior.
      });
    return () => controller.abort();
  }, [root, api, signedIn]);

  async function onPasswordLogin() {
    if (!password || submitting) return;
    const signal = lifetime.current.signal;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      // Cookie is set; reload so the app boots authenticated.
      await signedIn(signal);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "Login failed");
      setSubmitting(false);
    }
  }

  async function onPasskeyClick() {
    if (submitting) return;
    const signal = lifetime.current.signal;
    setSubmitting(true);
    setError(null);
    try {
      await loginWithPasskey(api, { signal });
      await signedIn(signal);
    } catch (err) {
      if (signal.aborted) return;
      if (!isUserCancel(err)) {
        setError(err instanceof Error ? err.message : "Passkey login failed");
      }
      setSubmitting(false);
    }
  }

  return (
    <LoginForm
      appName={uiConfig.appName}
      title={reauth ? reauth.revoked ? "This device was signed out" : "Your sign-in has expired" : undefined}
      notice={reauth ? <>
        {reauth.savedThroughMs !== null && <p>Recording stopped. Saved up to {recordingTime(reauth.savedThroughMs)}.</p>}
        <p>Your draft and recordings are kept on this device, locked until you sign in again as the same account.</p>
        {reauth.snapshotFailed && <p role="alert">Your draft couldn't be saved on this device.</p>}
      </> : undefined}
      methods={{ password: passwordAvailable, passkey: passkeyAvailable }}
      password={password}
      busy={submitting}
      error={error}
      onPasswordChange={setPassword}
      onPassword={() => void onPasswordLogin()}
      onPasskey={() => void onPasskeyClick()}
    />
  );
}
