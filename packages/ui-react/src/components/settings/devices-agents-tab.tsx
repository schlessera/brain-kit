import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Laptop, Loader2, Plus, Trash2 } from "lucide-react";
import type { PrincipalSummary } from "../../lib/api-client.js";
import { useBrainApi } from "../../root-context.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { cn } from "../../lib/utils.js";
import { usePrincipalStore } from "../../stores/principal-store.js";

const MAX_LABEL_LENGTH = 64;
const NOT_ENABLED = "Principal management is not enabled";

function displayLabel(label: string): string {
  return Array.from(label).slice(0, MAX_LABEL_LENGTH).join("");
}

/** Active devices and delegated agents, with owner-only mint and revoke controls. */
export function DevicesAgentsTab({ active }: { active: boolean }) {
  const api = useBrainApi();
  const lifetime = useRef(0);
  const request = useRef(0);
  const [principals, setPrincipals] = useState<PrincipalSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [ttlDays, setTtlDays] = useState(7);
  const busy = usePrincipalStore((state) => state.mintPending);
  const mintError = usePrincipalStore((state) => state.mintError);
  const oneTimeCredential = usePrincipalStore(
    (state) => state.oneTimeCredential
  );
  const mintAgent = usePrincipalStore((state) => state.mintAgent);

  const refresh = useCallback(async () => {
    const generation = lifetime.current;
    const token = ++request.current;
    const current = () => generation === lifetime.current && token === request.current;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    try {
      const data = await api.principals();
      if (!current()) return;
      setPrincipals(data.principals);
      setEnabled(true);
    } catch (err) {
      if (!current()) return;
      setPrincipals([]);
      if (err instanceof Error && err.message === NOT_ENABLED) {
        setEnabled(false);
      } else {
        setEnabled(true);
        setLoadFailed(true);
        setError(err instanceof Error ? err.message : "Could not load devices and agents");
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    lifetime.current++;
    setPrincipals([]);
    setLoading(false);
    setEnabled(true);
    setLoadFailed(false);
    setError(null);
    setLabel("");
    setTtlDays(7);
    if (active) void refresh();
    const invalidate = () => { lifetime.current++; };
    return invalidate;
  }, [active, refresh]);

  useEffect(() => {
    if (!oneTimeCredential) return;
    setLabel("");
    if (active) void refresh();
  }, [active, oneTimeCredential, refresh]);

  function onMint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || busy) return;
    setError(null);
    void mintAgent(trimmed, ttlDays);
  }

  async function onRevoke(principal: PrincipalSummary) {
    const consequence = principal.is_own
      ? "This device will be signed out immediately, and you will return to sign in."
      : principal.kind === "agent"
        ? "That agent will lose access immediately."
        : "That device will be signed out immediately.";
    if (!window.confirm(`${consequence} You can't undo this.`)) return;

    const generation = lifetime.current;
    setError(null);
    try {
      await api.principalRevoke(principal.id);
      if (generation !== lifetime.current) return;
      setPrincipals((rows) => rows.filter((row) => row.id !== principal.id));
      if (principal.is_own) window.location.reload();
    } catch (err) {
      if (generation !== lifetime.current) return;
      setError(err instanceof Error ? err.message : "Could not revoke access");
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Devices &amp; agents
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        See where this brain is signed in and create time-limited access for an agent.
      </p>

      {loading ? (
        <div className="mt-6 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !enabled ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Devices and agents can only be managed when password authentication is enabled.
        </p>
      ) : loadFailed ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {error}
        </p>
      ) : (
        <>
          <ul className="mt-4 flex flex-col gap-2">
            {principals.map((principal) => (
              <PrincipalRow
                key={principal.id}
                principal={principal}
                onRevoke={() => void onRevoke(principal)}
              />
            ))}
            {principals.length === 0 ? (
              <li className="rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-muted-foreground">
                No active devices or agents.
              </li>
            ) : null}
          </ul>

          {error || mintError ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error ?? mintError}
            </p>
          ) : null}

          <form onSubmit={onMint} className="mt-6 border-t border-border pt-4">
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
              value={label}
              maxLength={MAX_LABEL_LENGTH}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Build agent"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
            <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="agent-ttl">
              Expires after
            </label>
            <select
              id="agent-ttl"
              value={ttlDays}
              onChange={(event) => setTtlDays(Number(event.target.value))}
              className="mt-1 w-full rounded-lg border border-border-subtle bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
            <button
              type="submit"
              disabled={busy || !label.trim()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create agent credential
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function PrincipalRow({
  principal,
  onRevoke,
}: {
  principal: PrincipalSummary;
  onRevoke: () => void;
}) {
  const agent = principal.kind === "agent";
  const Icon = agent ? Bot : Laptop;
  const kind = principal.is_own ? "This device" : agent ? "Agent" : "Device";

  return (
    <li
      className={cn(
        "rounded-lg border bg-surface p-3",
        principal.is_own ? "border-primary/60" : "border-border-subtle"
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-words text-sm text-foreground">
              {displayLabel(principal.label)}
            </span>
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {kind}
            </span>
          </div>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <dt>Created</dt>
            <dd>{formatRelativeTime(principal.created_at)}</dd>
            <dt>Last seen</dt>
            <dd>
              {principal.last_seen_at ? formatRelativeTime(principal.last_seen_at) : "Never"}
            </dd>
            <dt>Expires</dt>
            <dd>{formatRelativeTime(principal.expires_at)}</dd>
          </dl>
        </div>
        <button
          type="button"
          onClick={onRevoke}
          aria-label={`Revoke ${displayLabel(principal.label)}`}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Revoke
        </button>
      </div>
    </li>
  );
}
