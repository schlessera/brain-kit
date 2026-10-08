import { Button, Callout, Icon } from "@schlessera/brain-ui-kit";
import { motion } from "framer-motion";
import { Lock } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

/**
 * The login surface, rendered from props (S6). `LoginScreen` owns the methods
 * probe, the conditional-autofill ceremony, the session cookie and the
 * lifetime guards; this owns nothing but what is on screen.
 *
 * Buttons are the kit's: `primary` for the one that signs you in, and the
 * passkey button is `ghost` beside a password field or `primary` when it is
 * the only way in. The error is a red banner `Callout` inside a live region.
 * The password field stays a native input — the kit has no text input, and
 * `autoComplete="current-password webauthn"` is what lets the browser offer a
 * passkey in the field's autofill.
 *
 * Fail-open by design: `methods.password` defaults to true in the container,
 * so a failed probe still shows the one method that always works.
 */
export interface LoginMethods {
  password: boolean;
  passkey: boolean;
}

export interface LoginFormProps {
  appName: string;
  title?: string;
  notice?: ReactNode;
  localCapture?: ReactNode;
  methods: LoginMethods;
  password: string;
  busy: boolean;
  error: string | null;
  onPasswordChange: (value: string) => void;
  onPassword: () => void;
  onPasskey: () => void;
}

export function LoginForm(p: LoginFormProps) {
  const { password: passwordAvailable, passkey: passkeyAvailable } = p.methods;
  const canSubmit = passwordAvailable && p.password.length > 0 && !p.busy;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) p.onPassword();
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
          <Icon icon="brain" size={32} color="var(--bk-amber-ink)" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl text-foreground">{p.title ?? p.appName}</h1>
          {p.notice && <div className="mt-2 space-y-2 text-sm text-muted-foreground">{p.notice}</div>}
          <p className="mt-1 text-sm text-muted-foreground">
            {!passwordAvailable
              ? "Sign in with your passkey."
              : passkeyAvailable
                ? "Use your passkey or enter the password."
                : "Enter the password to continue."}
          </p>
        </div>

        {/* A form so Enter in the password field submits (implicit submission
            needs only the one field); the kit Button below calls the same
            handler, it is not a submit control. */}
        <form onSubmit={onSubmit} className="flex w-full flex-col gap-3">
          {passwordAvailable && (
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
              <input
                type="password"
                autoFocus
                autoComplete="current-password webauthn"
                value={p.password}
                onChange={(e) => p.onPasswordChange(e.target.value)}
                placeholder="Password"
                aria-label="Password"
                className="w-full rounded-lg border border-border-subtle bg-surface py-2 pl-9 pr-3 text-sm text-foreground outline-none transition-colors focus:border-primary"
              />
            </div>
          )}
          {p.error && (
            <div role="alert">
              <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
            </div>
          )}
          {passwordAvailable && (
            <Button
              label={p.busy ? "Signing in…" : "Sign in"}
              tone="primary"
              size="md"
              center
              disabled={!canSubmit}
              onClick={p.onPassword}
            />
          )}
          {passkeyAvailable && (
            <Button
              label="Sign in with a passkey"
              icon="passkey"
              tone={passwordAvailable ? "ghost" : "primary"}
              size="md"
              center
              disabled={p.busy}
              onClick={p.onPasskey}
            />
          )}
          {!passwordAvailable && !passkeyAvailable && (
            <p className="text-xs text-muted-foreground">
              Password login is disabled. Use a device or browser that supports passkeys.
            </p>
          )}
          {p.localCapture}
        </form>
      </motion.div>
    </div>
  );
}
