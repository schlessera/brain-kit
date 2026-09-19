import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { EmptyState, ScreenHeader } from "@schlessera/brain-ui-kit";

import { useGraphStore, type GraphMode } from "../../stores/graph-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { FilePanel } from "../files/file-panel.js";
import { SettingsPanel } from "../settings/settings-panel.js";
import { GraphControls, LAPTOP_QUERY, WIDE_QUERY } from "./graph-controls.js";
import { GraphControlsColumn, MODES } from "./graph-controls-column.js";
import { GraphEmptyState, Mono } from "./graph-empty-state.js";
import { MaintenanceBody } from "./graph-maintenance.js";
import { GraphNodeRail } from "./graph-node-rail.js";
import { DiscoveryStart, SceneBody } from "./graph-scene.js";
import { CenteredSpinner } from "./graph-spinner.js";
import { cn } from "../../lib/utils.js";

/**
 * Full-screen knowledge-graph view — a sibling of ChatPage inside the
 * AppShell. Mounts its own FilePanel/SettingsPanel copies because the chat
 * page (which normally hosts them) is hidden while this view is active.
 *
 * D6 (the fifth drop): from `laptop:` a 264px controls column on the left
 * and the canvas under a kit `ScreenHeader nav`; from `wide:` a 340px right
 * rail with the selected node. Below `laptop:` the mode tabs stay in the
 * header, the options in the phone sheet, the selected node in the floating
 * popover. The pane widths key on the same ladder the rail uses, read as a
 * media query rather than a class so only one copy of the form is mounted.
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
  const laptop = useMediaQuery(LAPTOP_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);

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

      {/* Below laptop: the mode tabs in the header */}
      {!laptop && (
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
      )}

      {/* Stale strip */}
      {stale && metaState === "done" && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-raised/50 px-4 py-1.5 text-[11px] text-muted-foreground">
          <TriangleAlert className="h-3 w-3 shrink-0 text-primary" />
          Graph predates the latest index run — run <Mono>brain sync</Mono> to
          refresh it.
        </div>
      )}

      {/* Body: D6's panes from laptop, the canvas alone below */}
      <div className="flex min-h-0 flex-1">
        {laptop && <GraphControlsColumn />}
        <div className="flex min-w-0 flex-1 flex-col">
          {laptop && <SceneHeader />}
          <div className="relative flex-1 overflow-hidden bg-background">
            <GraphBody modeState={{ mode, metaState, dataState }} />
          </div>
          {laptop && <CanvasCaption />}
        </div>
        {wide && <GraphNodeRail />}
      </div>
    </div>
  );
}

const MODE_LABEL: Record<GraphMode, string> = {
  clusters: "Clusters",
  discovery: "Discovery",
  local: "Local",
  maintenance: "Maintenance",
};

/**
 * The kit `ScreenHeader nav` above the canvas: the focus node when the scene
 * has one (Local's centre, Discovery's root), else the mode; the subtitle is
 * the counts the store holds and stays empty until a scene has landed.
 */
function SceneHeader() {
  const mode = useGraphStore((s) => s.mode);
  const subgraph = useGraphStore((s) => s.subgraph);
  const findings = useGraphStore((s) => s.findings);
  const local = useGraphStore((s) => s.local);
  const discoveryRoot = useGraphStore((s) => s.discovery.root);
  const staleDays = useGraphStore((s) => s.maintenance.staleDays);

  const focus =
    subgraph && (mode === "local" || mode === "discovery")
      ? (subgraph.nodes.find((n) => n.distance === 0) ?? null)
      : null;
  const focusPath = mode === "local" ? local.center : mode === "discovery" ? discoveryRoot : null;
  const focusTitle = focus ? focus.title || focus.path : focusPath;
  const title = focusTitle ? `Around ${focusTitle}` : MODE_LABEL[mode];

  let subtitle: string | undefined;
  if (mode === "maintenance") {
    if (findings) {
      const count =
        findings.orphans.length +
        findings.unreachable.length +
        findings.brokenLinks.length +
        findings.stale.length;
      subtitle = `${count.toLocaleString()} findings · stale after ${staleDays} days`;
    }
  } else if (subgraph) {
    const parts: string[] = [];
    if (focus) parts.push(focus.virtual ? "root" : focus.type);
    parts.push(`${subgraph.nodes.length.toLocaleString()} nodes`);
    parts.push(`${subgraph.edges.length.toLocaleString()} edges`);
    if (mode === "local") parts.push(`${local.depth} hop${local.depth === 1 ? "" : "s"}`);
    if (subgraph.truncated) parts.push("truncated");
    subtitle = parts.join(" · ");
  }

  return (
    <ScreenHeader
      variant="nav"
      title={title}
      subtitle={subtitle}
      subTone={subgraph?.truncated ? "red" : "neutral"}
      back={false}
    />
  );
}

/**
 * The mono line under the canvas. The colour rule is read from what the
 * canvas draws today — topic clusters, or distance/folder in Discovery — so
 * the caption never claims a rule the scene does not follow.
 */
function CanvasCaption() {
  const mode = useGraphStore((s) => s.mode);
  const colorBy = useGraphStore((s) => s.discoveryColorBy);
  const hasTopics = useGraphStore((s) => (s.meta?.communities.length ?? 0) > 0);
  if (mode === "maintenance") return null;
  const rule =
    mode === "discovery" ? colorBy : hasTopics ? "topic" : "uniform";
  return (
    <p className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground">
      canvas is app-drawn · colour = {rule} · click a node to load its card
    </p>
  );
}

/**
 * An orphan note in Local mode: the centre has no edges in either direction
 * at this depth. "Emptiness is a finding" — the kit `EmptyState no-results`
 * with the design's copy and the store's own count, no reassurance.
 */
function OrphanEmptyState() {
  const setActiveView = useUIStore((s) => s.setActiveView);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[520px]">
        <EmptyState
          variant="no-results"
          title="Nothing links to this yet"
          body="This note has no edges in either direction. Ask a question that mentions it and the graph fills in as the answer cites things."
          meta="0 edges"
          primaryLabel="Ask about it"
          primaryIcon="ask"
          primaryTone="primary"
          pad={22}
          minHeight={0}
          onPrimary={() => setActiveView("chat")}
        />
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

  // Local's centre with nothing around it is the orphan case, whether the
  // server returned the lone centre or nothing at all.
  if (mode === "local" && subgraph.edges.length === 0) {
    return (
      <>
        <OrphanEmptyState />
        <GraphControls />
      </>
    );
  }

  if (subgraph.nodes.length === 0) {
    return (
      <>
        <GraphEmptyState title="Nothing to show">
          No notes matched this scene.
        </GraphEmptyState>
        <GraphControls />
      </>
    );
  }

  return <SceneBody />;
}
