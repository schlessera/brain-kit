import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import type { WebSearchConfig, WebSearchProvider } from "../../lib/api-client.js";
import { useBrainUiRoot } from "../../root-context.js";
import { cn } from "../../lib/utils.js";

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
 * Enabling a provider that has no credential is blocked in the UI rather than
 * bounced by the server: the extension would skip it at search time anyway,
 * leaving a chain entry that silently never runs.
 *
 * Key values never come back from the server; the UI only ever learns "a key
 * is stored". Renders nothing when the server reports pi as not configured,
 * so the Models tab is unchanged for Claude-only deployments.
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

  const byId = new Map(config.providers.map((p) => [p.id, p]));
  const orderLabels = config.order.map((id) => byId.get(id)?.label ?? id);

  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Web search
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Enable the providers this deployment may use. Searches run them
        cheapest-first and only fall through to the next when one fails, so a
        paid provider costs nothing until it is actually needed. The agent is
        told which are enabled and can pick one deliberately. Changes apply to
        new conversations.
      </p>
      <AppliesTo models={config.appliesTo} />

      <div className="mt-4 rounded-lg border border-border-subtle bg-surface p-3">
        {config.overriddenBy && (
          <OverrideWarning
            provider={config.overriddenBy}
            busy={busy}
            onClear={() => void update({ clearOverride: true })}
          />
        )}

        <p className="text-[11px] text-muted-foreground">
          {orderLabels.length > 0 ? (
            <>
              <span className="text-foreground">Order:</span>{" "}
              {orderLabels.join(" → ")}
            </>
          ) : (
            "Nothing enabled — the extension picks for itself, starting with a free rate-limited tier."
          )}
        </p>

        <ul className="mt-3 space-y-1.5">
          {config.providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              busy={busy}
              keyOpen={openKey === p.id}
              keyDraft={keyDraft}
              setKeyDraft={setKeyDraft}
              savedFlash={savedFlash}
              onToggleKey={() => {
                setKeyDraft("");
                setOpenKey(openKey === p.id ? null : p.id);
              }}
              onToggle={() => void update({ enabled: { [p.id]: !p.enabled } })}
              onSaveKey={() => void update({ apiKeys: { [p.id]: keyDraft } })}
              onClearKey={() => void update({ apiKeys: { [p.id]: null } })}
            />
          ))}
        </ul>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Which models these toggles actually reach.
 *
 * The card is shown whenever the pi backend is configured, but a deployment
 * running both backends puts Claude models in the same picker — and those use
 * the Agent SDK's Anthropic-hosted WebSearch, which takes no provider setting.
 * Without this line the toggles look global and silently are not.
 */
function AppliesTo({ models }: { models: string[] }) {
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Applies to{" "}
      <span className="text-foreground">
        {models.length > 0 ? models.join(", ") : "the pi models"}
      </span>
      . Claude models search through Anthropic instead, which has no provider
      setting.
    </p>
  );
}

/**
 * A single-provider selection in the config file beats `searchRouting`
 * outright in the extension, and pi's own /curator command writes one back —
 * so a chain can be configured here and quietly not be what runs. Say so
 * instead of showing toggles that lie.
 */
function OverrideWarning({
  provider,
  busy,
  onClear,
}: {
  provider: string;
  busy: boolean;
  onClear: () => void;
}) {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/10 p-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-foreground">
          Searches are pinned to <span className="font-medium">{provider}</span>,
          which overrides the chain below. pi's own <code>/curator</code> command
          sets this.
        </p>
        <button
          onClick={onClear}
          disabled={busy}
          className="mt-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        >
          Use the chain instead
        </button>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  busy,
  keyOpen,
  keyDraft,
  setKeyDraft,
  savedFlash,
  onToggle,
  onToggleKey,
  onSaveKey,
  onClearKey,
}: {
  provider: WebSearchProvider;
  busy: boolean;
  keyOpen: boolean;
  keyDraft: string;
  setKeyDraft: (value: string) => void;
  savedFlash: boolean;
  onToggle: () => void;
  onToggleKey: () => void;
  onSaveKey: () => void;
  onClearKey: () => void;
}) {
  const hasCredential = provider.keyless || provider.keyConfigured || provider.keyFromEnv;
  return (
    <li className="rounded-lg border border-border-subtle bg-background p-2.5">
      {/* The switch sits in its own column; the label row carries the key chip,
          so the cost note and blurb below get the full width instead of a
          squeezed few characters. */}
      <div className="flex items-start gap-3">
        <Switch
          // A provider that lost its key must still be switchable OFF —
          // only turning one ON without a credential is blocked.
          checked={provider.enabled}
          disabled={busy || (!provider.enabled && !hasCredential)}
          label={provider.label}
          onToggle={onToggle}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-foreground">{provider.label}</p>
            {provider.hasKeyField && (
          <button
            onClick={onToggleKey}
            aria-expanded={keyOpen}
            className={cn(
              "shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
              provider.keyConfigured
                ? "border-border-subtle text-primary hover:border-primary"
                : hasCredential
                  ? "border-border-subtle text-muted-foreground hover:border-primary hover:text-foreground"
                  : "border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"
            )}
          >
            {provider.keyConfigured
              ? "Key stored"
              : provider.keyFromEnv
                ? "Key from env"
                : "Needs key"}
          </button>
            )}
          </div>
          {/* Not truncated: in a narrow settings panel a clipped "Paid —
              metered p…" tells the reader nothing, and the blurb is the whole
              reason to prefer one provider over another. */}
          <p className="text-[11px] text-muted-foreground">{provider.costNote}</p>
          <p className="text-[11px] text-muted-foreground/70">{provider.blurb}</p>
        </div>
      </div>

      {keyOpen && provider.hasKeyField && (
        <div className="mt-2">
          {provider.keyFromEnv && !provider.keyConfigured && (
            <p className="mb-1 text-[11px] text-muted-foreground">
              A key is already coming from the environment. One saved here
              takes its place.
            </p>
          )}
          {provider.keyless && !provider.keyConfigured && (
            <p className="mb-1 text-[11px] text-muted-foreground">
              Optional — the free tier works without one, a key lifts its rate
              limit.
            </p>
          )}
          <KeyEditor
            busy={busy}
            draft={keyDraft}
            setDraft={setKeyDraft}
            keyConfigured={provider.keyConfigured}
            savedFlash={savedFlash}
            onSave={onSaveKey}
            onClear={onClearKey}
          />
        </div>
      )}
    </li>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={`Enable ${label} for web search`}
      disabled={disabled}
      onClick={onToggle}
      title={disabled && !checked ? `${label} needs an API key first` : undefined}
      className={cn(
        "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40",
        checked ? "border-primary bg-primary" : "border-border-subtle bg-surface-raised"
      )}
    >
      <span
        // left-0 is load-bearing: without it the knob lays out at its static
        // position (the track's right edge) and the translate pushes it clean
        // out of the pill.
        className={cn(
          "absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-background transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
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
    <div className="flex items-center gap-2">
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
