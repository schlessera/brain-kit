import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { List, Loader2, TriangleAlert, X } from "lucide-react";
import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { useGraphStore, type GraphMode } from "../../stores/graph-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFileStore } from "../../stores/file-store.js";
import { FilePanel } from "../files/file-panel.js";
import { SettingsPanel } from "../settings/settings-panel.js";
import { GraphControls } from "./graph-controls.js";
import { NodePopover } from "./node-popover.js";
import { GraphEmptyState, Mono } from "./graph-empty-state.js";
import {
  communityColor,
  distanceColor,
  matchScene,
} from "./lib/graph-helpers.js";
import { useGraphTheme } from "./use-graph-theme.js";
import { cn } from "../../lib/utils.js";

// The one code-split boundary: sigma + graphology load only when a scene renders.
const GraphCanvas = lazy(() => import("./graph-canvas.js"));

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
    void fetchMeta();
    void fetchScene();
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
        <GraphBody
          modeState={{ mode, metaState, dataState }}
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

/** The canvas plus everything overlaid on it. Only mounts with data present. */
function SceneBody() {
  const mode = useGraphStore((s) => s.mode);
  const meta = useGraphStore((s) => s.meta);
  const subgraph = useGraphStore((s) => s.subgraph)!;
  const selectedId = useGraphStore((s) => s.selectedId);
  const hoveredId = useGraphStore((s) => s.hoveredId);
  const select = useGraphStore((s) => s.select);
  const hover = useGraphStore((s) => s.hover);
  const sceneQuery = useGraphStore((s) => s.sceneQuery);
  const discovery = useGraphStore((s) => s.discovery);
  const theme = useGraphTheme();
  const [listOpen, setListOpen] = useState(false);

  const matchIds = useMemo(
    () => matchScene(subgraph.nodes, sceneQuery),
    [subgraph.nodes, sceneQuery]
  );

  const layout =
    mode === "clusters"
      ? subgraph.nodes.some((n) => n.x !== undefined)
        ? ("fixed" as const)
        : ("force" as const)
      : mode === "discovery"
        ? ("radial" as const)
        : ("force" as const);

  const maxDistance = useMemo(
    () =>
      mode === "discovery"
        ? Math.max(1, ...subgraph.nodes.map((n) => n.distance ?? 0))
        : discovery.maxDepth,
    [mode, subgraph.nodes, discovery.maxDepth]
  );

  const nodeColor = useMemo(() => {
    if (mode === "discovery") {
      return (node: GraphNodePayload) =>
        node.virtual
          ? theme.nodeSelected
          : distanceColor(node.distance ?? maxDistance, maxDistance);
    }
    return (node: GraphNodePayload) =>
      node.community !== undefined ? communityColor(node.community) : theme.node;
  }, [mode, maxDistance, theme]);

  const centerId = useMemo(
    () =>
      mode === "local"
        ? (subgraph.nodes.find((n) => n.distance === 0)?.id ?? null)
        : null,
    [mode, subgraph.nodes]
  );

  const edgeColor = useMemo(() => {
    if (mode !== "local" || centerId === null) return undefined;
    // Backlinks into the center get the accent so in/out reads at a glance.
    return (edge: { source: number; target: number }) =>
      edge.target === centerId ? theme.edgeHighlight : undefined;
  }, [mode, centerId, theme]);

  const selectedNode = useMemo(
    () =>
      selectedId === null
        ? null
        : (subgraph.nodes.find((n) => n.id === selectedId) ?? null),
    [selectedId, subgraph.nodes]
  );

  const communityLabel =
    selectedNode?.community !== undefined
      ? (meta?.communities.find((c) => c.community === selectedNode.community)
          ?.label ?? null)
      : null;

  return (
    <>
      <Suspense fallback={<CenteredSpinner />}>
        <GraphCanvas
          data={subgraph}
          layout={layout}
          selectedId={selectedId}
          hoveredId={hoveredId}
          matchIds={matchIds}
          nodeColor={nodeColor}
          edgeColor={edgeColor}
          onSelect={select}
          onHover={hover}
        />
      </Suspense>

      <GraphControls />

      {/* Accessible / mobile-friendly node list — the canvas itself is aria-hidden */}
      <button
        onClick={() => setListOpen((v) => !v)}
        className="absolute bottom-3 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-overlay text-foreground shadow-lg"
        title="Node list"
        aria-expanded={listOpen}
      >
        <List className="h-4.5 w-4.5" />
      </button>
      {listOpen && <NodeList onClose={() => setListOpen(false)} />}

      {selectedNode && (
        <NodePopover node={selectedNode} communityLabel={communityLabel} />
      )}
    </>
  );
}

/** Focusable listing of the current scene, sorted by connectedness. */
function NodeList({ onClose }: { onClose: () => void }) {
  const subgraph = useGraphStore((s) => s.subgraph)!;
  const select = useGraphStore((s) => s.select);
  const selectedId = useGraphStore((s) => s.selectedId);

  const sorted = useMemo(
    () =>
      [...subgraph.nodes].sort(
        (a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree)
      ),
    [subgraph.nodes]
  );

  return (
    <nav
      aria-label="Graph nodes"
      className="absolute bottom-16 right-3 z-10 flex max-h-[55dvh] w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface-overlay/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground">
          {sorted.length} note{sorted.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Close list"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.map((node) => (
          <button
            key={node.id}
            onClick={() => select(node.id)}
            className={cn(
              "flex min-h-11 w-full flex-col justify-center px-3 py-1.5 text-left transition-colors",
              node.id === selectedId
                ? "bg-surface-raised"
                : "hover:bg-surface-raised/60"
            )}
          >
            <span className="truncate text-xs text-foreground">
              {node.title || node.path}
            </span>
            <span className="truncate font-mono text-[10px] text-muted-foreground/60">
              {node.inDegree + node.outDegree} link
              {node.inDegree + node.outDegree === 1 ? "" : "s"} · {node.path}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/** Maintenance: findings as a scrollable report (the graph link-up lands in a later phase). */
function MaintenanceBody() {
  const findings = useGraphStore((s) => s.findings);
  const dataState = useGraphStore((s) => s.dataState);
  const error = useGraphStore((s) => s.error);
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);

  if (dataState === "error") {
    return (
      <GraphEmptyState icon="warn" title="Could not load findings">
        {error?.message ?? "Request failed"}
      </GraphEmptyState>
    );
  }
  if (dataState !== "done" || !findings) return <CenteredSpinner />;

  function openNote(path: string) {
    setFilePanelOpen(true);
    void openFile(path);
  }

  const sections: {
    title: string;
    hint: string;
    items: { key: string; title: string; sub: string; path?: string }[];
  }[] = [
    {
      title: `Orphans (${findings.orphans.length})`,
      hint: "No links in or out.",
      items: findings.orphans.map((n) => ({
        key: `o${n.id}`,
        title: n.title || n.path,
        sub: n.path,
        path: n.path,
      })),
    },
    {
      title: `Unreachable from root (${findings.unreachable.length})`,
      hint: "No link path from the graph root reaches these.",
      items: findings.unreachable.map((n) => ({
        key: `u${n.id}`,
        title: n.title || n.path,
        sub: n.path,
        path: n.path,
      })),
    },
    {
      title: `Broken links (${findings.brokenLinks.length})`,
      hint: "Wiki links whose target resolves to nothing.",
      items: findings.brokenLinks.map((b, i) => ({
        key: `b${i}`,
        title: `[[${b.target}]]`,
        sub: `in ${b.sourcePath}`,
        path: b.sourcePath,
      })),
    },
    {
      title: `Stale notes (${findings.stale.length})`,
      hint: `Untouched for over ${findings.staleDays} days.`,
      items: findings.stale.map((n) => ({
        key: `s${n.id}`,
        title: n.title || n.path,
        sub: `${n.updated} · ${n.path}`,
        path: n.path,
      })),
    },
  ];

  return (
    <>
      <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 pb-16">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-sm font-medium text-foreground">
                {section.title}
              </h2>
              <p className="mb-2 text-[11px] text-muted-foreground">
                {section.hint}
              </p>
              {section.items.length === 0 ? (
                <p className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-muted-foreground">
                  Nothing found — clean.
                </p>
              ) : (
                <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border bg-surface">
                  {section.items.map((item) => (
                    <button
                      key={item.key}
                      onClick={() => item.path && openNote(item.path)}
                      className="flex min-h-11 w-full flex-col justify-center px-3 py-2 text-left transition-colors hover:bg-surface-raised/60"
                    >
                      <span className="truncate text-xs text-foreground">
                        {item.title}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground/60">
                        {item.sub}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
      <GraphControls />
    </>
  );
}

function CenteredSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}
