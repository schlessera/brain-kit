import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import type {
  ModelCatalogEntry,
  ModelCatalogResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import { api } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";

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

  async function toggleHidden(entry: ModelCatalogEntry) {
    if (!catalog) return;
    const previous = catalog;
    const hidden = catalog.models
      .filter((model) =>
        model.id === entry.id ? !entry.hidden : model.hidden
      )
      .map((model) => model.id);

    // Optimistic: the list is the user's own click, so reflect it immediately
    // and roll back if the write fails.
    setCatalog({
      ...catalog,
      models: catalog.models.map((model) =>
        model.id === entry.id ? { ...model, hidden: !model.hidden } : model
      ),
    });
    setError(null);
    try {
      setCatalog(await api.setHiddenModels(hidden));
    } catch (err) {
      setCatalog(previous);
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      setCatalog(await api.refreshModels());
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

function ModelRow({
  entry,
  onToggle,
}: {
  entry: ModelCatalogEntry;
  onToggle: () => void;
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
