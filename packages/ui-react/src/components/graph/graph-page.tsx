import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

import { useGraphStore, type GraphMode } from "../../stores/graph-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { FilePanel } from "../files/file-panel.js";
import { SettingsPanel } from "../settings/settings-panel.js";
import { GraphControls } from "./graph-controls.js";
import { GraphEmptyState, Mono } from "./graph-empty-state.js";
import { MaintenanceBody } from "./graph-maintenance.js";
import { DiscoveryStart, SceneBody } from "./graph-scene.js";
import { CenteredSpinner } from "./graph-spinner.js";
import { cn } from "../../lib/utils.js";

const MODES: { value: GraphMode; label: string }[] = [
  { value: "clusters", label: "Clusters" },
  { value: "discovery", label: "Discovery" },
  { value: "local", label: "Local" },
  { value: "maintenance", label: "Maintenance" },
];

/**
 * Full-screen knowledge-graph view — a sibling of ChatPage inside the
 * AppShell. Mounts its own FilePanel/SettingsPanel copies because the chat
 * page (which normally hosts them) is hidden while this view is active.
 */
export function GraphPage() {
  const mode = useGraphStore((s) => s.mode);
  const setMode = useGraphStore((s) => s.setMode);
  const metaState = useGraphStore((s) => s.metaState);
  const fetchMeta = useGraphStore((s) => s.fetchMeta);
  const fetchScene = useGraphStore((s) => s.fetchScene);
  const subgraph = useGraphStore((s) => s.subgraph);
  const dataState = useGraphStore((s) => s.dataState);
  const stale = useGraphStore((s) => s.meta?.stale ?? false);

  const filePanelOpen = useUIStore((s) => s.filePanelOpen);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const setSettingsPanelOpen = useUIStore((s) => s.setSettingsPanelOpen);

  useEffect(() => {
    let active = true;
    // Always refetch meta on mount (the view unmounts when hidden, so this
    // also covers "came back after a brain sync"): a changed computedAt is
    // what invalidates every cached scene. Meta must land before the scene
    // fetch so the cache is keyed by the fresh generation.
    void (async () => {
      await fetchMeta(true);
      if (!active) return;
      await fetchScene();
    })();
    return () => {
      active = false;
    };
  }, [fetchMeta, fetchScene]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Panels this view hosts itself (chat page is hidden while we're active) */}
      <FilePanel open={filePanelOpen} onClose={() => setFilePanelOpen(false)} />
      <SettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />

      {/* Header: mode tabs */}
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 md:px-4">
        <h1 className="hidden font-display text-base text-foreground md:block">
          Graph
        </h1>
        <nav
          aria-label="Graph modes"
          className="flex flex-1 justify-center gap-1 md:justify-start md:pl-4"
        >
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              aria-current={mode === m.value ? "page" : undefined}
              className={cn(
                "min-h-9 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                mode === m.value
                  ? "bg-surface-raised text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </nav>
        {subgraph?.truncated && (
          <span
            className="hidden shrink-0 items-center gap-1 rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[10px] text-muted-foreground md:flex"
            title="The server capped this scene; the lowest-ranked notes were dropped."
          >
            <TriangleAlert className="h-3 w-3" />
            truncated
          </span>
        )}
      </header>

      {/* Stale strip */}
      {stale && metaState === "done" && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-raised/50 px-4 py-1.5 text-[11px] text-muted-foreground">
          <TriangleAlert className="h-3 w-3 shrink-0 text-primary" />
          Graph predates the latest index run — run <Mono>brain sync</Mono> to
          refresh it.
        </div>
      )}

      {/* Body */}
      <div className="relative flex-1 overflow-hidden bg-background">
        <GraphBody modeState={{ mode, metaState, dataState }} />
      </div>
    </div>
  );
}

function GraphBody({
  modeState,
}: {
  modeState: { mode: GraphMode; metaState: string; dataState: string };
}) {
  const { mode, metaState, dataState } = modeState;
  const meta = useGraphStore((s) => s.meta);
  const error = useGraphStore((s) => s.error);
  const subgraph = useGraphStore((s) => s.subgraph);
  const local = useGraphStore((s) => s.local);
  const discovery = useGraphStore((s) => s.discovery);

  // 404 on meta: the whole server predates the graph API.
  if (metaState === "error" && error?.kind === "unsupported") {
    return (
      <GraphEmptyState icon="server" title="Server too old">
        This deployment does not serve the graph API yet — update brain-ui to a
        version with graph support.
      </GraphEmptyState>
    );
  }

  if (metaState === "loading" || metaState === "idle") {
    return <CenteredSpinner />;
  }

  // Local mode works against any indexed repo; everything else needs the
  // precomputed tables.
  const gated =
    mode !== "local" &&
    (meta?.available === false ||
      (dataState === "error" && error?.kind === "unavailable"));
  if (gated) {
    const reason = meta?.reason ?? error?.reason;
    return reason === "schema" ? (
      <GraphEmptyState icon="sync" title="Brain CLI too old">
        This repo was indexed by a CLI without graph support. Update{" "}
        <Mono>@schlessera/brain</Mono> and run <Mono>brain sync</Mono> — the
        Local mode works in the meantime.
      </GraphEmptyState>
    ) : (
      <GraphEmptyState icon="sync" title="Graph not built yet">
        Run <Mono>brain sync</Mono> (or <Mono>brain graph compute</Mono>) to
        build the graph from your notes.
      </GraphEmptyState>
    );
  }

  if (mode === "maintenance") {
    return <MaintenanceBody />;
  }

  if (mode === "local" && !local.center) {
    return (
      <>
        <GraphEmptyState title="Pick a note to explore">
          The local graph shows everything linked to one note. Choose a center
          in the options panel.
        </GraphEmptyState>
        <GraphControls />
      </>
    );
  }

  // Discovery with no root anywhere: the picker-first path (the default on
  // repos without an entry file).
  if (mode === "discovery" && !discovery.root && !meta?.defaultRoot) {
    return <DiscoveryStart />;
  }

  if (dataState === "error") {
    return (
      <GraphEmptyState icon="warn" title="Could not load the graph">
        {error?.message ?? "Request failed"}
      </GraphEmptyState>
    );
  }

  if (dataState === "loading" || !subgraph) {
    return <CenteredSpinner />;
  }

  if (subgraph.nodes.length === 0) {
    return (
      <>
        <GraphEmptyState title="Nothing to show">
          {mode === "local"
            ? "This note has no links in or out at this depth."
            : "No notes matched this scene."}
        </GraphEmptyState>
        <GraphControls />
      </>
    );
  }

  return <SceneBody />;
}
