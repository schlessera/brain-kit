import { useCallback, useEffect, useRef, useState } from "react";
import type { PrincipalSummary } from "../../lib/api-client.js";
import { useBrainApi } from "../../root-context.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { usePrincipalStore } from "../../stores/principal-store.js";
import { PrincipalList } from "./principal-list.js";

const MAX_LABEL_LENGTH = 64;
const NOT_ENABLED = "Principal management is not enabled";

function displayLabel(label: string): string {
  return Array.from(label).slice(0, MAX_LABEL_LENGTH).join("");
}

/**
 * Active devices and delegated agents, with owner-only mint and revoke
 * controls. This is the container (S7): the principals request, the mint
 * through the principal store and the revoke with its confirm live here;
 * `PrincipalList` draws the list and the form on the kit.
 */
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

  function onMint() {
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
    <PrincipalList
      state={loading ? "loading" : !enabled ? "unavailable" : loadFailed ? "error" : "ready"}
      principals={principals.map((principal) => ({
        id: principal.id,
        label: displayLabel(principal.label),
        kind: principal.kind,
        isOwn: principal.is_own,
        created: formatRelativeTime(principal.created_at),
        lastSeen: principal.last_seen_at ? formatRelativeTime(principal.last_seen_at) : "Never",
        expires: formatRelativeTime(principal.expires_at),
      }))}
      error={error ?? mintError}
      label={label}
      ttlDays={ttlDays}
      minting={busy}
      onLabel={setLabel}
      onTtlDays={setTtlDays}
      onMint={onMint}
      onRevoke={(id) => {
        const principal = principals.find((row) => row.id === id);
        if (principal) void onRevoke(principal);
      }}
    />
  );
}
