import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, LogOut, X } from "lucide-react";
import { api, type PiAuthProviderStatus, type PiLoginFlow } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";

/**
 * Provider sign-in for the pi backend's OAuth vendors — most importantly
 * OpenAI (ChatGPT Plus/Pro), whose device-code flow needs no browser callback
 * on the server: the user gets a short code here, enters it at the provider's
 * verification page on ANY device, and the server stores the credential.
 *
 * Renders nothing when the server reports no pi providers (pi not
 * configured), so the Models tab is unchanged for Claude-only deployments.
 */
export function PiAccountsSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const [providers, setProviders] = useState<PiAuthProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flow, setFlow] = useState<PiLoginFlow | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function reload() {
    try {
      const { providers } = await api.piAuthProviders();
      setProviders(providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load accounts");
    }
  }

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api
      .piAuthProviders()
      .then(({ providers }) => {
        if (!cancelled) setProviders(providers);
      })
      .catch(() => {
        // A server without the endpoint (older release) just hides the card.
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Poll the pending flow until it settles. Chained timeouts rather than an
  // interval, so a slow response never stacks requests.
  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    let disposed = false;
    const delayMs = (flow.intervalSeconds ?? 5) * 1000;
    const tick = async () => {
      try {
        const { flow: next } = await api.piAuthFlow(flow.id);
        if (disposed) return;
        setFlow(next);
        if (next.status === "success") {
          void reload();
          // A connected subscription account can change the picker's default
          // ordering — refresh the composer's roster copy too.
          void root.stores.provider.getState().loadProviders();
        }
      } catch {
        if (disposed) return;
        // Transient poll failure: keep trying until the flow expires.
        pollTimer.current = setTimeout(tick, delayMs);
        return;
      }
    };
    pollTimer.current = setTimeout(tick, delayMs);
    return () => {
      disposed = true;
      stopPolling();
    };
  }, [flow, root]);

  async function connect(providerId: string) {
    setBusy(providerId);
    setError(null);
    try {
      const { flow } = await api.piAuthStart(providerId);
      setFlow(flow);
      if (flow.status === "error") setError(flow.error ?? "Login failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start login");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!flow) return;
    stopPolling();
    try {
      await api.piAuthCancel(flow.id);
    } catch {
      // The flow record may already be gone; clearing locally is enough.
    }
    setFlow(null);
  }

  async function disconnect(providerId: string) {
    setBusy(providerId);
    setError(null);
    try {
      await api.piAuthLogout(providerId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(null);
    }
  }

  if (providers.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Accounts
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Model providers that sign in with an account instead of an API key.
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {providers.map((provider) => (
          <li
            key={provider.providerId}
            className="rounded-lg border border-border-subtle bg-surface p-3"
          >
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{provider.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {provider.configured
                    ? `Connected${provider.source ? ` · ${provider.source}` : ""}`
                    : "Not connected"}
                </p>
              </div>
              {provider.configured && (
                <Check className="h-4 w-4 shrink-0 text-accent" />
              )}
              {provider.oauth && !provider.configured && (
                <button
                  onClick={() => connect(provider.providerId)}
                  disabled={busy !== null || flow?.status === "pending"}
                  className="shrink-0 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  {busy === provider.providerId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Connect"
                  )}
                </button>
              )}
              {provider.configured && provider.source === "stored" && (
                <button
                  onClick={() => disconnect(provider.providerId)}
                  disabled={busy !== null}
                  title="Disconnect"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-raised hover:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              )}
            </div>

            {flow && flow.providerId === provider.providerId && (
              <LoginFlowCard flow={flow} onCancel={cancel} onDismiss={() => setFlow(null)} />
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function LoginFlowCard({
  flow,
  onCancel,
  onDismiss,
}: {
  flow: PiLoginFlow;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (flow.status === "pending") {
    return (
      <div className="mt-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
        <p className="text-xs text-muted-foreground">
          Enter this code at the provider's device page — on this or any other
          device:
        </p>
        <p className="mt-2 select-all text-center font-[family-name:var(--font-mono)] text-xl font-semibold tracking-widest text-foreground">
          {flow.userCode ?? "…"}
        </p>
        <div className="mt-3 flex items-center justify-center gap-2">
          {flow.verificationUri && (
            <a
              href={flow.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110"
            >
              <ExternalLink className="h-3 w-3" />
              Open verification page
            </a>
          )}
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        </div>
        <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for approval…
        </p>
      </div>
    );
  }

  const message =
    flow.status === "success"
      ? "Connected."
      : flow.status === "cancelled"
        ? "Login cancelled."
        : flow.error ?? "Login failed.";
  return (
    <div
      className={cn(
        "mt-3 flex items-center justify-between rounded-lg border p-3 text-xs",
        flow.status === "success"
          ? "border-border-subtle text-muted-foreground"
          : "border-destructive/30 text-destructive"
      )}
    >
      <span>{message}</span>
      <button
        onClick={onDismiss}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
