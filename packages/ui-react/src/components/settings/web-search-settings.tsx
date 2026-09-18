import { useCallback, useEffect, useRef, useState } from "react";
import type { WebSearchConfig } from "../../lib/api-client.js";
import { useBrainUiRoot } from "../../root-context.js";
import { WebSearchChain } from "./web-search-chain.js";

/**
 * Web-search provider settings for the pi backend's web extension
 * (pi-web-access).
 *
 * Providers are toggles, not one choice: the enabled set becomes an ordered
 * chain, cheapest first, so ordinary searches run on a free provider and a
 * paid one is only reached when the cheap ones fail. The agent is told the
 * same list and can name a specific provider per search when a question
 * warrants it.
 *
 * This is the container (S6): it owns the load, the update round-trip, the
 * per-root lifetime guards and the "saved" flash, and hands everything on
 * screen to `WebSearchChain`. Renders nothing when the server reports pi as
 * not configured, so the Models tab is unchanged for Claude-only deployments.
 */
export function WebSearchSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [config, setConfig] = useState<WebSearchConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  const reload = useCallback(async () => {
    const generation = lifetime.current;
    try {
      const next = await api.webSearchConfig();
      if (generation !== lifetime.current) return;
      setConfig(next);
      setError(null);
    } catch (err) {
      if (generation === lifetime.current) setError(err instanceof Error ? err.message : "Could not load web-search settings");
    }
  }, [api]);

  useEffect(() => {
    lifetime.current++;
    setConfig(null);
    setError(null);
    setBusy(false);
    setOpenKey(null);
    setKeyDraft("");
    setSavedFlash(false);
    if (active) void reload();
    const invalidate = () => {
      lifetime.current++;
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    };
    return invalidate;
  }, [active, root, reload]);

  async function update(change: {
    enabled?: Record<string, boolean>;
    apiKeys?: Record<string, string | null>;
    clearOverride?: boolean;
  }) {
    const generation = lifetime.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.webSearchUpdate(change);
      if (generation !== lifetime.current) return;
      setConfig(next);
      if (change.apiKeys) {
        setKeyDraft("");
        setSavedFlash(true);
        if (flashTimer.current !== null) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => {
          if (generation === lifetime.current) setSavedFlash(false);
        }, 2000);
      }
    } catch (err) {
      if (generation === lifetime.current) setError(err instanceof Error ? err.message : "Could not save web-search settings");
    } finally {
      if (generation === lifetime.current) setBusy(false);
    }
  }

  if (!config || !config.configured) return null;

  return (
    <WebSearchChain
      config={config}
      busy={busy}
      error={error}
      openKey={openKey}
      keyDraft={keyDraft}
      savedFlash={savedFlash}
      onToggle={(id) => {
        const provider = config.providers.find((p) => p.id === id);
        if (provider) void update({ enabled: { [id]: !provider.enabled } });
      }}
      onToggleKey={(id) => {
        setKeyDraft("");
        setOpenKey(openKey === id ? null : id);
      }}
      onKeyDraft={setKeyDraft}
      onSaveKey={(id) => void update({ apiKeys: { [id]: keyDraft } })}
      onClearKey={(id) => void update({ apiKeys: { [id]: null } })}
      onClearOverride={() => void update({ clearOverride: true })}
    />
  );
}
