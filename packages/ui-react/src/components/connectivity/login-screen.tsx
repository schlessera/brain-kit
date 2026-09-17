import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brain, Fingerprint, Lock } from "lucide-react";
import { motion } from "framer-motion";
import {
  isUserCancel,
  loginWithPasskey,
  supportsAutofill,
  supportsPasskeys,
} from "../../lib/passkeys.js";

/**
 * Login, shown when the server is in `password` auth mode and no valid session
 * cookie is present (the /api/vpn-check probe returns 401). Password is always
 * offered; a passkey button appears when the server reports registered
 * passkeys and the browser supports WebAuthn. On success the browser has the
 * HttpOnly session cookie; a reload boots the authenticated app.
 */
export function LoginScreen() {
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
          if (!signal.aborted) window.location.reload();
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
  }, [root, api]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || submitting) return;
    const signal = lifetime.current.signal;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      // Cookie is set; reload so the app boots authenticated.
      if (!signal.aborted) window.location.reload();
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
      if (!signal.aborted) window.location.reload();
    } catch (err) {
      if (signal.aborted) return;
      if (!isUserCancel(err)) {
        setError(err instanceof Error ? err.message : "Passkey login failed");
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-[100dvh] items-center justify-center bg-background">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex w-full max-w-xs flex-col items-center gap-6 px-6 text-center"
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface">
          <Brain className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl text-foreground">
            {uiConfig.appName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {!passwordAvailable
              ? "Sign in with your passkey."
              : passkeyAvailable
                ? "Use your passkey or enter the password."
                : "Enter the password to continue."}
          </p>
        </div>

        <form onSubmit={onSubmit} className="flex w-full flex-col gap-3">
          {passwordAvailable && (
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
              <input
                type="password"
                autoFocus
                autoComplete="current-password webauthn"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full rounded-lg border border-border-subtle bg-surface py-2 pl-9 pr-3 text-sm text-foreground outline-none transition-colors focus:border-primary"
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {passwordAvailable && (
            <button
              type="submit"
              disabled={submitting || !password}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          )}
          {passkeyAvailable && (
            <button
              type="button"
              onClick={onPasskeyClick}
              disabled={submitting}
              className={
                passwordAvailable
                  ? "flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary disabled:opacity-50"
                  : "flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
              }
            >
              <Fingerprint className="h-4 w-4" />
              Sign in with a passkey
            </button>
          )}
          {!passwordAvailable && !passkeyAvailable && (
            <p className="text-xs text-muted-foreground">
              Password login is disabled. Use a device or browser that supports
              passkeys.
            </p>
          )}
        </form>
      </motion.div>
    </div>
  );
}
