import { Button, Callout, ListRow, StatusDot } from "@schlessera/brain-ui-kit";
import type { PiAuthProviderStatus, PiLoginFlow } from "../../lib/api-client.js";

/**
 * Provider accounts, rendered from props (S7, the `settings` directory).
 * `PiAccountsSection` is the container: the providers request, the login
 * flow and its polling, the cancel and the disconnect live there; this
 * draws the rows and the device-code card.
 *
 * A provider is a kit card `ListRow` with its state as the trailing value
 * (teal "connected"); Connect and Disconnect are kit `Button`s beside it.
 * The pending flow is an amber `Callout` carrying the code the user types
 * at the provider's page — the verification link stays an anchor, because
 * a link is what it is — and the settled flow is a teal or red `Callout`
 * with a dismiss.
 */
export interface AccountsListProps {
  providers: PiAuthProviderStatus[];
  /** The provider whose connect or disconnect is in flight. */
  busy: string | null;
  flow: PiLoginFlow | null;
  error: string | null;
  onConnect: (providerId: string) => void;
  onDisconnect: (providerId: string) => void;
  onCancelFlow: () => void;
  onDismissFlow: () => void;
}

export function AccountsList(p: AccountsListProps) {
  const pending = p.flow?.status === "pending";
  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Accounts
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Model providers that sign in with an account instead of an API key.
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {p.providers.map((provider) => (
          <li key={provider.providerId} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ListRow
                  variant="card"
                  icon="model"
                  iconTone={provider.configured ? "teal" : "neutral"}
                  title={provider.name}
                  subtitle={provider.configured ? `Connected${provider.source ? ` · ${provider.source}` : ""}` : "Not connected"}
                  value={provider.configured ? "connected" : undefined}
                  valueTone="teal"
                />
              </div>
              {provider.oauth && !provider.configured && (
                <Button
                  label={p.busy === provider.providerId ? "Connecting…" : "Connect"}
                  icon="passkey"
                  tone="ghost"
                  size="sm"
                  block={false}
                  disabled={p.busy !== null || pending}
                  onClick={() => p.onConnect(provider.providerId)}
                />
              )}
              {provider.configured && provider.source === "stored" && (
                <span title="Disconnect" className="flex">
                  <Button label="Disconnect" icon="hand" tone="quiet" size="sm" block={false} disabled={p.busy !== null} onClick={() => p.onDisconnect(provider.providerId)} />
                </span>
              )}
            </div>
            {p.flow && p.flow.providerId === provider.providerId && (
              <LoginFlowCard flow={p.flow} onCancel={p.onCancelFlow} onDismiss={p.onDismissFlow} />
            )}
          </li>
        ))}
      </ul>
      {p.error && (
        <div role="alert" className="mt-3">
          <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
        </div>
      )}
    </div>
  );
}

function LoginFlowCard({ flow, onCancel, onDismiss }: { flow: PiLoginFlow; onCancel: () => void; onDismiss: () => void }) {
  if (flow.status === "pending") {
    return (
      <Callout tone="amber" variant="boxed" icon="passkey">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Enter this code at the provider's device page — on this or any other device:
          </p>
          <p className="select-all text-center font-[family-name:var(--font-mono)] text-xl font-semibold tracking-widest text-foreground">
            {flow.userCode ?? "…"}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {flow.verificationUri && (
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-[9px] bg-[var(--bk-amber-fill)] px-3 py-1.5 text-[11.5px] font-semibold text-[var(--bk-on-fill)] transition-[filter] hover:brightness-110"
              >
                Open verification page ↗
              </a>
            )}
            <Button label="Cancel" icon="cancel" tone="quiet" size="sm" block={false} onClick={onCancel} />
          </div>
          <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground" aria-live="polite">
            <StatusDot tone="amber" pulse size={6} />
            Waiting for approval…
          </p>
        </div>
      </Callout>
    );
  }
  const ok = flow.status === "success";
  const message = ok ? "Connected." : flow.status === "cancelled" ? "Login cancelled." : flow.error ?? "Login failed.";
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Callout tone={ok ? "teal" : "red"} variant="banner" icon={ok ? "confirm" : "failed"} mono text={message} />
      </div>
      <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={onDismiss} />
    </div>
  );
}
