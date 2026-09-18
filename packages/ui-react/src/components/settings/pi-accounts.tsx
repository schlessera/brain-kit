import { useBrainUiRoot } from "../../root-context.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PiAuthProviderStatus, PiLoginFlow } from "../../lib/api-client.js";
import type { BrainUiRoot } from "../../root.js";
import { AccountsList } from "./pi-accounts-list.js";

/**
 * Provider sign-in for the pi backend's OAuth vendors — most importantly
 * OpenAI (ChatGPT Plus/Pro), whose device-code flow needs no browser callback
 * on the server: the user gets a short code here, enters it at the provider's
 * verification page on ANY device, and the server stores the credential.
 *
 * Renders nothing when the server reports no pi providers (pi not
 * configured), so the Models tab is unchanged for Claude-only deployments.
 *
 * This is the container (S7): the request, the flow and its polling, the
 * cancel and the disconnect live here; `AccountsList` draws the rows.
 */
export function PiAccountsSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(0);
  const listRequest = useRef(0);
  const flowRequest = useRef(0);
  const [providers, setProviders] = useState<PiAuthProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ownedFlow, setOwnedFlow] = useState<{ root: BrainUiRoot; flow: PiLoginFlow } | null>(null);
  // The first render after root replacement must not poll the previous flow
  // through the new API, even before the reset effect has run.
  const flow = ownedFlow?.root === root ? ownedFlow.flow : null;
  const setFlow = useCallback((flow: PiLoginFlow | null) => {
    setOwnedFlow(flow ? { root, flow } : null);
  }, [root]);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  const reload = useCallback(async (quiet = false) => {
    const generation = lifetime.current;
    const request = ++listRequest.current;
    const current = () => generation === lifetime.current && request === listRequest.current;
    try {
      const { providers } = await api.piAuthProviders();
      if (current()) setProviders(providers);
    } catch (err) {
      if (!current()) return;
      // Older servers without this endpoint simply hide the initial card.
      if (quiet) setProviders([]);
      else setError(err instanceof Error ? err.message : "Could not load accounts");
    }
  }, [api]);

  useEffect(() => {
    lifetime.current++;
    setProviders([]);
    setError(null);
    setBusy(null);
    setFlow(null);
    if (active) void reload(true);
    const invalidate = () => { lifetime.current++; };
    return invalidate;
  }, [active, root, reload, setFlow]);

  // Poll the pending flow until it settles. Chained timeouts rather than an
  // interval, so a slow response never stacks requests.
  useEffect(() => {
    if (!active || !flow || flow.status !== "pending") return;
    const generation = lifetime.current;
    const request = flowRequest.current;
    let disposed = false;
    const current = () => !disposed && generation === lifetime.current && request === flowRequest.current;
    const delayMs = (flow.intervalSeconds ?? 5) * 1000;
    const tick = async () => {
      try {
        if (!current()) return;
        const { flow: next } = await api.piAuthFlow(flow.id);
        if (!current()) return;
        setFlow(next);
        if (next.status === "success") {
          void reload();
          // A connected subscription account can change the picker's default
          // ordering — refresh the composer's roster copy too.
          void root.stores.provider.getState().loadProviders();
        }
      } catch {
        if (!current()) return;
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
  }, [active, flow, root, api, reload, setFlow]);

  async function connect(providerId: string) {
    const generation = lifetime.current;
    const request = ++flowRequest.current;
    const current = () => generation === lifetime.current && request === flowRequest.current;
    setBusy(providerId);
    setError(null);
    try {
      const { flow } = await api.piAuthStart(providerId);
      if (!current()) return;
      setFlow(flow);
      if (flow.status === "error") setError(flow.error ?? "Login failed");
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : "Could not start login");
    } finally {
      if (current()) setBusy(null);
    }
  }

  async function cancel() {
    if (!flow) return;
    flowRequest.current++;
    stopPolling();
    setFlow(null);
    try {
      await api.piAuthCancel(flow.id);
    } catch {
      // The flow record may already be gone; clearing locally is enough.
    }
  }

  async function disconnect(providerId: string) {
    const generation = lifetime.current;
    const current = () => generation === lifetime.current;
    setBusy(providerId);
    setError(null);
    try {
      await api.piAuthLogout(providerId);
      if (!current()) return;
      await reload();
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      if (current()) setBusy(null);
    }
  }

  if (providers.length === 0) return null;

  return (
    <AccountsList
      providers={providers}
      busy={busy}
      flow={flow}
      error={error}
      onConnect={(id) => void connect(id)}
      onDisconnect={(id) => void disconnect(id)}
      onCancelFlow={() => void cancel()}
      onDismissFlow={() => setFlow(null)}
    />
  );
}
