import { Button, Callout, Chip, Placeholder } from "@schlessera/brain-ui-kit";
import { Eye, EyeOff, X } from "lucide-react";
import {
  type BillingMode,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import { useState, type ReactNode } from "react";

/**
 * The Models tab's surface, rendered from props (S7, the `settings`
 * directory). `ModelsTab` is the container: the catalog request, the
 * optimistic commits, their ordering gate and their write queue live there;
 * this draws the roster.
 *
 * The per-row choices stay native `<select>`s with the accessible names the
 * tests read — the kit has no select — and the hide toggle stays a native,
 * titled icon button. A hidden model is no longer faded (design-feedback
 * §4, "no opacity de-emphasis"): it reads as hidden from its chip, at full
 * contrast. Refresh, Add and the section errors are the kit's.
 */
export interface ModelsCatalogViewProps {
  catalog: ModelCatalogResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** The sections the tab hosts below the roster, rendered by the container. */
  sections: ReactNode;
  onToggleHidden: (entry: ModelCatalogEntry) => void;
  onBilling: (entry: ModelCatalogEntry, next: BillingMode | "auto") => void;
  onThinking: (entry: ModelCatalogEntry, next: ThinkingLevel | "auto") => void;
  onDefault: (next: string | null) => void;
  onCustomModels: (models: string[]) => void;
  onRefresh: () => void;
}

export function ModelsCatalogView(p: ModelsCatalogViewProps) {
  const catalog = p.catalog;
  const visibleCount = catalog?.models.filter((m) => !m.hidden).length ?? 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Models
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The list is read from the provider and refreshes on its own. Hide the
          ones you never pick — running sessions are unaffected.
        </p>

        <p className="mt-2 text-xs text-muted-foreground">
          Effort set here is the default for every new message; the model picker can change it for one message.
        </p>

        {catalog && <DefaultModelSelect catalog={catalog} onChange={p.onDefault} />}

        {p.loading ? (
          <div className="mt-4">
            <Placeholder variant="loading" lines={4} />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {catalog?.models.map((entry) => (
              <ModelRow
                key={entry.id}
                entry={entry}
                onToggle={() => p.onToggleHidden(entry)}
                onBilling={(next) => p.onBilling(entry, next)}
                onThinking={(next) => p.onThinking(entry, next)}
              />
            ))}
            {catalog?.models.length === 0 && (
              <li>
                <Placeholder variant="empty" message="No models available." icon="model" />
              </li>
            )}
          </ul>
        )}

        {p.error && (
          <div role="alert" className="mt-3">
            <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
          </div>
        )}

        {catalog?.discovery.error && (
          <div className="mt-3">
            <Callout tone="gold" variant="banner" icon="unverified" mono text={`Last refresh failed (${catalog.discovery.error}). Showing the last known list.`} />
          </div>
        )}
        {catalog && !catalog.discovery.enabled && (
          <p className="mt-3 text-xs text-muted-foreground">
            Discovery is disabled (BRAIN_UI_MODEL_DISCOVERY). Only configured
            profiles are listed.
          </p>
        )}

        {catalog && <OpenRouterSection models={catalog.customModels ?? []} onChange={p.onCustomModels} />}

        {p.sections}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border p-4">
        <span className="font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
          {visibleCount} in picker · {formatRefreshed(catalog?.refreshedAt ?? null)}
        </span>
        <Button label={p.refreshing ? "Refreshing…" : "Refresh"} icon="retry" tone="ghost" size="sm" block={false} disabled={p.refreshing} onClick={p.onRefresh} />
      </div>
    </div>
  );
}

/**
 * The default-model choice: which profile answers when a turn names none —
 * a fresh device's first conversation, a share filed into the brain, any
 * host-initiated action. "Auto" prefers a connected subscription account
 * (e.g. ChatGPT for the gpt profiles) and falls back to the built-in default.
 */
function DefaultModelSelect({ catalog, onChange }: { catalog: ModelCatalogResponse; onChange: (next: string | null) => void }) {
  const stored = catalog.defaultModelId ?? null;
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const resolved = catalog.resolvedDefaultId ? byId.get(catalog.resolvedDefaultId) : undefined;
  // Offer everything visible, plus a stored default that has since been
  // hidden (dropping it from the list would silently rewrite the choice).
  const options = catalog.models.filter((model) => !model.hidden || model.id === stored);
  return (
    <div className="mt-4 flex items-center gap-3 rounded-lg border border-border-subtle bg-surface p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">Default model</p>
        <p className="text-[11px] text-muted-foreground">
          Used for new conversations, shares, and actions that don't pick one.
        </p>
      </div>
      <select
        value={stored ?? "auto"}
        onChange={(e) => onChange(e.target.value === "auto" ? null : e.target.value)}
        aria-label="Default model"
        className="h-8 max-w-[45%] shrink-0 truncate rounded-lg border border-border-subtle bg-surface px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        <option value="auto">{!stored && resolved ? `Auto (${resolved.label})` : "Auto"}</option>
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * User-managed OpenRouter models: added and removed here by model id, no env
 * change or redeploy. They appear in the roster above as ordinary profiles
 * (api-billed via OPENROUTER_API_KEY). The draft is the section's own.
 */
export function OpenRouterSection({ models, onChange }: { models: string[]; onChange: (models: string[]) => void }) {
  const [draft, setDraft] = useState("");

  function add() {
    const id = draft.trim();
    if (!id || models.includes(id)) return;
    onChange([...models, id]);
    setDraft("");
  }

  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        OpenRouter models
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Add any OpenRouter model by its id (needs OPENROUTER_API_KEY on the
        server). Added models join the list above.
      </p>
      {models.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {models.map((model) => (
            <li key={model} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-xs text-foreground">{model}</span>
              <button
                type="button"
                onClick={() => onChange(models.filter((m) => m !== model))}
                title={`Remove ${model}`}
                aria-label={`Remove ${model}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-raised hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="z.ai/glm-5.3-flash"
          aria-label="OpenRouter model id"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-2 font-[family-name:var(--font-mono)] text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
        />
        <Button label="Add" icon="add" tone="ghost" size="sm" block={false} disabled={!draft.trim()} onClick={add} />
      </div>
    </div>
  );
}

function billingLabel(mode: BillingMode): string {
  return mode === "api" ? "API" : "Subscription";
}

function ModelRow({
  entry,
  onToggle,
  onBilling,
  onThinking,
}: {
  entry: ModelCatalogEntry;
  onToggle: () => void;
  onBilling: (next: BillingMode | "auto") => void;
  onThinking: (next: ThinkingLevel | "auto") => void;
}) {
  const Icon = entry.hidden ? EyeOff : Eye;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle bg-surface p-3">
      <div className="min-w-[min(100%,12rem)] flex-1">
        <div className="flex items-center gap-2">
          <p className={entry.hidden ? "truncate text-sm text-muted-foreground" : "truncate text-sm text-foreground"}>{entry.label}</p>
          {entry.hidden && <Chip label="hidden" variant="kv" tone="neutral" />}
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {entry.id}
          {entry.contextWindow ? ` · ${formatTokens(entry.contextWindow)}` : ""}
          {entry.source === "declared" ? " · configured" : ""}
        </p>
      </div>
      {/* Reasoning effort — only for profiles that take one.
          Same tri-state pattern as billing: Default shows what it resolves
          to, an explicit pick is stored as an override. */}
      {(entry.thinkingLevel !== undefined || entry.thinkingOverride !== undefined) && (
        <select
          value={entry.thinkingOverride ?? "auto"}
          onChange={(e) => onThinking(e.target.value as ThinkingLevel | "auto")}
          aria-label={`Reasoning effort for ${entry.label}`}
          className="h-11 sm:h-8 max-w-full shrink-0 rounded-lg border border-border-subtle bg-surface px-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          <option value="auto">{!entry.thinkingOverride && entry.thinkingLevel ? `Default (${entry.thinkingLevel})` : "Default"}</option>
          {entry.thinkingOverride && !entry.supportedThinkingLevels?.includes(entry.thinkingOverride) && (
            <option value={entry.thinkingOverride}>{entry.thinkingOverride}{entry.thinkingLevel === entry.thinkingOverride ? "" : entry.thinkingLevel ? ` (runs as ${entry.thinkingLevel})` : " (uses model default)"}</option>
          )}
          {(entry.supportedThinkingLevels ?? []).map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      {/* Tri-state billing: the collapsed control always reads as the
          RESOLVED mode — the Auto option carries what auto resolves to, so
          "Auto (subscription)" and a forced "Subscription" are both legible
          at a glance. */}
      <select
        value={entry.billingOverride ?? "auto"}
        onChange={(e) => onBilling(e.target.value as BillingMode | "auto")}
        aria-label={`Billing for ${entry.label}`}
        className="h-11 sm:h-8 shrink-0 rounded-lg border border-border-subtle bg-surface px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        <option value="auto">
          {!entry.billingOverride && entry.billingMode ? `Auto (${billingLabel(entry.billingMode).toLowerCase()})` : "Auto"}
        </option>
        <option value="subscription">Subscription</option>
        <option value="api">API</option>
      </select>
      <button
        type="button"
        onClick={onToggle}
        title={entry.hidden ? "Show in picker" : "Hide from picker"}
        aria-label={entry.hidden ? "Show in picker" : "Hide from picker"}
        aria-pressed={!entry.hidden}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <Icon className="h-4 w-4" />
      </button>
    </li>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M context`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`;
  return `${tokens} context`;
}

function formatRefreshed(refreshedAt: number | null): string {
  if (refreshedAt === null) return "never refreshed";
  const minutes = Math.round((Date.now() - refreshedAt) / 60_000);
  if (minutes < 1) return "refreshed just now";
  if (minutes < 60) return `refreshed ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `refreshed ${hours}h ago`;
  return `refreshed ${Math.round(hours / 24)}d ago`;
}
