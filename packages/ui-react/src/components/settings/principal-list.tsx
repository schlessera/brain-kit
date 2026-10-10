import { Button, Callout, Chip, Placeholder, Surface } from "@schlessera/brain-ui-kit";
import type { FormEvent } from "react";

/**
 * Devices and agents, rendered from props (S7, the `settings` directory).
 * `DevicesAgentsTab` is the container: the principals request, the mint
 * through the principal store and the revoke with its confirm live there;
 * this draws the list and the mint form.
 *
 * A principal is a kit `Surface` — `strong` for this device, hairline for
 * the others — with its kind as a chip, its three timestamps as a
 * definition list (the tests read each value from its own term, so the
 * structure is the contract) and a kit danger Button named with the
 * principal label. The form's fields
 * stay native; its submit is the kit `Button`, and ⏎ in a field submits the
 * form the same way.
 */
export interface PrincipalRowData {
  id: string;
  label: string;
  kind: "owner" | "agent" | string;
  isOwn: boolean;
  created: string;
  lastSeen: string;
  expires: string;
}

export interface PrincipalListProps {
  state: "loading" | "unavailable" | "error" | "ready";
  principals: PrincipalRowData[];
  error: string | null;
  label: string;
  ttlDays: number;
  minting: boolean;
  onLabel: (value: string) => void;
  onTtlDays: (days: number) => void;
  onMint: () => void;
  onRevoke: (id: string) => void;
}

export function PrincipalList(p: PrincipalListProps) {
  const canMint = !p.minting && p.label.trim().length > 0;
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (canMint) p.onMint();
  }
  return (
    <div className="h-full overflow-y-auto p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Devices &amp; agents
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        See where this brain is signed in and create time-limited access for an agent.
      </p>

      {p.state === "loading" ? (
        <div className="mt-4">
          <Placeholder variant="loading" lines={3} />
        </div>
      ) : p.state === "unavailable" ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Devices and agents can only be managed when password authentication is enabled.
        </p>
      ) : p.state === "error" ? (
        <div role="alert" className="mt-4">
          <Callout tone="red" variant="banner" icon="failed" mono text={p.error ?? "Could not load devices and agents"} />
        </div>
      ) : (
        <>
          <ul className="mt-4 flex flex-col gap-2">
            {p.principals.map((principal) => (
              <PrincipalCard key={principal.id} principal={principal} onRevoke={() => p.onRevoke(principal.id)} />
            ))}
            {p.principals.length === 0 ? (
              <li>
                <Placeholder variant="empty" message="No active devices or agents." icon="secure" />
              </li>
            ) : null}
          </ul>

          {p.error ? (
            <div role="alert" className="mt-3">
              <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
            </div>
          ) : null}

          <form onSubmit={onSubmit} className="mt-6 border-t border-border pt-4">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agent access
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a credential an agent can use until it expires or you revoke it.
            </p>
            <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="agent-label">
              Label
            </label>
            <input
              id="agent-label"
              value={p.label}
              maxLength={64}
              onChange={(event) => p.onLabel(event.target.value)}
              placeholder="Build agent"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
            <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="agent-ttl">
              Expires after
            </label>
            <select
              id="agent-ttl"
              value={p.ttlDays}
              onChange={(event) => p.onTtlDays(Number(event.target.value))}
              className="mt-1 w-full rounded-lg border border-border-subtle bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
            <div className="mt-4">
              <Button
                label={p.minting ? "Creating…" : "Create agent credential"}
                icon="passkey"
                tone="primary"
                size="md"
                center
                disabled={!canMint}
                onClick={p.onMint}
              />
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function PrincipalCard({ principal, onRevoke }: { principal: PrincipalRowData; onRevoke: () => void }) {
  const agent = principal.kind === "agent";
  const kind = principal.isOwn ? "This device" : agent ? "Agent" : "Device";
  return (
    <li data-principal-row>
      <Surface emphasis={principal.isOwn ? "strong" : "hairline"} tone={principal.isOwn ? "amber" : undefined} pad={12}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="break-words text-sm text-foreground">{principal.label}</span>
              <Chip label={kind} variant="kv" tone={principal.isOwn ? "amber" : agent ? "purple" : "neutral"} caps />
            </div>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
              <dt>Created</dt>
              <dd>{principal.created}</dd>
              <dt>Last seen</dt>
              <dd>{principal.lastSeen}</dd>
              <dt>Expires</dt>
              <dd>{principal.expires}</dd>
            </dl>
          </div>
          <Button label="Revoke" ariaLabel={`Revoke ${principal.label}`} tone="danger" size="sm" block={false} style={{ minHeight: 44 }} onClick={onRevoke} />
        </div>
      </Surface>
    </li>
  );
}
