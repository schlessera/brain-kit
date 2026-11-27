/**
 * Active standing network grants in the open chat's header, beside SessionSafety (#3595, #4967).
 * Lists `"Network: example.com, iana.org"` (or `"Network: all sites"`) with per-grant revoke.
 */
import { useEffect, useState } from "react";
import { Button, Icon } from "@schlessera/brain-ui-kit";
import type { NetworkGrantView } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";

function grantLabel(grant: NetworkGrantView): string {
  if (grant.scope === "session") return "all sites";
  if (grant.host) {
    const defaultPort =
      (grant.scheme === "http" && grant.port === 80) ||
      ((grant.scheme === "https" || grant.scheme === "connect") && grant.port === 443);
    const hostPort = grant.port && !defaultPort ? `${grant.host}:${grant.port}` : grant.host;
    return grant.transport === "connect" ? `${hostPort} · tunnel` : hostPort;
  }
  return grant.origin ?? grant.grantId;
}

export function NetworkGrantsBar() {
  const root = useBrainUiRoot();
  const sessionId = useChatStore((s) => s.activeSessionId);
  const grants = useChatStore((s) => (s.activeSessionId ? s.networkGrants[s.activeSessionId] : undefined));
  const setNetworkGrants = useChatStore((s) => s.setNetworkGrants);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void root.api.listNetworkGrants(sessionId).then(
      (res) => { if (!cancelled) setNetworkGrants(sessionId, res.grants); },
      () => { /* Older host without network-grants endpoint: stay quiet. */ }
    );
    return () => { cancelled = true; };
  }, [root, sessionId, setNetworkGrants]);

  if (!sessionId || !grants || grants.length === 0) return null;

  async function revoke(grantId: string) {
    if (!sessionId || revoking) return;
    setRevoking(grantId);
    try {
      await root.api.revokeNetworkGrant(sessionId, grantId);
      setNetworkGrants(sessionId, grants!.filter((g) => g.grantId !== grantId));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div
      data-network-grants-bar=""
      className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      aria-label="Active network grants"
    >
      <span className="flex items-center gap-1.5 font-mono">
        <Icon icon="policy" size={14} />
        <span>Network: {grants.map(grantLabel).join(", ")}</span>
      </span>
      {grants.map((grant) => {
        const label = grantLabel(grant);
        return (
          <span key={grant.grantId} className="inline-flex items-center gap-1" data-network-grant={grant.grantId}>
            {grant.suspended ? (
              <span className="font-mono text-[10px] text-amber-500">paused</span>
            ) : null}
            <Button
              label={`Revoke ${label}`}
              ariaLabel={`Revoke network grant for ${label}`}
              tone="quiet"
              size="sm"
              block={false}
              disabled={revoking === grant.grantId}
              style={{ minHeight: 32 }}
              onClick={() => { void revoke(grant.grantId); }}
            />
          </span>
        );
      })}
    </div>
  );
}
