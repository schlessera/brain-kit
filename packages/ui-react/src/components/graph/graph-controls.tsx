import { useEffect, useRef, useState } from "react";
import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { api, type BrainSearchHit } from "../../lib/api-client.js";
import {
  useGraphStore,
  type DiscoveryColorBy,
  type LocalDirection,
  type SizeBy,
} from "../../stores/graph-store.js";
import { cn } from "../../lib/utils.js";

/**
 * Per-mode option forms. Desktop: a floating card in the top-right of the
 * canvas. Mobile: a slide-up sheet behind a filter button (tap targets kept
 * at ≥44px). Only the options that matter per mode — everything else stays
 * out until a later phase earns it.
 */
export function GraphControls() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile: floating filter button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-overlay text-foreground shadow-lg md:hidden"
        title="Graph options"
      >
        <SlidersHorizontal className="h-4.5 w-4.5" />
      </button>

      {/* Desktop: docked card */}
      <div className="absolute right-4 top-4 z-10 hidden w-64 rounded-xl border border-border bg-surface-overlay/95 p-4 shadow-xl backdrop-blur md:block">
        <ControlsBody />
      </div>

      {/* Mobile: bottom sheet */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-background/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">Graph options</h3>
              <button
                onClick={() => setMobileOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ControlsBody />
          </div>
        </div>
      )}
    </>
  );
}

function ControlsBody() {
  const mode = useGraphStore((s) => s.mode);
  return (
    <div className="flex flex-col gap-4">
      <SceneSearch />
      {mode === "local" && <LocalControls />}
      {mode === "discovery" && <DiscoveryControls />}
      {mode === "clusters" && <ClustersControls />}
      {mode === "maintenance" && <MaintenanceControls />}
    </div>
  );
}

/** Highlights matches in the current scene — no refetch. */
function SceneSearch() {
  const sceneQuery = useGraphStore((s) => s.sceneQuery);
  const setSceneQuery = useGraphStore((s) => s.setSceneQuery);
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 py-2 focus-within:border-primary/40">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        value={sceneQuery}
        onChange={(e) => setSceneQuery(e.target.value)}
        placeholder="Highlight in graph…"
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        autoComplete="off"
        spellCheck={false}
      />
      {sceneQuery && (
        <button
          onClick={() => setSceneQuery("")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title="Clear"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </label>
  );
}

function LocalControls() {
  const local = useGraphStore((s) => s.local);
  const setLocalParams = useGraphStore((s) => s.setLocalParams);

  return (
    <>
      <Field label="Center note">
        <NotePicker
          value={local.center}
          onPick={(path) => setLocalParams({ center: path })}
        />
      </Field>
      <Field label="Depth">
        <Segmented
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
          ]}
          value={String(local.depth)}
          onChange={(v) => setLocalParams({ depth: Number(v) as 1 | 2 | 3 })}
        />
      </Field>
      <Field label="Direction">
        <Segmented
          options={[
            { value: "in", label: "In" },
            { value: "out", label: "Out" },
            { value: "both", label: "Both" },
          ]}
          value={local.direction}
          onChange={(v) => setLocalParams({ direction: v as LocalDirection })}
        />
      </Field>
    </>
  );
}

function DiscoveryControls() {
  const discovery = useGraphStore((s) => s.discovery);
  const setDiscoveryParams = useGraphStore((s) => s.setDiscoveryParams);
  const colorBy = useGraphStore((s) => s.discoveryColorBy);
  const setColorBy = useGraphStore((s) => s.setDiscoveryColorBy);
  const defaultRoot = useGraphStore((s) => s.meta?.defaultRoot ?? null);

  return (
    <>
      <Field label="Root">
        <NotePicker
          value={discovery.root ?? defaultRoot?.path ?? null}
          placeholder={defaultRoot ? defaultRoot.path : "Pick a root note…"}
          onPick={(path) => setDiscoveryParams({ root: path })}
        />
        {discovery.root && defaultRoot && (
          <button
            onClick={() => setDiscoveryParams({ root: null })}
            className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Reset to default root
          </button>
        )}
      </Field>
      <Field label={`Max depth: ${discovery.maxDepth}`}>
        <input
          type="range"
          min={1}
          max={8}
          value={discovery.maxDepth}
          onChange={(e) => setDiscoveryParams({ maxDepth: Number(e.target.value) })}
          className="w-full accent-(--color-primary)"
        />
      </Field>
      <Field label="Color by">
        <Segmented
          options={[
            { value: "distance", label: "Distance" },
            { value: "folder", label: "Folder" },
          ]}
          value={colorBy}
          onChange={(v) => setColorBy(v as DiscoveryColorBy)}
        />
      </Field>
      {/* Direction is only meaningful with an explicit root: the default-root
          distances were walked once at index time. */}
    </>
  );
}

function ClustersControls() {
  const clusters = useGraphStore((s) => s.clusters);
  const setClustersParams = useGraphStore((s) => s.setClustersParams);
  const sizeBy = useGraphStore((s) => s.clustersSizeBy);
  const setSizeBy = useGraphStore((s) => s.setClustersSizeBy);
  return (
    <>
      <Field label="Node size">
        <Segmented
          options={[
            { value: "degree", label: "Links" },
            { value: "pagerank", label: "PageRank" },
          ]}
          value={sizeBy}
          onChange={(v) => setSizeBy(v as SizeBy)}
        />
      </Field>
      <Field label="Isolated notes">
        <Toggle
          checked={clusters.isolates}
          onChange={(v) => setClustersParams({ isolates: v })}
          label="Include notes without links"
        />
      </Field>
    </>
  );
}

function MaintenanceControls() {
  const maintenance = useGraphStore((s) => s.maintenance);
  const setMaintenanceParams = useGraphStore((s) => s.setMaintenanceParams);
  const filters = useGraphStore((s) => s.maintenanceFilters);
  const setFilters = useGraphStore((s) => s.setMaintenanceFilters);
  return (
    <>
      <Field label="Findings">
        <div className="flex flex-col">
          <Toggle
            checked={filters.orphans}
            onChange={(v) => setFilters({ orphans: v })}
            label="Orphans"
          />
          <Toggle
            checked={filters.unreachable}
            onChange={(v) => setFilters({ unreachable: v })}
            label="Unreachable"
          />
          <Toggle
            checked={filters.broken}
            onChange={(v) => setFilters({ broken: v })}
            label="Broken links"
          />
          <Toggle
            checked={filters.stale}
            onChange={(v) => setFilters({ stale: v })}
            label="Stale notes"
          />
        </div>
      </Field>
      <Field label={`Stale after ${maintenance.staleDays} days`}>
        <input
          type="range"
          min={30}
          max={720}
          step={30}
          value={maintenance.staleDays}
          onChange={(e) => setMaintenanceParams({ staleDays: Number(e.target.value) })}
          className="w-full accent-(--color-primary)"
        />
      </Field>
    </>
  );
}

// --- Small form primitives ---------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-border bg-surface-raised p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "min-h-9 flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            value === opt.value
              ? "bg-surface-overlay text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-9 w-full items-center justify-between gap-2 text-left text-xs text-foreground"
    >
      {label}
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-surface-raised border border-border"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-foreground transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5"
          )}
        />
      </span>
    </button>
  );
}

/**
 * Debounced note search backed by /api/brain/search — the graph twin of the
 * search modal's flow, inlined so picking a center/root never leaves the view.
 */
function NotePicker({
  value,
  placeholder = "Search notes…",
  onPick,
}: {
  value: string | null;
  placeholder?: string;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [results, setResults] = useState<BrainSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    if (!editing || trimmed.length < 2) {
      controllerRef.current?.abort();
      setResults([]);
      setLoading(false);
      return;
    }
    const t = setTimeout(async () => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      try {
        const res = await api.brainSearch(trimmed, {
          limit: 8,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setResults(res.results);
      } catch {
        // Aborted or failed — the next keystroke retries.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [editing, trimmed]);

  return (
    <div className="relative">
      <label className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 py-2 focus-within:border-primary/40">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={editing ? query : (value ?? "")}
          onFocus={() => {
            setEditing(true);
            setQuery("");
          }}
          onBlur={() => {
            // Delay so a click on a result lands before the list unmounts.
            setTimeout(() => setEditing(false), 150);
          }}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:font-body placeholder:text-xs placeholder:text-muted-foreground"
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
      </label>
      {editing && results.length > 0 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface-overlay shadow-2xl">
          {results.map((hit) => (
            <button
              key={hit.path}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(hit.path);
                setEditing(false);
              }}
              className="flex w-full flex-col px-3 py-2 text-left transition-colors hover:bg-surface-raised"
            >
              <span className="truncate text-xs text-foreground">
                {hit.title || hit.path}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground/60">
                {hit.path}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
