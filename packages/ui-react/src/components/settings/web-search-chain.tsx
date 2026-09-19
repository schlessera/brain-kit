import { Button, Toggle } from "@schlessera/brain-ui-kit";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { WebSearchConfig, WebSearchProvider } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";

/**
 * The web-search provider chain, rendered from props (S6). `WebSearchSection`
 * is the container: it owns the load, the update round-trip, the lifetime
 * guards and the two-second "saved" flash. This owns nothing but what is on
 * screen, and every event it raises names the provider it is about.
 *
 * Providers are toggles, not one choice: the enabled set becomes an ordered
 * chain, cheapest first, so ordinary searches run on a free provider and a
 * paid one is only reached when the cheap ones fail. Enabling a provider that
 * has no credential is blocked here rather than bounced by the server: the
 * extension would skip it at search time anyway, leaving a chain entry that
 * silently never runs. A provider that LOST its key must still be switchable
 * off, so only turning one on without a credential is refused.
 *
 * The switch is the kit's `Toggle`, named "Enable <provider> for web search",
 * and the buttons are the kit's. The key-chip that opens the editor stays a
 * native button: the kit's `Chip` is a mark, not a control, and this chip is
 * a disclosure with `aria-expanded`. The key field stays a native input for
 * the same reason the login form's does — the kit has no text input.
 *
 * Key values never come back from the server; the view only ever learns "a
 * key is stored".
 */
export interface WebSearchChainProps {
  config: WebSearchConfig;
  busy: boolean;
  error: string | null;
  /** The provider whose key editor is open, if any. */
  openKey: string | null;
  keyDraft: string;
  savedFlash: boolean;
  onToggle: (id: string) => void;
  onToggleKey: (id: string) => void;
  onKeyDraft: (value: string) => void;
  onSaveKey: (id: string) => void;
  onClearKey: (id: string) => void;
  onClearOverride: () => void;
}

export function WebSearchChain(p: WebSearchChainProps) {
  const { config } = p;
  const byId = new Map(config.providers.map((provider) => [provider.id, provider]));
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
          <OverrideWarning provider={config.overriddenBy} busy={p.busy} onClear={p.onClearOverride} />
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
          {config.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              busy={p.busy}
              keyOpen={p.openKey === provider.id}
              keyDraft={p.keyDraft}
              savedFlash={p.savedFlash}
              onKeyDraft={p.onKeyDraft}
              onToggle={() => p.onToggle(provider.id)}
              onToggleKey={() => p.onToggleKey(provider.id)}
              onSaveKey={() => p.onSaveKey(provider.id)}
              onClearKey={() => p.onClearKey(provider.id)}
            />
          ))}
        </ul>

        {p.error && <p className="mt-2 text-xs text-destructive">{p.error}</p>}
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
function OverrideWarning({ provider, busy, onClear }: { provider: string; busy: boolean; onClear: () => void }) {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md border border-primary/40 bg-primary-fill/10 p-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-foreground">
          Searches are pinned to <span className="font-medium">{provider}</span>,
          which overrides the chain below. pi's own <code>/curator</code> command
          sets this.
        </p>
        <div className="mt-1.5">
          <Button label="Use the chain instead" tone="ghost" size="sm" block={false} disabled={busy} onClick={onClear} />
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  busy,
  keyOpen,
  keyDraft,
  savedFlash,
  onKeyDraft,
  onToggle,
  onToggleKey,
  onSaveKey,
  onClearKey,
}: {
  provider: WebSearchProvider;
  busy: boolean;
  keyOpen: boolean;
  keyDraft: string;
  savedFlash: boolean;
  onKeyDraft: (value: string) => void;
  onToggle: () => void;
  onToggleKey: () => void;
  onSaveKey: () => void;
  onClearKey: () => void;
}) {
  const hasCredential = provider.keyless || provider.keyConfigured || provider.keyFromEnv;
  const switchable = provider.enabled || hasCredential;
  return (
    <li className="rounded-lg border border-border-subtle bg-background p-2.5">
      {/* The switch sits in its own column; the label row carries the key chip,
          so the cost note and blurb below get the full width instead of a
          squeezed few characters. The gap between rows (space-y-1.5 plus the
          row padding) clears the switch's 11px vertical reach. */}
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex shrink-0"
          title={!switchable ? `${provider.label} needs an API key first` : undefined}
        >
          <Toggle
            on={provider.enabled}
            tone="amber"
            label={`Enable ${provider.label} for web search`}
            disabled={busy || !switchable}
            onClick={onToggle}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-foreground">{provider.label}</p>
            {provider.hasKeyField && (
              <button
                type="button"
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
                {provider.keyConfigured ? "Key stored" : provider.keyFromEnv ? "Key from env" : "Needs key"}
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
            onDraft={onKeyDraft}
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

function KeyEditor({
  busy,
  draft,
  onDraft,
  keyConfigured,
  savedFlash,
  onSave,
  onClear,
}: {
  busy: boolean;
  draft: string;
  onDraft: (value: string) => void;
  keyConfigured: boolean;
  savedFlash: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  const canSave = !busy && draft.trim().length > 0;
  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={draft}
        disabled={busy}
        aria-label="API key"
        placeholder={keyConfigured ? "•••••••• (stored — enter to replace)" : "Paste API key"}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSave) onSave();
        }}
        autoComplete="off"
        className="min-w-0 flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-50"
      />
      {/* The kit Button has no slot for a leading spinner or check, so the
          state glyph sits beside it rather than inside; the label never
          changes, so the control keeps its name while it is busy. */}
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
      ) : savedFlash ? (
        <Check className="h-3 w-3 text-primary" aria-hidden />
      ) : null}
      <Button label="Save" tone="ghost" size="sm" block={false} disabled={!canSave} onClick={onSave} />
      {keyConfigured && (
        <span title="Remove the stored key" className="flex">
          <Button label="Clear" icon="dismiss" tone="danger" size="sm" block={false} disabled={busy} onClick={onClear} />
        </span>
      )}
    </div>
  );
}
