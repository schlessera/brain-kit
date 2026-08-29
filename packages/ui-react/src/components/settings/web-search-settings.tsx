import { useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { api, type WebSearchConfig } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";

/**
 * Web-search provider settings for the pi backend's web extension
 * (pi-web-access). The default needs nothing: "Auto" starts with Exa's free
 * keyless tier. This card lets the user pick an explicit provider and store
 * its API key server-side — most usefully an Exa key, which lifts the free
 * tier's rate limit.
 *
 * Key values never come back from the server; the UI only ever learns
 * "a key is stored". Renders nothing when the server reports pi as not
 * configured, so the Models tab is unchanged for Claude-only deployments.
 */
export function WebSearchSection({ active }: { active: boolean }) {
  const [config, setConfig] = useState<WebSearchConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  async function reload() {
    try {
      const next = await api.webSearchConfig();
      setConfig(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load web-search settings");
    }
  }

  useEffect(() => {
    if (active) void reload();
  }, [active]);

  async function update(change: {
    provider?: string;
    apiKeys?: Record<string, string | null>;
  }) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.webSearchUpdate(change);
      setConfig(next);
      if (change.apiKeys) {
        setKeyDraft("");
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save web-search settings");
    } finally {
      setBusy(false);
    }
  }

  if (!config || !config.configured) return null;

  const selected = config.providers.find((p) => p.id === config.provider);
  const keyProvider = selected?.hasKeyField ? selected : null;

  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Web search
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Searches run on Exa's free tier by default — no key, rate-limited. Add
        an Exa API key to lift the limit, or pick a different provider. Changes
        apply to new conversations.
      </p>

      <div className="mt-4 rounded-lg border border-border-subtle bg-surface p-3">
        <label className="block text-[11px] font-medium text-muted-foreground">
          Provider
        </label>
        <select
          value={config.provider}
          disabled={busy}
          onChange={(e) => {
            setKeyDraft("");
            void update({ provider: e.target.value });
          }}
          className="mt-1 w-full rounded-md border border-border-subtle bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
        >
          {config.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.keyConfigured ? " · key stored" : ""}
            </option>
          ))}
        </select>

        {config.provider === "auto" && (
          <ExaKeyHint config={config} />
        )}

        {keyProvider && (
          <div className="mt-3">
            <label className="block text-[11px] font-medium text-muted-foreground">
              {keyProvider.label} API key
              {keyProvider.keyConfigured && (
                <span className="ml-2 inline-flex items-center gap-1 text-primary">
                  <Check className="h-3 w-3" /> stored
                </span>
              )}
              {keyProvider.id === "exa" && !keyProvider.keyConfigured && (
                <span className="ml-2 text-muted-foreground">
                  optional — free tier works without one
                </span>
              )}
            </label>
            <KeyEditor
              busy={busy}
              draft={keyDraft}
              setDraft={setKeyDraft}
              keyConfigured={keyProvider.keyConfigured}
              savedFlash={savedFlash}
              onSave={() => void update({ apiKeys: { [keyProvider.id]: keyDraft } })}
              onClear={() => void update({ apiKeys: { [keyProvider.id]: null } })}
            />
          </div>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/**
 * In Auto mode the Exa key still matters (Auto's first stop is Exa) — offer
 * the same editor without forcing a provider switch.
 */
function ExaKeyHint({ config }: { config: WebSearchConfig }) {
  const exa = config.providers.find((p) => p.id === "exa");
  if (!exa?.keyConfigured) return null;
  return (
    <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
      <Check className="h-3 w-3 text-primary" />
      An Exa key is stored — Auto's Exa searches run unthrottled.
    </p>
  );
}

function KeyEditor({
  busy,
  draft,
  setDraft,
  keyConfigured,
  savedFlash,
  onSave,
  onClear,
}: {
  busy: boolean;
  draft: string;
  setDraft: (value: string) => void;
  keyConfigured: boolean;
  savedFlash: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <input
        type="password"
        value={draft}
        disabled={busy}
        placeholder={keyConfigured ? "•••••••• (stored — enter to replace)" : "Paste API key"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) onSave();
        }}
        autoComplete="off"
        className="min-w-0 flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-50"
      />
      <button
        onClick={onSave}
        disabled={busy || !draft.trim()}
        className={cn(
          "flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs font-medium transition-colors",
          "text-foreground hover:border-primary hover:text-primary disabled:opacity-50"
        )}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : savedFlash ? <Check className="h-3 w-3" /> : null}
        Save
      </button>
      {keyConfigured && (
        <button
          onClick={onClear}
          disabled={busy}
          title="Remove the stored key"
          className="flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:opacity-50"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  );
}
