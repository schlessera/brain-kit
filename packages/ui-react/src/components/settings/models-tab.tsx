import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, RefreshCw, X } from "lucide-react";
import {
  THINKING_LEVELS,
  type BillingMode,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import { api } from "../../lib/api-client.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { cn } from "../../lib/utils.js";
import { PiAccountsSection } from "./pi-accounts.js";
import { WebSearchSection } from "./web-search-settings.js";

/**
 * The model picker's contents, and which of them to show.
 *
 * The roster comes from the server (Anthropic model discovery plus any
 * host-declared profiles), so this tab never hardcodes model names. Hiding is
 * presentation only — a session already pinned to a hidden model keeps running.
 */
export function ModelsTab({ active }: { active: boolean }) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const commitGate = useRef(createRequestGate());
  /** Serializes full-record PUTs — see commitCatalog. */
  const commitQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .models()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load models");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  /**
   * Optimistic-update skeleton shared by the hidden toggle and the billing
   * select: the change is the user's own click, so reflect it immediately,
   * commit, then reload the composer picker's own roster copy (fetched once
   * on mount, it would otherwise lag until a page reload). A failed write
   * rolls back and surfaces the error.
   *
   * Ordered through `createRequestGate`: two rows edited within one
   * round-trip interleave, and without the guard the FIRST response (or its
   * failure rollback) lands last and silently overwrites the newer edit. A
   * superseded response/rollback is dropped — the newer request's payload
   * was built on top of this one's optimistic state, so it already carries
   * this change (and its own catch surfaces any error that still matters).
   */
  async function commitCatalog(
    optimistic: ModelCatalogResponse,
    commit: () => Promise<ModelCatalogResponse>
  ) {
    const isCurrent = commitGate.current.begin();
    const previous = catalog;
    setCatalog(optimistic);
    setError(null);
    // The gate drops superseded RESPONSES; this queue serializes the WRITES.
    // Both matter: the server stores full records, so two concurrent PUTs
    // could land older-last and silently clobber the newer record server-side
    // even while the client looked right. Each commit waits for the previous
    // one to settle; payloads are built on optimistic state, so the newest
    // write already carries every earlier edit.
    const run = commitQueue.current.then(async () => {
      try {
        const confirmed = await commit();
        if (isCurrent()) setCatalog(confirmed);
        void loadProviders();
      } catch (err) {
        if (isCurrent()) {
          setCatalog(previous);
          setError(err instanceof Error ? err.message : "Could not save");
        }
      }
    });
    commitQueue.current = run;
    await run;
  }

  async function toggleHidden(entry: ModelCatalogEntry) {
    if (!catalog) return;
    const hidden = catalog.models
      .filter((model) =>
        model.id === entry.id ? !entry.hidden : model.hidden
      )
      .map((model) => model.id);

    await commitCatalog(
      {
        ...catalog,
        models: catalog.models.map((model) =>
          model.id === entry.id ? { ...model, hidden: !model.hidden } : model
        ),
      },
      () => api.setHiddenModels(hidden)
    );
  }

  async function changeBilling(entry: ModelCatalogEntry, next: BillingMode | "auto") {
    if (!catalog) return;

    // What "auto" resolves to is only known server-side, so switching back to
    // auto keeps the current resolved mode until the confirmed catalog
    // corrects it a beat later.
    await commitCatalog(
      {
        ...catalog,
        models: catalog.models.map((model) => {
          if (model.id !== entry.id) return model;
          const { billingOverride: _cleared, ...base } = model;
          return next === "auto" ? base : { ...base, billingOverride: next, billingMode: next };
        }),
      },
      () => api.setBillingOverrides(nextBillingOverrides(catalog.models, entry.id, next))
    );
  }

  async function changeThinking(entry: ModelCatalogEntry, next: ThinkingLevel | "auto") {
    if (!catalog) return;
    await commitCatalog(
      {
        ...catalog,
        models: catalog.models.map((model) => {
          if (model.id !== entry.id) return model;
          const { thinkingOverride: _cleared, ...base } = model;
          return next === "auto"
            ? base
            : { ...base, thinkingOverride: next, thinkingLevel: next };
        }),
      },
      () => api.setThinkingOverrides(nextThinkingOverrides(catalog.models, entry.id, next))
    );
  }

  async function changeDefault(next: string | null) {
    if (!catalog) return;
    await commitCatalog(
      { ...catalog, defaultModelId: next },
      () => api.setDefaultModel(next)
    );
  }

  async function setCustom(models: string[]) {
    if (!catalog) return;
    await commitCatalog(
      { ...catalog, customModels: models },
      () => api.setCustomModels(models)
    );
  }

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      setCatalog(await api.refreshModels());
      // A refresh can surface newly released models — put them in the picker
      // now, not on next load.
      void loadProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

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

        {catalog && (
          <DefaultModelSelect catalog={catalog} onChange={changeDefault} />
        )}

        {loading ? (
          <div className="mt-6 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {catalog?.models.map((entry) => (
              <ModelRow
                key={entry.id}
                entry={entry}
                onToggle={() => toggleHidden(entry)}
                onBilling={(next) => changeBilling(entry, next)}
                onThinking={(next) => changeThinking(entry, next)}
              />
            ))}
            {catalog?.models.length === 0 && (
              <li className="rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-muted-foreground">
                No models available.
              </li>
            )}
          </ul>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}

        {catalog?.discovery.error && (
          <p className="mt-3 text-xs text-muted-foreground">
            Last refresh failed ({catalog.discovery.error}). Showing the last
            known list.
          </p>
        )}
        {catalog && !catalog.discovery.enabled && (
          <p className="mt-3 text-xs text-muted-foreground">
            Discovery is disabled (BRAIN_UI_MODEL_DISCOVERY). Only configured
            profiles are listed.
          </p>
        )}

        {catalog && (
          <OpenRouterSection
            models={catalog.customModels ?? []}
            onChange={setCustom}
          />
        )}

        <PiAccountsSection active={active} />

        <WebSearchSection active={active} />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border p-4">
        <span className="text-[11px] text-muted-foreground">
          {visibleCount} in picker · {formatRefreshed(catalog?.refreshedAt ?? null)}
        </span>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          Refresh
        </button>
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
function DefaultModelSelect({
  catalog,
  onChange,
}: {
  catalog: ModelCatalogResponse;
  onChange: (next: string | null) => void;
}) {
  const stored = catalog.defaultModelId ?? null;
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const resolved = catalog.resolvedDefaultId
    ? byId.get(catalog.resolvedDefaultId)
    : undefined;
  // Offer everything visible, plus a stored default that has since been
  // hidden (dropping it from the list would silently rewrite the choice).
  const options = catalog.models.filter(
    (model) => !model.hidden || model.id === stored
  );
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
        <option value="auto">
          {!stored && resolved ? `Auto (${resolved.label})` : "Auto"}
        </option>
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
 * (api-billed via OPENROUTER_API_KEY).
 */
function OpenRouterSection({
  models,
  onChange,
}: {
  models: string[];
  onChange: (models: string[]) => void;
}) {
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
            <li
              key={model}
              className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-xs text-foreground">
                {model}
              </span>
              <button
                onClick={() => onChange(models.filter((m) => m !== model))}
                title={`Remove ${model}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-raised hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="z.ai/glm-5.3-flash"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-2 font-[family-name:var(--font-mono)] text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="h-8 shrink-0 rounded-lg border border-border-subtle bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Request-ordering guard for optimistic commits: `begin()` claims a token
 * and returns a predicate that holds only while no later request has begun.
 * An older in-flight request must never write over a newer edit's state.
 */
export function createRequestGate(): { begin: () => () => boolean } {
  let seq = 0;
  return {
    begin() {
      const token = ++seq;
      return () => seq === token;
    },
  };
}

/**
 * The billing-override record PUT after changing one profile: every other
 * profile keeps its stored override, the changed one is set — or, for "auto",
 * REMOVED, never stored as a redundant explicit value.
 */
export function nextBillingOverrides(
  models: ModelCatalogEntry[],
  id: string,
  next: BillingMode | "auto"
): Record<string, BillingMode> {
  const billing: Record<string, BillingMode> = {};
  for (const model of models) {
    const value = model.id === id ? (next === "auto" ? undefined : next) : model.billingOverride;
    if (value) billing[model.id] = value;
  }
  return billing;
}

function billingLabel(mode: BillingMode): string {
  return mode === "api" ? "API" : "Subscription";
}

/**
 * The effort-override record PUT after changing one profile: every other
 * profile keeps its stored override, the changed one is set — or, for "auto",
 * REMOVED, never stored as a redundant explicit value.
 */
export function nextThinkingOverrides(
  models: ModelCatalogEntry[],
  id: string,
  next: ThinkingLevel | "auto"
): Record<string, ThinkingLevel> {
  const thinking: Record<string, ThinkingLevel> = {};
  for (const model of models) {
    const value =
      model.id === id ? (next === "auto" ? undefined : next) : model.thinkingOverride;
    if (value) thinking[model.id] = value;
  }
  return thinking;
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
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border-subtle bg-surface p-3",
        entry.hidden && "opacity-50"
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{entry.label}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {entry.id}
          {entry.contextWindow ? ` · ${formatTokens(entry.contextWindow)}` : ""}
          {entry.source === "declared" ? " · configured" : ""}
        </p>
      </div>
      {/* Reasoning effort — only for profiles that take one (the gpt models).
          Same tri-state pattern as billing: Default shows what it resolves
          to, an explicit pick is stored as an override. */}
      {entry.thinkingLevel && (
        <select
          value={entry.thinkingOverride ?? "auto"}
          onChange={(e) => onThinking(e.target.value as ThinkingLevel | "auto")}
          aria-label={`Reasoning effort for ${entry.label}`}
          className="h-8 shrink-0 rounded-lg border border-border-subtle bg-surface px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          <option value="auto">
            {!entry.thinkingOverride ? `Default (${entry.thinkingLevel})` : "Default"}
          </option>
          {THINKING_LEVELS.map((level) => (
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
        className="h-8 shrink-0 rounded-lg border border-border-subtle bg-surface px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        <option value="auto">
          {!entry.billingOverride && entry.billingMode
            ? `Auto (${billingLabel(entry.billingMode).toLowerCase()})`
            : "Auto"}
        </option>
        <option value="subscription">Subscription</option>
        <option value="api">API</option>
      </select>
      <button
        onClick={onToggle}
        title={entry.hidden ? "Show in picker" : "Hide from picker"}
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
