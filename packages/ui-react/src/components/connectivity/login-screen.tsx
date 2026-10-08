import { useStore } from "zustand";
import { useBrainUiRoot } from "../../root-context.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@schlessera/brain-ui-kit";
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
export function LoginScreen({ reauth, onLocalCapture }: { reauth?: { revoked: boolean; snapshotFailed: boolean; savedThroughMs: number | null }; onLocalCapture?: () => void } = {}) {
  const root = useBrainUiRoot();
  const restoring = useStore(root.authLock.state, s => s.phase === "restoring");
  const api = root.api;
  const notice = useStore(root.localWorkFlow.state, s => s.notice);
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
    // Verify the authenticated account after every explicit ceremony, before
    // opening its local writer generation or requesting association.
    let key: string;
    try {
      const response = await root.request(root.backendUrl("/api/vpn-check"), { signal });
      const body = response.ok ? await response.json() as { accountKey?: unknown } : null;
      if (typeof body?.accountKey !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.accountKey)) throw new Error("Couldn't confirm your signed-in account. Try again.");
      key = body.accountKey;
    } catch (error) {
      if (signal.aborted) return;
      // With no recoverable warm snapshot, preserve T4's cold fallback.
      // Carry only the explicit ceremony; the new boot must verify the
      // account before admitting writers or consuming the association offer.
      if (!isReauth || !root.authLock.hasSnapshot()) {
        root.localWorkFlow.signedIn(); root.localWorkFlow.reloadAfterSignIn(); return;
      }
      throw error;
    }
    if (signal.aborted) return;
    root.localWorkFlow.signedIn();
    root.stores.connection.setState({ accountKey: key });
    await root.partitions?.allowWritesAfterSignIn(key);
    if (isReauth && root.authLock.hasSnapshot() && await root.authLock.signedIn(key)) {
      root.recheckVpn(); return;
    }
    if (!signal.aborted) root.localWorkFlow.reloadAfterSignIn();
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
        let finish = () => {};
        const conditionalApi = new Proxy(api, { get(target, property) {
          if (property === "passkeyLoginVerify") return (response: Parameters<typeof api.passkeyLoginVerify>[0]) => {
            signal.throwIfAborted(); finish = root.localWorkFlow.beginSignIn(isReauth);
            return api.passkeyLoginVerify(response);
          };
          return Reflect.get(target, property);
        } });
        try {
          await loginWithPasskey(conditionalApi, { useBrowserAutofill: true, signal });
          await signedIn(signal);
        } catch (err) {
          if (!signal.aborted && !isUserCancel(err)) {
            console.warn("[passkeys] conditional UI failed:", err);
          }
        } finally { finish(); }
      })
      .catch(() => {
        // Methods probe failing degrades to password-only — unchanged behavior.
      });
    return () => controller.abort();
  }, [root, api, signedIn, isReauth]);

  async function onPasswordLogin() {
    if (!password || submitting) return;
    const signal = lifetime.current.signal;
    setSubmitting(true);
    setError(null);
    const finish = root.localWorkFlow.beginSignIn(isReauth);
    try {
      await api.login(password);
      // Cookie is set; reload so the app boots authenticated.
      await signedIn(signal);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "Login failed");
      setSubmitting(false);
    } finally { finish(); }
  }

  async function onPasskeyClick() {
    if (submitting) return;
    const signal = lifetime.current.signal;
    setSubmitting(true);
    setError(null);
    const finish = root.localWorkFlow.beginSignIn(isReauth);
    try {
      await loginWithPasskey(api, { signal });
      await signedIn(signal);
    } catch (err) {
      if (signal.aborted) return;
      if (!isUserCancel(err)) {
        setError(err instanceof Error ? err.message : "Passkey login failed");
      }
      setSubmitting(false);
    } finally { finish(); }
  }

  return (
    <LoginForm
      appName={uiConfig.appName}
      title={reauth ? reauth.revoked ? "This device was signed out" : "Your sign-in has expired" : undefined}
      notice={<>{notice && <p role="status">{notice}</p>}{reauth ? <>
        {reauth.savedThroughMs !== null && <p>Recording stopped. Saved up to {recordingTime(reauth.savedThroughMs)}.</p>}
        {!notice && <p>Your draft and recordings are kept on this device, locked until you sign in again as the same account.</p>}
        {reauth.snapshotFailed && <p role="alert">Your draft couldn't be saved on this device.</p>}
      </> : null}</>}
      localCapture={onLocalCapture ? <Button label="Record without signing in" tone="ghost" style={{ minHeight: 44 }} disabled={submitting || restoring} onClick={onLocalCapture} /> : undefined}
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
